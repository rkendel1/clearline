// Scenario D — Bad data: malformed rows and business-rule violations are
// quarantined with actionable reasons, quality metrics are exact, invalid data
// never reaches trusted (or even untrusted) metrics, and sensitive values never
// reach logs or retained raw payloads.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, centsOf, fromCents, type NwClaim } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

test('Scenario D: invalid records are quarantined with actionable errors and excluded from metrics', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const members = nwMembers(80, 401);
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  await ctx.worker.drain();

  const good = nwClaims(190, members.map((m) => m.MBR_ID), 402);
  const base = (i: number): NwClaim => ({ ...nwClaims(1, members.map((m) => m.MBR_ID), 500 + i, 10_000 + i)[0], CLM_STATUS: 'P' });
  // Each defect is a separate row with a known expected rule and category.
  const defects: { row: NwClaim & { FREE_TEXT?: string }; rule: string; category: string }[] = [
    { row: { ...base(1), SVC_DT: '2026-02-30' }, rule: 'type:service_date', category: 'structural' },
    { row: { ...base(2), PAID_AMT: 'twelve' }, rule: 'type:paid_amount', category: 'structural' },
    { row: { ...base(3), CLM_STATUS: 'Z' }, rule: 'type:status', category: 'structural' },
    { row: { ...base(4), DX_CD: '' }, rule: 'not_null:diagnosis_code', category: 'structural' },
    { row: { ...base(5), RENDERING_NPI: '12345' }, rule: 'constraint:provider_npi', category: 'structural' },
    { row: { ...base(6), PAID_AMT: '999999.00', BILLED_AMT: '100.00', ALLOWED_AMT: '90.00' }, rule: 'rule:paid_le_billed', category: 'business_rule' },
    { row: { ...base(7), CLM_STATUS: 'D', PAID_AMT: '50.00' }, rule: 'rule:denied_zero_paid', category: 'business_rule' },
    { row: { ...base(8), SVC_DT: '2030-01-15', RCVD_DT: '2030-01-20' }, rule: 'rule:service_not_future', category: 'business_rule' },
    { row: { ...base(9), RCVD_DT: '2026-01-01', SVC_DT: '2026-03-01' }, rule: 'rule:received_after_service', category: 'business_rule' },
  ];
  const ssnRow = { ...base(10), FREE_TEXT: 'member called, SSN 912-34-5678' };
  const cols = [...NW_CLAIM_COLUMNS, 'FREE_TEXT'];
  const orphan = { ...base(11), MBR_ID: 'NW9999999' };            // unknown member: warning only (late eligibility is normal)
  const rows = [...good.map((g) => ({ ...g, FREE_TEXT: '' })), ...defects.map((d) => ({ ...d.row, FREE_TEXT: '' })), ssnRow, { ...orphan, FREE_TEXT: '' }];
  let csv = toCsv(rows as never, cols).toString();
  csv += 'C999999999,NW0000001,1234567890,2026-05-01\n';              // malformed: 4 of 13 columns

  // Capture everything the process writes while the batch is submitted and processed.
  const captured: string[] = [];
  const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => { captured.push(String(c)); return true; }) as never;
  process.stderr.write = ((c: string) => { captured.push(String(c)); return true; }) as never;
  const prevLevel = process.env.LOG_LEVEL;
  let sub;
  try {
    const { resetConfigForTests } = await import('../../src/platform/config.js');
    process.env.LOG_LEVEL = 'debug'; resetConfigForTests();
    sub = await op.csv('northwind', 'nw_medical_claims_csv', Buffer.from(csv));
    await ctx.worker.drain();
    process.env.LOG_LEVEL = prevLevel; resetConfigForTests();
  } finally { process.stdout.write = ow; process.stderr.write = ew; }
  const logText = captured.join('');
  assert.ok(logText.includes('batch processed'), 'logs were captured');
  assert.ok(!logText.includes('912-34-5678'), 'SSN never written to logs');
  for (const m of members.slice(0, 20)) assert.ok(!logText.includes(m.SSN), 'member SSNs never logged');

  const total = rows.length + 1;
  const expectedQuarantine = defects.length + 2; // + SSN row + malformed row
  const b = (await op.get(`/api/v1/tenants/northwind/batches/${sub!.body.batch_id}`)).body;
  assert.equal(b.status, 'completed_with_exceptions', 'pipeline ran');
  assert.deepEqual([b.received_count, b.accepted_count, b.quarantined_count], [total, total - expectedQuarantine, expectedQuarantine]);
  assert.equal(b.structural_error_count, 6);      // 5 typed defects + malformed row
  assert.equal(b.business_error_count, 5);        // 4 rule violations + privacy
  assert.equal(b.warning_count, 1);               // orphaned member reference
  assert.equal(b.quality_status, 'failed', `${expectedQuarantine}/${total} > 5% threshold`);
  assert.equal(b.trust_status, 'untrusted');
  assert.match(b.trust_reasons[0], /reject rate .* exceeds threshold 5\.00%/);
  assert.equal(b.reconciliation_status, 'passed', 'every row accounted for; reconciliation is not the failure here');

  // Actionable, precise, per-rule quality results.
  const q = Object.fromEntries(b.quality_results.map((r: { rule_id: string }) => [r.rule_id, r]));
  for (const d of defects) assert.equal(q[d.rule].failed_count, 1, d.rule);
  assert.equal(q['parse:row_shape'].failed_count, 1);
  assert.equal(q['privacy:unmapped_sensitive'].failed_count, 1);
  assert.equal(q['relationship:claim_member'].failed_count, 1);
  assert.equal(q['relationship:claim_member'].severity, 'warning');
  assert.equal(q['structural:all'].failed_count, 6);
  assert.equal(q['rule:paid_le_billed'].evaluated_count, total - 6, 'business rules evaluated on structurally valid rows only');
  assert.ok(b.quality_results.every((r: { contract_version: string; attempt: number }) => r.contract_version === '1.0.0' && r.attempt === 1));

  const quarantine = (await op.get(`/api/v1/tenants/northwind/quarantine?batch_id=${sub!.body.batch_id}`)).body;
  assert.equal(quarantine.length, expectedQuarantine);
  const byRow = Object.fromEntries(quarantine.map((x: { source_row: number }) => [x.source_row, x]));
  defects.forEach((d, i) => {
    const item = byRow[good.length + i + 1];
    assert.equal(item.category, d.category, d.rule);
    assert.equal(item.reasons[0].rule_id, d.rule);
  });
  assert.match(byRow[good.length + 1].reasons[0].message, /service_date: not a valid calendar date \(YYYY-MM-DD\)/);
  assert.match(byRow[good.length + 2].reasons[0].message, /paid_amount: not a decimal number/);
  assert.match(byRow[good.length + 3].reasons[0].message, /status: value "Z" has no mapping/);
  assert.match(byRow[total].reasons[0].message, /expected 13 columns, found 4/);
  assert.match(byRow[good.length + defects.length + 1].reasons[0].message, /unmapped source column "FREE_TEXT" appears to contain sensitive data \(ssn\)/);
  assert.ok(!JSON.stringify(quarantine).includes('912-34-5678'));
  // PHI values are never echoed in reasons even when invalid.
  assert.ok(quarantine.every((x: { reasons: { message: string }[] }) => x.reasons.every((r) => !/diagnosis_code: .*got "/.test(r.message))));

  // The detected SSN was scrubbed from retained raw payloads.
  const raw = await sql(`SELECT payload->>'FREE_TEXT' AS v FROM core.raw_records WHERE batch_id = $1 AND row_number = $2`, [sub!.body.batch_id, good.length + defects.length + 1]);
  assert.match(raw[0].v, /^\[scrubbed/);

  // Invalid rows never reach canonical data or any metric.
  const validRows = [...good, orphan];
  const truthPaid = validRows.filter((c) => c.CLM_STATUS === 'P').reduce((s, c) => s + centsOf(c.PAID_AMT), 0);
  const biz = Object.fromEntries((await rep.get('/api/v1/tenants/northwind/reports/business')).body.metrics.map((m: { id: string }) => [m.id, m]));
  assert.equal(biz.total_paid.value, '0.00', 'untrusted batch excluded from trusted metrics');
  assert.equal(biz.total_paid.value_including_untrusted, fromCents(truthPaid), 'even the untrusted view contains only valid rows');
  assert.equal(biz.claims_total.value_including_untrusted, String(validRows.length));
  assert.equal(biz.total_paid.trusted, false);

  const ops = (await op.get('/api/v1/tenants/northwind/reports/operations')).body;
  const cats = Object.fromEntries(ops.quality_by_category.map((c: { category: string; records: number }) => [c.category, c.records]));
  assert.deepEqual(cats, { business_rule: 4, privacy: 1, referential: 1, structural: 6 });

  evidence('Scenario D — Bad data', [
    `Batch of ${total} rows with ${defects.length} single-defect rows, 1 SSN in an unmapped column, 1 malformed row, 1 orphaned member reference.`,
    `Result: pipeline=${b.status}, quality=${b.quality_status}, trust=${b.trust_status} (${b.trust_reasons.join('; ')}), reconciliation=${b.reconciliation_status}.`,
    `accepted=${b.accepted_count}, quarantined=${b.quarantined_count} (structural ${b.structural_error_count}, business/privacy ${b.business_error_count}), warnings=${b.warning_count}.`,
    `Every defect attributed to its exact rule with source row number, e.g. row ${good.length + 1}: "${byRow[good.length + 1].reasons[0].message}".`,
    `SSN absent from ${captured.length} captured log lines and scrubbed from the retained raw payload.`,
    `total_paid trusted=${biz.total_paid.value}; including untrusted=${biz.total_paid.value_including_untrusted} = sum of valid rows only (${fromCents(truthPaid)}).`,
  ]);
});
