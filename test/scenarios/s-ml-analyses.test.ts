// Scenario S — ML analyses on authorized query results, against ground truth from the
// deterministic analytics dataset: a planted anomaly, a forecast evaluated on held-out weeks,
// seeded outliers among comparable claims, and clusters matching three known claim profiles.
// Results are deterministic, bounded, refuse sensitive inputs, and model summaries cannot
// change computed numbers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { analytics, expectStatus, DAILY_SQL, DAILY_PARAMS } from '../helpers/analytics.js';
import { loadAnalyticsDataset, type AnalyticsTruth } from '../../synthetic/analytics-dataset.js';
import { Scheduler } from '../../src/analytics/scheduler.js';
import { setNarratorForTests, type Narrator } from '../../src/analysis/narrate.js';

let ctx: Ctx;
let truth: AnalyticsTruth;
const sched = new Scheduler({ workerId: 's-sched' });
before(async () => {
  ctx = await setup();
  truth = await loadAnalyticsDataset(client(ctx, DEV_TOKENS.northwind.operator));
  await ctx.worker.drain();
});
after(async () => { setNarratorForTests(undefined); await teardown(ctx); });

const R = () => analytics(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
const A = () => analytics(client(ctx, DEV_TOKENS.northwind.admin), 'northwind');
async function runAndGet(qid: string, b: Record<string, unknown> = {}, who = R()) {
  const r = expectStatus(await who.runNow(qid, b), 202);
  await sched.drain();
  return expectStatus(await who.run(r.run_id), 200);
}
const CLAIMS_SQL = `SELECT claim_id, procedure_code, billed_amount, paid_amount, received_date - service_date AS processing_days
FROM claim WHERE _trust_status = 'trusted' ORDER BY claim_id`;

test('Scenario S1: time-series anomaly detection finds the planted spike, with computed, grounded evidence', async () => {
  const q = expectStatus(await R().create({ name: 'Daily paid (anomalies)', sql: DAILY_SQL, parameters: DAILY_PARAMS, analyses: [
    { type: 'anomaly', key: 'rolling', algorithm: 'anomaly.rolling_mad', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 },
    { type: 'anomaly', key: 'decomposition', algorithm: 'anomaly.seasonal_decomposition', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 },
  ] }), 201);
  const d = await runAndGet(q.id);
  assert.equal(d.run.status, 'succeeded');
  assert.equal(d.run.analysis_status, 'succeeded');
  const rolling = d.analyses.find((a: any) => a.key === 'rolling');
  const decomposition = d.analyses.find((a: any) => a.key === 'decomposition');
  assert.equal(rolling.algorithm, 'anomaly.rolling_mad');
  assert.equal(rolling.algorithm_version, '1.0.0');
  const top = (a: any) => [...a.result.metrics[0].anomalies].sort((x: any, y: any) => Math.abs(y.score) - Math.abs(x.score))[0];
  for (const a of [rolling, decomposition]) {
    const t = top(a);
    assert.equal(t.t, truth.anomalyDate, `${a.key}: the strongest anomaly is the planted one`);
    assert.equal(Math.round(t.observed * 100), truth.dailyPaidCents.get(truth.anomalyDate), 'observed value = ground truth');
    assert.ok(t.observed > t.upper && t.deviation_pct > 50, JSON.stringify(t));
    assert.ok(a.result.metrics[0].anomalies.length <= 4, `${a.key}: few flags (${a.result.metrics[0].anomalies.length}), not every fluctuation`);
  }
  const ins = d.insights.find((i: any) => i.kind === 'anomaly' && i.title.includes(truth.anomalyDate));
  assert.ok(ins, 'an insight is persisted');
  assert.equal(ins.severity, 'high');
  assert.equal(ins.evidence.algorithm, 'anomaly.rolling_mad');
  assert.match(ins.body, /This is a statistical deviation; it does not establish a cause\./);
  assert.ok(rolling.result.limitations.length >= 2);
  // Bounded result: series points and anomalies only (no claim rows).
  assert.ok(!JSON.stringify(rolling.result).includes('A00000'));
  const t = top(rolling);
  evidence('Scenario S1 — Anomaly detection', [
    `rolling_mad (period 7) and seasonal_decomposition both rank ${truth.anomalyDate} first: observed ${t.observed} (= ground truth), expected ${t.expected}, range ${t.lower}..${t.upper}, robust z ${t.score}, +${t.deviation_pct}%`,
    `insight: "${ins.title}" (${ins.severity})`,
  ]);
});

test('Scenario S2: weekly forecast evaluated on held-out weeks it never saw, with rolling-origin backtest metrics', async () => {
  const weekly = `SELECT date_trunc('week', service_date)::date AS week, sum(paid_amount) AS paid FROM claim
WHERE service_date >= '2026-04-06' AND service_date < :end AND _trust_status = 'trusted' GROUP BY 1 ORDER BY 1`;
  const q = expectStatus(await R().create({ name: 'Weekly paid (forecast)', sql: weekly, parameters: [{ name: 'end', type: 'date' }],
    analyses: [{ type: 'forecast', key: 'weekly', algorithm: 'forecast.auto', time_column: 'week', metric: 'paid', grain: 'week', horizon: 4 }] }), 201);
  const d = await runAndGet(q.id, { parameters: { end: '2026-08-24' } });   // train on weeks before 24 Aug only
  const f = d.analyses[0];
  assert.equal(f.status, 'succeeded', f.message);
  assert.equal(f.result.training.to, '2026-08-17');
  assert.deepEqual(f.result.forecast.map((p: any) => p.t), ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']);
  assert.ok(f.result.backtest.origins >= 5 && f.result.backtest.mae > 0);
  assert.ok(f.result.backtest.candidates.length >= 3, 'auto compared several methods on the backtest');
  // Held-out truth, computed from the generator.
  const actual = (w: string) => { let c = 0; for (let i = 0; i < 7; i++) { const day = new Date(Date.parse(`${w}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10); c += truth.dailyPaidCents.get(day) ?? 0; } return c / 100; };
  const errs = f.result.forecast.map((p: any) => ({ t: p.t, pct: Math.abs(p.value - actual(p.t)) / actual(p.t) * 100, inside: p.lower !== null && actual(p.t) >= p.lower && actual(p.t) <= p.upper }));
  const normal = errs.filter((e: any) => e.t !== '2026-08-31');
  assert.ok(normal.every((e: any) => e.pct < 10), JSON.stringify(errs));
  assert.equal(errs.reduce((m: any, e: any) => (e.pct > m.pct ? e : m)).t, '2026-08-31', 'the week with the planted spike is the worst forecast (it was not foreseeable)');
  assert.match(d.insights[0].body, /Backtest over \d+ rolling origins: MAE/);
  evidence('Scenario S2 — Forecast vs held-out weeks', [
    `${f.result.method} chosen by backtest MAE among ${f.result.backtest.candidates.map((c: any) => `${c.method} (${c.mae})`).join(', ')}; ${f.result.backtest.origins} rolling origins`,
    `held-out absolute % error by week: ${errs.map((e: any) => `${e.t} ${e.pct.toFixed(1)}%${e.inside ? ' (inside interval)' : ''}`).join(', ')}`,
  ]);
});

test('Scenario S3: outlier detection ranks the seeded claims first, compared within their procedure', async () => {
  const q = expectStatus(await R().create({ name: 'Claims (outliers and segments)', sql: CLAIMS_SQL, analyses: [
    { type: 'outlier', key: 'unusual', id_column: 'claim_id', features: ['billed_amount', 'processing_days'], group_by: 'procedure_code', threshold: 4, top_n: 10 },
    { type: 'cluster', key: 'profiles', id_column: 'claim_id', features: ['billed_amount', 'processing_days'], k: 3, seed: 7 },
  ] }), 201);
  const d = await runAndGet(q.id);
  const o = d.analyses.find((a: any) => a.key === 'unusual');
  assert.equal(o.status, 'succeeded', o.message);
  assert.deepEqual(o.result.records.slice(0, 3).map((r: any) => r.id).sort(), [...truth.outliers].sort());
  assert.equal(o.result.flagged, 3, 'only the seeded claims cross the threshold');
  const byId = Object.fromEntries(o.result.records.map((r: any) => [r.id, r]));
  assert.equal(byId[truth.outliers[0]].contributions[0].feature, 'billed_amount');
  assert.equal(byId[truth.outliers[1]].contributions[0].feature, 'processing_days');
  assert.equal(byId[truth.outliers[0]].group, '99213');
  assert.equal(o.result.records.length, 10, 'bounded to top_n');

  // Clusters: purity against the generator's profiles; deterministic across runs; unnamed until reviewed.
  const c = d.analyses.find((a: any) => a.key === 'profiles');
  assert.equal(c.status, 'succeeded', c.message);
  const purity = (assign: any[]) => {
    const groups = new Map<number, Map<string, number>>();
    for (const a of assign) {
      if (truth.outliers.includes(a.id)) continue;
      const p = truth.profileOf.get(a.id)!;
      const m = groups.get(a.cluster) ?? new Map(); m.set(p, (m.get(p) ?? 0) + 1); groups.set(a.cluster, m);
    }
    let right = 0; let all = 0;
    for (const m of groups.values()) { right += Math.max(...m.values()); all += [...m.values()].reduce((x, y) => x + y, 0); }
    return right / all;
  };
  assert.equal(purity(c.result.assignments), 1, 'each cluster is exactly one profile');
  assert.ok(c.result.silhouette > 0.7, String(c.result.silhouette));
  assert.ok(c.result.clusters.every((x: any) => /unnamed/.test(x.label)));
  const again = await runAndGet(q.id);
  assert.deepEqual(again.analyses.find((a: any) => a.key === 'profiles').result.assignments, c.result.assignments, 'identical input and configuration -> identical clusters');
  const rev = expectStatus(await R().review(c.id, { 1: 'Routine visits', 2: 'Specialist consults', 3: 'Inpatient stays' }), 200);
  assert.equal(rev.review.names['1'], 'Routine visits');
  evidence('Scenario S3 — Outliers and segments', [
    `robust_distance within procedure: top 3 = ${o.result.records.slice(0, 3).map((r: any) => `${r.id} (score ${r.score}, mostly ${r.contributions[0].feature})`).join(', ')} = the seeded outliers; ${o.result.flagged} flagged of ${o.result.scored}`,
    `k-means k=3 seed 7: sizes ${c.result.clusters.map((x: any) => x.size).join('/')}, silhouette ${c.result.silhouette}, purity vs generator profiles 100%; second run identical; clusters named only after review`,
  ]);
});

test('Scenario S4: sensitive or redacted fields cannot enter an analysis; insufficient data is explicit', async () => {
  // Admin sees billed_amount in full, but once it is sensitive it is not an analysis input.
  expectStatus(await client(ctx, DEV_TOKENS.northwind.admin).post('/api/v1/tenants/northwind/fields/claim/billed_amount/policy', { sensitive: true, redaction: 'full', reason: 'scenario S4' }), 200);
  const adminSave = await A().create({ name: 'Admin outliers', sql: CLAIMS_SQL, analyses: [{ type: 'outlier', key: 'o', features: ['billed_amount'] }] });
  assert.equal(adminSave.status, 422);
  assert.match(adminSave.body.error.message, /derived from a sensitive field/);
  // The reporter's existing saved query: billed_amount now arrives redacted, so the analysis refuses it at run time.
  const qid = (expectStatus(await R().list('?q=outliers'), 200).items[0]).id;
  const d = await runAndGet(qid);
  const o = d.analyses.find((a: any) => a.key === 'unusual');
  assert.equal(o.status, 'invalid_configuration');
  assert.match(o.message, /redacted for the run identity/);
  assert.equal(d.run.result.columns.find((c: any) => c.name === 'billed_amount').masked, 'full');
  assert.equal(d.run.analysis_status, 'partial');
  // Insufficient data: a 4-week forecast on 3 weeks of history.
  const short = expectStatus(await R().create({ name: 'Three weeks', sql: `SELECT date_trunc('week', service_date)::date AS week, sum(paid_amount) AS paid FROM claim WHERE service_date >= '2026-09-07' AND service_date < '2026-09-28' GROUP BY 1 ORDER BY 1`,
    analyses: [{ type: 'forecast', key: 'f', time_column: 'week', metric: 'paid', grain: 'week', horizon: 4 }] }), 201);
  const s = await runAndGet(short.id);
  assert.equal(s.analyses[0].status, 'insufficient_data');
  assert.equal(s.insights[0].kind, 'status');
  assert.match(s.insights[0].title, /insufficient data/);
  evidence('Scenario S4 — Sensitive inputs and insufficient data', [
    'claim.billed_amount marked sensitive: admin save with it as a feature -> 422 (derived from a sensitive field); reporter run -> analysis invalid_configuration (column redacted), other analyses still run',
    '4-week forecast on 3 weeks -> insufficient_data with an explicit status insight (no forecast fabricated)',
  ]);
});

test('Scenario S5: model-written summaries are checked against computed evidence and never replace it', async () => {
  const seen: unknown[] = [];
  const liar: Narrator = { id: 'test-provider', model: 'fake-1', narrate: async (i) => { seen.push(i); return `Paid claims tripled to 99999 because of fraud.`; } };
  setNarratorForTests(liar);
  const q = expectStatus(await R().create({ name: 'Daily paid (narrated)', sql: DAILY_SQL, parameters: DAILY_PARAMS, analyses: [{ type: 'anomaly', key: 'a', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 }] }), 201);
  const d = await runAndGet(q.id);
  const ins = d.insights.find((i: any) => i.title.includes(truth.anomalyDate));
  assert.equal(ins.narrative, null, 'rejected narrative is not presented');
  const [stored] = await sql(`SELECT narrative, body FROM core.insights WHERE id = $1`, [ins.id]);
  assert.equal(stored.narrative.accepted, false);
  assert.match(stored.narrative.reason, /cause, misconduct or certainty|not in the computed evidence/);
  assert.equal(stored.body, ins.body, 'the computed statement is unchanged');
  // The provider saw computed evidence only: no result rows.
  assert.ok(seen.length > 0);
  assert.ok(!JSON.stringify(seen).includes('"rows"'));
  const honest: Narrator = { id: 'test-provider', model: 'fake-1', narrate: async (i: any) => `${i.metric} on ${i.evidence.t} was ${i.evidence.observed.toLocaleString('en-US')}, above the expected ${i.evidence.expected.toLocaleString('en-US')}.` };
  setNarratorForTests(honest);
  const d2 = await runAndGet(q.id);
  const ins2 = d2.insights.find((i: any) => i.title.includes(truth.anomalyDate));
  assert.ok(ins2.narrative?.text.includes(truth.anomalyDate), JSON.stringify(ins2.narrative));
  assert.equal(ins2.body, ins.body);
  setNarratorForTests(undefined);
  evidence('Scenario S5 — Model summaries', ['a provider claiming "tripled to 99999 because of fraud" was rejected (ungrounded number / causal claim) and not shown; the template statement was unchanged; a grounded restatement was accepted alongside it; the provider received computed evidence only']);
});
