// Scenario H — Contract evolution: introduce a breaking contract change, show
// the migration plan, reject unsafe automatic application, and execute the
// approved migration. Also proves the documented rollback path and its limit.
//
// v1 -> v2 (northwind) is breaking in three ways:
//   * claim.line_of_business added as non-nullable (declared backfill COMMERCIAL)
//   * claim.status enum value PENDED replaced by PENDING (declared value map)
//   * claim.procedure_code removed
// v2-unsafe additionally changes paid_amount decimal -> integer and drops the
// value map; it must be rejected outright.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, loadContract, ROOT, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, centsOf, fromCents } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

const NW = '/api/v1/tenants/northwind';

async function columns(table: string): Promise<string[]> {
  return (await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 't_northwind' AND table_name = $1`, [table])).map((r) => r.column_name);
}

test('Scenario H: breaking change is planned, unsafe change rejected, approved migration applied and rolled back safely', async () => {
  const admin = client(ctx, DEV_TOKENS.northwind.admin);
  const approver = client(ctx, DEV_TOKENS.northwind.approver);
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);

  // --- Baseline data under v1.
  const members = nwMembers(80, 801);
  const claims = nwClaims(300, members.map((m) => m.MBR_ID), 802);
  const pended = claims.filter((c) => c.CLM_STATUS === 'H').length;
  assert.ok(pended > 10, 'generator produced pended claims to remap');
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  const c1 = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(claims as never, NW_CLAIM_COLUMNS), { control: { record_count: 300 } });
  await ctx.worker.drain();
  const before = Object.fromEntries((await rep.get(`${NW}/reports/business`)).body.metrics.map((m: { id: string; value: string }) => [m.id, m.value]));
  assert.equal(before.claims_total, '300');

  const v2 = loadContract('northwind', 'v2.json');
  const unsafe = loadContract('northwind', 'v2-unsafe.json');

  // --- 1. Unsafe change: dry run shows why, publish is refused, nothing changes.
  const dry = (await admin.post(`${NW}/contracts/validate`, unsafe)).body;
  assert.equal(dry.valid, true, 'document is well-formed; the problem is the migration');
  assert.equal(dry.plan.classification, 'rejected');
  assert.ok(dry.plan.rejected_reasons.some((r: string) => /paid_amount: decimal -> integer/.test(r)), JSON.stringify(dry.plan.rejected_reasons));
  assert.ok(dry.plan.rejected_reasons.some((r: string) => /values removed \[PENDED\] without a mapping/.test(r)));
  const pubUnsafe = await admin.post(`${NW}/contracts`, unsafe);
  assert.equal(pubUnsafe.status, 422);
  assert.equal(pubUnsafe.body.lifecycle, 'rejected');
  assert.equal(pubUnsafe.body.contract_version_id, null);
  assert.equal((await admin.get(`${NW}/contracts/active`)).body.version, '1.0.0');
  assert.equal((await admin.get(`${NW}/contracts`)).body.length, 1, 'rejected version is not stored');

  // A contract that tries to smuggle in unsupported declarations fails validation itself.
  const bogus = structuredClone(v2);
  bogus.version = '9.0.0';
  bogus.sources.nw_medical_claims_csv.mappings[0].transforms = [{ op: 'javascript', code: 'process.exit(1)' }];
  const bogusRes = await admin.post(`${NW}/contracts`, bogus);
  assert.equal(bogusRes.status, 422);
  assert.equal(bogusRes.body.error.code, 'invalid_contract');

  // --- 2. Breaking change: stored as pending with a reviewable plan; nothing applied.
  const pub = await admin.post(`${NW}/contracts`, v2);
  assert.equal(pub.status, 202, JSON.stringify(pub.body));
  assert.equal(pub.body.lifecycle, 'pending_approval');
  const plan = pub.body.plan;
  writeFileSync(path.join(ROOT, 'test-results/scenario-h-migration-plan.json'), JSON.stringify(plan, null, 2));
  assert.equal(plan.classification, 'requires_approval');
  const kinds = plan.changes.filter((c: { classification: string }) => c.classification === 'breaking').map((c: { kind: string; field?: string }) => `${c.kind}:${c.field}`);
  assert.deepEqual(kinds.sort(), ['enum_values_remapped:status', 'field_added_required:line_of_business', 'field_removed:procedure_code']);
  assert.ok(plan.ddl.some((d: string) => /ADD COLUMN IF NOT EXISTS "line_of_business" text/.test(d)));
  assert.ok(plan.ddl.every((d: string) => !/DROP|DELETE|TRUNCATE/i.test(d)), 'no destructive DDL is ever generated');
  assert.deepEqual([...plan.data_ops].sort((a: { type: string }, b: { type: string }) => a.type.localeCompare(b.type)), [
    { type: 'backfill', entity: 'claim', field: 'line_of_business', backfill_value: 'COMMERCIAL' },
    { type: 'value_map', entity: 'claim', field: 'status', value_map: { PENDED: 'PENDING' } },
  ]);
  assert.equal(plan.impact.claim.current_rows, 300);
  assert.equal(plan.impact.claim.affected_rows, 300, 'distinct rows: every claim gets the backfill; PENDED ones are not counted twice');
  assert.ok(plan.view_ddl.some((d: string) => /CREATE VIEW "t_northwind"."rpt_trusted_claim"/.test(d)), 'view statements are part of the reviewable plan');
  assert.ok(plan.rollback.length >= 2);
  assert.equal((await admin.get(`${NW}/contracts/active`)).body.version, '1.0.0', 'v1 stays active while pending');
  assert.ok(!(await columns('claim')).includes('line_of_business'), 'no DDL applied before approval');
  const migId = pub.body.migration_id;

  // Batches keep flowing under v1 while approval is pending.
  const during = nwClaims(5, members.map((m) => m.MBR_ID), 803, 5001);
  await op.csv('northwind', 'nw_medical_claims_csv', toCsv(during as never, NW_CLAIM_COLUMNS));
  await ctx.worker.drain();
  const duringBatch = (await op.get(`${NW}/batches?source=nw_medical_claims_csv&limit=1`)).body[0];
  assert.equal(duringBatch.contract_version, '1.0.0');
  assert.equal(duringBatch.trust_status, 'trusted');

  // Another publish is blocked until this one is decided.
  const blocked = await admin.post(`${NW}/contracts`, { ...v2, version: '3.0.0' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'migration_pending');

  // --- 3. Approval controls.
  assert.equal((await op.post(`${NW}/migrations/${migId}/approve`, { confirm_version: '2.0.0' })).status, 403, 'operators cannot approve');
  const self = await admin.post(`${NW}/migrations/${migId}/approve`, { confirm_version: '2.0.0' });
  assert.equal(self.status, 403, 'tenant admins (including the requester) cannot approve: approval is a separate role');
  assert.equal(self.body.error.code, 'forbidden');
  // ...and a tenant admin cannot mint an approver for themselves.
  const mint = await admin.post(`${NW}/tokens`, { name: 'my-own-approver', role: 'approver' });
  assert.equal(mint.status, 403);
  assert.equal(mint.body.error.code, 'approver_issued_by_platform_only');
  const wrong = await approver.post(`${NW}/migrations/${migId}/approve`, { confirm_version: '1.9.9' });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.code, 'confirmation_mismatch');
  assert.equal((await admin.get(`${NW}/contracts/active`)).body.version, '1.0.0');

  // --- 4. Approved migration executes.
  const ok = await approver.post(`${NW}/migrations/${migId}/approve`, { confirm_version: '2.0.0' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'applied');
  assert.equal(ok.body.approved_by, 'northwind-approver');
  assert.equal((await approver.get(`${NW}/reports/business`)).status, 403, 'approvers see no tenant data');
  assert.equal((await admin.get(`${NW}/contracts/active`)).body.version, '2.0.0');
  const lifecycles = (await admin.get(`${NW}/contracts`)).body.map((c: { version: string; lifecycle: string }) => `${c.version}:${c.lifecycle}`);
  assert.deepEqual(lifecycles, ['1.0.0:superseded', '2.0.0:active']);

  const total = 305;
  const cur = await sql(`SELECT count(*)::int AS n, count(*) FILTER (WHERE line_of_business = 'COMMERCIAL')::int AS lob,
      count(*) FILTER (WHERE status = 'PENDED')::int AS pended, count(*) FILTER (WHERE "_migration_id" = $1)::int AS by_mig FROM t_northwind.claim WHERE "_is_current"`, [migId]);
  assert.deepEqual(cur[0], { n: total, lob: total, pended: 0, by_mig: total });
  // Existing records did not silently change meaning: v1 versions are intact and still say what they said.
  const hist = await sql(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'PENDED')::int AS pended, count(*) FILTER (WHERE line_of_business IS NULL)::int AS no_lob,
      count(DISTINCT "_contract_version_id")::int AS cvs FROM t_northwind.claim WHERE NOT "_is_current"`);
  assert.equal(hist[0].n, total);
  assert.equal(hist[0].no_lob, total);
  assert.ok(hist[0].pended >= pended);
  assert.equal(hist[0].cvs, 1);
  const sample = claims.find((c) => c.CLM_STATUS === 'H')!;
  const lin = (await admin.get(`${NW}/lineage/claim/${sample.CLM_ID}`)).body;
  assert.equal(lin.versions.length, 2);
  assert.deepEqual(lin.versions.map((v: { contract_version: string; values: { status: string } }) => `${v.contract_version}:${v.values.status}`), ['1.0.0:PENDED', '2.0.0:PENDING']);
  assert.equal(lin.versions[1].transform_version, `migration#${migId}`);

  // Metrics keep their values (no business change), the new metric is defined, and reconciliation still passes.
  const after1 = Object.fromEntries((await rep.get(`${NW}/reports/business`)).body.metrics.map((m: { id: string; value: string }) => [m.id, m.value]));
  assert.equal(after1.claims_total, String(total));
  assert.equal(after1.medicare_claims, '0');
  const paidTruth = [...claims, ...during].filter((c) => c.CLM_STATUS === 'P').reduce((s, c) => s + centsOf(c.PAID_AMT), 0);
  assert.equal(after1.total_paid, fromCents(paidTruth));
  const recon = (await op.post(`${NW}/reconciliation/run`)).body;
  assert.deepEqual(recon.batch_reverification_failures, [], 'migration rows are not mistaken for drift');
  assert.ok(recon.dataset.every((r: { status: string }) => r.status === 'passed'));

  // --- 5. Rollback (allowed only before any batch uses the new version).
  const rb = await approver.post(`${NW}/migrations/${migId}/rollback`);
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.equal(rb.body.active_version, '1.0.0');
  assert.equal(rb.body.restored_versions.claim, total);
  const restored = await sql(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'PENDED')::int AS pended, count(*) FILTER (WHERE "_migration_id" IS NOT NULL)::int AS mig FROM t_northwind.claim WHERE "_is_current"`);
  assert.deepEqual(restored[0], { n: total, pended: pended + during.filter((c) => c.CLM_STATUS === 'H').length, mig: 0 });
  assert.equal((await sql(`SELECT count(*)::int AS n FROM t_northwind.claim`))[0].n, total, 'migration-created versions removed');

  // --- 6. Roll forward as 2.0.1, approve, ingest v2-shaped data, and rollback is then refused.
  const v201 = { ...structuredClone(v2), version: '2.0.1' };
  const pub2 = await admin.post(`${NW}/contracts`, v201);
  assert.equal(pub2.status, 202);
  assert.equal((await approver.post(`${NW}/migrations/${pub2.body.migration_id}/approve`, { confirm_version: '2.0.1' })).status, 200);
  const lobs = ['C', 'M', 'D', 'M'];
  const v2Claims = nwClaims(40, members.map((m) => m.MBR_ID), 804, 9001).map((c, i) => {
    const { PROC_CD: _drop, ...rest } = c;
    return { ...rest, LOB: lobs[i % 4] };
  });
  const v2Cols = [...NW_CLAIM_COLUMNS.filter((c) => c !== 'PROC_CD'), 'LOB'];
  const v2Sub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(v2Claims as never, v2Cols), { control: { record_count: 40 } });
  // A v1-shaped file (no LOB column) is now structurally rejected: the field is required.
  const oldShape = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(nwClaims(3, members.map((m) => m.MBR_ID), 805, 9901) as never, NW_CLAIM_COLUMNS));
  assert.equal(oldShape.status, 422);
  assert.equal(oldShape.body.structural_rejection.reason, 'missing_required_columns');
  await ctx.worker.drain();
  const v2Batch = (await op.get(`${NW}/batches/${v2Sub.body.batch_id}`)).body;
  assert.equal(v2Batch.contract_version, '2.0.1');
  assert.equal(v2Batch.trust_status, 'trusted');
  assert.equal(v2Batch.accepted_count, 40);
  const after2 = Object.fromEntries((await rep.get(`${NW}/reports/business`)).body.metrics.map((m: { id: string; value: string }) => [m.id, m.value]));
  assert.equal(after2.medicare_claims, String(v2Claims.filter((c) => c.LOB === 'M').length));
  const rb2 = await approver.post(`${NW}/migrations/${pub2.body.migration_id}/rollback`);
  assert.equal(rb2.status, 409);
  assert.equal(rb2.body.error.code, 'rollback_window_closed');

  // --- Audit trail for the whole lifecycle.
  const audit = (await admin.get(`${NW}/audit?action=contract`)).body.map((a: { action: string; outcome: string }) => `${a.action}:${a.outcome}`);
  for (const e of ['contract.publish:failed', 'contract.publish:succeeded', 'contract.migration.approve:allowed', 'contract.migration.apply:succeeded', 'contract.migration.rollback:succeeded']) {
    assert.ok(audit.includes(e), `audit has ${e}`);
  }
  const denied = (await admin.get(`${NW}/audit?action=authz.contract:approve`)).body;
  assert.ok(denied.some((a: { actor: string; outcome: string }) => a.actor === 'northwind-admin' && a.outcome === 'denied'), 'the requester\'s approval attempt is audited as denied');

  // --- 7. Compatible widenings apply for real (views depend on these columns), and a queued batch follows.
  const queued = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(nwClaims(10, members.map((m) => m.MBR_ID), 806, 9501).map((c) => { const { PROC_CD: _x, ...r } = c; return { ...r, LOB: 'C' }; }) as never, v2Cols));
  const v210 = structuredClone(v201); v210.version = '2.1.0';
  v210.entities.claim.fields.paid_amount.precision = 14;
  v210.entities.pharmacy_fill.fields.days_supply = { ...v210.entities.pharmacy_fill.fields.days_supply, type: 'decimal', precision: 6, scale: 1 };
  v210.sources.nw_pharmacy_api.mappings.find((m: { target: string }) => m.target === 'days_supply').transforms = [{ op: 'parse_decimal' }];
  const widen = await admin.post(`${NW}/contracts`, v210);
  assert.equal(widen.status, 201, JSON.stringify(widen.body.plan?.rejected_reasons ?? widen.body));
  const types = Object.fromEntries((await sql(`SELECT column_name, data_type, numeric_precision FROM information_schema.columns WHERE table_schema = 't_northwind' AND column_name IN ('paid_amount','days_supply')`)).map((r) => [r.column_name, `${r.data_type}(${r.numeric_precision})`]));
  assert.deepEqual(types, { paid_amount: 'numeric(14)', days_supply: 'numeric(6)' });
  await ctx.worker.drain();
  const qb = (await op.get(`${NW}/batches/${queued.body.batch_id}`)).body;
  assert.equal(qb.contract_version, '2.1.0', 'batch queued under 2.0.1 was re-pinned: only compatible changes since');
  assert.equal(qb.trust_status, 'trusted');
  assert.equal((await admin.get(`${NW}/audit?action=batch.repinned`)).body.length, 1);

  // --- 8. A batch queued before a BREAKING migration is not processed under the superseded contract.
  const queued2 = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(nwClaims(10, members.map((m) => m.MBR_ID), 807, 9601).map((c) => { const { PROC_CD: _x, ...r } = c; return { ...r, LOB: 'M' }; }) as never, v2Cols));
  const v300 = structuredClone(v210); v300.version = '3.0.0';
  v300.entities.claim.rules.push({ id: 'billed_positive', description: 'Billed amount must be positive', severity: 'error', assert: { field: 'billed_amount', op: 'gt', value: 0 } });
  const p300 = await admin.post(`${NW}/contracts`, v300);
  assert.equal(p300.status, 202, 'adding an error rule is breaking');
  assert.equal((await approver.post(`${NW}/migrations/${p300.body.migration_id}/approve`, { confirm_version: '3.0.0' })).status, 200);
  await ctx.worker.drain();
  const q2 = (await op.get(`${NW}/batches/${queued2.body.batch_id}`)).body;
  assert.equal(q2.status, 'failed');
  assert.equal(q2.failure.reason, 'ContractSupersededError');
  assert.equal((await sql(`SELECT count(*)::int n FROM t_northwind.claim WHERE "_batch_id" = $1`, [queued2.body.batch_id]))[0].n, 0, 'no effects under the old contract');
  const rp = await op.post(`${NW}/batches/${queued2.body.batch_id}/replay`);
  assert.equal(rp.body.contract_version, '3.0.0', 'replay re-pins to the active contract');
  await ctx.worker.drain();
  const q2b = (await op.get(`${NW}/batches/${queued2.body.batch_id}`)).body;
  assert.equal(q2b.status, 'completed');
  assert.equal(q2b.contract_version, '3.0.0');
  assert.ok(q2b.quality_results.some((q: { rule_id: string }) => q.rule_id === 'rule:billed_positive'), 'validated under the new rules');

  // --- 9. Drift in migration-created current rows is still detected after a backfill migration.
  const target = (await sql(`SELECT "_key" AS k, "_batch_id" AS b FROM t_northwind.claim WHERE "_is_current" AND "_migration_id" IS NOT NULL AND status = 'PAID' LIMIT 1`))[0];
  await sql(`UPDATE t_northwind.claim SET paid_amount = paid_amount + 500 WHERE "_key" = $1 AND "_is_current"`, [target.k]);
  const dr = (await op.post(`${NW}/reconciliation/run`)).body;
  const hit = dr.batch_reverification_failures.find((f: { batch_id: string; check_id: string }) => f.batch_id === target.b && f.check_id === 'reverify:migration_sum:paid_amount');
  assert.ok(hit, 'edit to a migration-created version detected');
  assert.equal(hit.difference.amount, '500.00');
  assert.equal((await op.get(`${NW}/batches/${target.b}`)).body.trust_status, 'untrusted');
  await sql(`UPDATE t_northwind.claim SET paid_amount = paid_amount - 500 WHERE "_key" = $1 AND "_is_current"`, [target.k]);
  await op.post(`${NW}/reconciliation/run`);
  assert.equal((await op.get(`${NW}/batches/${target.b}`)).body.trust_status, 'trusted', 'trust restored once the edit is reverted');
  assert.ok(c1.body.batch_id);

  evidence('Scenario H — Contract evolution', [
    `Baseline: 300 claims under 1.0.0 (${pended} PENDED). v2-unsafe dry-run classification=rejected: ${dry.plan.rejected_reasons.length} reasons incl. "paid_amount: decimal -> integer" and "PENDED removed without a mapping"; publish returned 422 and stored nothing.`,
    `A contract declaring a non-whitelisted transform ({op:"javascript"}) failed schema validation (422 invalid_contract).`,
    `v2 publish returned 202 pending_approval, migration ${migId}: breaking changes [${kinds.join(', ')}]; ${plan.ddl.length} DDL statement(s), none destructive; data ops backfill line_of_business=COMMERCIAL and PENDED->PENDING; impact ${plan.impact.claim.affected_rows} of ${plan.impact.claim.current_rows} current rows (distinct). Full plan: test-results/scenario-h-migration-plan.json.`,
    `While pending: 1.0.0 remained active, no column added, a new claims batch processed under 1.0.0, a further publish got 409 migration_pending.`,
    `Approval: operator 403, requesting admin 403 (approval is a separate approver role with no data access, issued only by the platform admin), wrong confirm_version 422. Approver approved -> applied; lifecycles ${lifecycles.join(', ')}.`,
    `After apply: ${total} current claims all carry line_of_business=COMMERCIAL and 0 PENDED; ${hist[0].n} prior versions retained unchanged under 1.0.0 (lineage for ${sample.CLM_ID}: 1.0.0:PENDED -> 2.0.0:PENDING). total_paid unchanged (${after1.total_paid}); re-verification found no drift.`,
    `Separation of duties: the requesting admin's approval attempt got 403 (audited); a tenant admin minting an approver token got 403 approver_issued_by_platform_only; the approver role read no tenant data (403).`,
    `Compatible widening 2.1.0 (paid_amount precision 12->14, days_supply integer->decimal) applied (201) with real ALTER COLUMN TYPE behind regenerated views; a batch queued under 2.0.1 was re-pinned to 2.1.0 (audited batch.repinned).`,
    `Breaking 3.0.0 (new error rule) approved while a batch was queued under 2.1.0: that batch failed ContractSupersededError with no effects; replay re-pinned it to 3.0.0 and it completed, validated by the new rule.`,
    `After the backfill migration, editing a migration-created current row (+500.00 paid) was caught by reverify:migration_sum:paid_amount and the batch became untrusted; reverting the edit restored trust.`,
    `Rollback restored ${rb.body.restored_versions.claim} versions and 1.0.0. Roll-forward 2.0.1 approved; 40 v2-shaped claims trusted (medicare_claims=${after2.medicare_claims}); v1-shaped file rejected (missing LOB); rollback then refused 409 rollback_window_closed.`,
  ]);
});
