// Scenario C — Duplicate delivery: identical resubmission (sequential and
// concurrent) and partial redelivery of already-loaded rows inside a new file.
// None may create additional business effects.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

test('Scenario C: duplicate submissions have no duplicate business effects', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const members = nwMembers(60, 301);
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  const claims = nwClaims(400, members.map((m) => m.MBR_ID), 302);
  const file = toCsv(claims as never, NW_CLAIM_COLUMNS);

  const first = await op.csv('northwind', 'nw_medical_claims_csv', file);
  await ctx.worker.drain();
  const before = (await rep.get('/api/v1/tenants/northwind/reports/business')).body.metrics;
  const rowsBefore = (await sql(`SELECT count(*)::int AS n FROM t_northwind.claim`))[0].n;

  // 1. Same bytes again, after processing.
  const second = await op.csv('northwind', 'nw_medical_claims_csv', file);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.batch_id, first.body.batch_id);

  // 2. Five concurrent identical submissions of a NEW file -> exactly one batch.
  const extra = nwClaims(50, members.map((m) => m.MBR_ID), 303, 5000);
  const extraFile = toCsv(extra as never, NW_CLAIM_COLUMNS);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => op.csv('northwind', 'nw_medical_claims_csv', extraFile)));
  const ids = new Set(concurrent.map((r) => r.body.batch_id));
  assert.equal(ids.size, 1, 'concurrent duplicates resolve to one batch');
  assert.equal(concurrent.filter((r) => r.body.duplicate === false).length, 1);

  // 3. A different file that re-delivers 100 already-loaded rows plus 10 new ones.
  const redelivery = [...claims.slice(0, 100), ...nwClaims(10, members.map((m) => m.MBR_ID), 304, 9000)];
  const red = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(redelivery as never, NW_CLAIM_COLUMNS));
  assert.equal(red.status, 202);
  assert.equal(await ctx.worker.drain(), 2);

  const redBatch = (await op.get(`/api/v1/tenants/northwind/batches/${red.body.batch_id}`)).body;
  assert.deepEqual([redBatch.received_count, redBatch.accepted_count, redBatch.duplicate_count, redBatch.quarantined_count], [110, 10, 100, 0]);
  assert.equal(redBatch.trust_status, 'trusted');
  const rowsAfter = (await sql(`SELECT count(*)::int AS n FROM t_northwind.claim`))[0].n;
  assert.equal(rowsAfter, rowsBefore + 50 + 10, 'only genuinely new rows were added');
  const dupKeys = (await sql(`SELECT count(*)::int AS n FROM (SELECT "_key" FROM t_northwind.claim WHERE "_is_current" GROUP BY 1 HAVING count(*) > 1) d`))[0].n;
  assert.equal(dupKeys, 0);

  const after = (await rep.get('/api/v1/tenants/northwind/reports/business')).body.metrics;
  const byId = (ms: { id: string; value: string }[]) => Object.fromEntries(ms.map((m) => [m.id, m.value]));
  assert.equal(Number(byId(after).claims_total), Number(byId(before).claims_total) + 60);

  const subs = await sql(`SELECT outcome, count(*)::int AS n FROM core.batch_submissions WHERE tenant_id = 'northwind' AND batch_id = $1 GROUP BY 1 ORDER BY 1`, [first.body.batch_id]);
  assert.deepEqual(subs, [{ outcome: 'accepted', n: 1 }, { outcome: 'duplicate', n: 1 }]);
  const dupRows = await sql(`SELECT count(*)::int AS n FROM core.raw_records WHERE batch_id = $1 AND disposition = 'duplicate' AND canonical_record_id IS NOT NULL`, [red.body.batch_id]);
  assert.equal(dupRows[0].n, 100, 'each redelivered row is linked to the version it duplicated');
  const ops = (await op.get('/api/v1/tenants/northwind/reports/operations')).body;
  assert.equal(ops.totals.duplicate_submissions, 5);

  evidence('Scenario C — Duplicate delivery', [
    `Resubmitting identical bytes returned HTTP 200 with duplicate=true and the original batch id ${first.body.batch_id}; recorded as a 'duplicate' submission.`,
    `5 concurrent identical submissions produced exactly 1 batch (${[...ids][0]}).`,
    `Redelivery file (100 already-loaded + 10 new rows): accepted=10, duplicate=100, quarantined=0, still trusted; each duplicate row links to the version it duplicated.`,
    `claim rows: ${rowsBefore} -> ${rowsAfter} (+60 genuinely new); keys with >1 current version: 0; claims_total ${byId(before).claims_total} -> ${byId(after).claims_total}.`,
  ]);
});
