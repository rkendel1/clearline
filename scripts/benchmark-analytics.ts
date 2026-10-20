// Saved-analytics benchmark. Creates a dedicated database (default clearline_bench_analytics),
// loads the analytics dataset plus ABENCH_CLAIMS extra claims (default 50,000) through the real
// API, then measures:
//   ml         every algorithm in process on small / medium / large inputs (no database)
//   runs       end-to-end scheduled-style runs (claim, identity check, query, snapshot, analyses,
//              insights, deliveries to in-app + signed webhook + email + export) for three saved
//              queries of increasing result size, with the run's own phase timings
//   throughput ABENCH_BURST runs (default 40) queued at once, drained by one scheduler with the
//              configured concurrency limits
// Writes test-results/benchmark-analytics.json and prints it; `BENCH_RENDER_ONLY=1 npm run benchmark`
// renders it into docs/benchmark.md.
//   npm run benchmark:analytics          ABENCH_CLAIMS=5000 ABENCH_ITER=3 ABENCH_BURST=10 npm run benchmark:analytics

import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.BENCH_DATABASE_NAME ?? 'clearline_bench_analytics';
const HOST = process.env.PGHOST_URL ?? 'postgres://clearline:clearline@localhost:5432';
const SECRET = 'bench-webhook-secret';
Object.assign(process.env, {
  DATABASE_URL: `${HOST}/${DB}`, NODE_ENV: 'test', LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
  // Loopback webhook receiver: private addresses are allowed for this local benchmark only (refused in production).
  WEBHOOK_ALLOW_PRIVATE: 'true', WEBHOOK_SECRET_BENCH: SECRET, EMAIL_PROVIDER: 'test', EMAIL_FROM: 'clearline@example.org',
});
const EXTRA_CLAIMS = Number(process.env.ABENCH_CLAIMS ?? 50_000);
const ITER = Number(process.env.ABENCH_ITER ?? 10);
const BURST = Number(process.env.ABENCH_BURST ?? 40);

const { buildServer } = await import('../src/api/server.js');
const { migrate } = await import('../src/platform/migrate.js');
const { closePool, getPool, withTenant } = await import('../src/platform/db.js');
const { loadConfig } = await import('../src/platform/config.js');
const { Worker } = await import('../src/ingestion/worker.js');
const { Scheduler } = await import('../src/analytics/scheduler.js');
const { seed, DEV_TOKENS } = await import('./seed.js');
const { nwMembers, nwClaims, toCsv, NW_CLAIM_COLUMNS, NW_MEMBER_COLUMNS } = await import('../synthetic/generator.js');
const { loadAnalyticsDataset } = await import('../synthetic/analytics-dataset.js');
const { runAnalysis, normalizeConfig } = await import('../src/analysis/index.js');

execFileSync(path.join(ROOT, 'scripts/reset-db.sh'), [DB], { stdio: 'inherit' });
await migrate();
await seed();
const app = await buildServer();
const base = await app.listen({ port: 0, host: '127.0.0.1' });

async function api(method: string, url: string, body?: unknown, token = DEV_TOKENS.northwind.admin) {
  const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (r.status >= 300) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 400)}`);
  return json;
}
const T = '/api/v1/tenants/northwind';
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
  return { n: s.length, p50_ms: +q(0.5).toFixed(2), p95_ms: +q(0.95).toFixed(2), max_ms: +s[s.length - 1].toFixed(2) };
};

// ---- data: the analytics dataset (180 days, one planted anomaly) plus extra random claims.
const nw = {
  csv: async (tenant: string, source: string, body: Buffer) => {
    const r = await fetch(`${base}${T.replace('northwind', tenant)}/batches/csv?source=${source}`, { method: 'POST', body: new Uint8Array(body), headers: { authorization: `Bearer ${DEV_TOKENS.northwind.operator}`, 'content-type': 'text/csv' } });
    return { status: r.status, body: await r.json() };
  },
  json: async () => { throw new Error('unused'); },
};
await loadAnalyticsDataset(nw as never);
const members = nwMembers(5000, 7001);
await nw.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
await nw.csv('northwind', 'nw_medical_claims_csv', toCsv(nwClaims(EXTRA_CLAIMS, members.map((m) => m.MBR_ID), 7002) as never, NW_CLAIM_COLUMNS));
await new Worker().drain();
await getPool().query('ANALYZE');
const claims = Number((await getPool().query(`SELECT count(*) AS n FROM t_northwind.claim WHERE "_is_current"`)).rows[0].n);

// ---- ML in process: small / medium / large inputs at and below the default limits.
const cfgLimits = loadConfig();
const limits = { maxRows: 50_000, maxFeatures: cfgLimits.analysisMaxFeatures, maxPoints: 50_000, maxHorizon: cfgLimits.analysisMaxHorizon, timeoutMs: 60_000, maxMemoryMb: 1024 };
let seedState = 42;
const rnd = () => { seedState = (seedState * 1103515245 + 12345) % 2 ** 31; return seedState / 2 ** 31; };
const col = (name: string, type: string) => ({ name, type, masked: null, sensitive: false });
const series = (n: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const weekly = [1.0, 1.1, 1.05, 1.0, 0.95, 0.4, 0.3][i % 7];
  return [d, (10_000 + i * 2) * weekly * (0.9 + rnd() * 0.2) + (i === Math.floor(n * 0.8) ? 25_000 : 0)];
});
const matrix = (n: number) => Array.from({ length: n }, (_, i) => {
  const g = i % 3;
  return [`R${i}`, [200, 1500, 9000][g] * (0.8 + rnd() * 0.4), [3, 10, 30][g] + rnd() * 4, Math.floor(rnd() * 3), ['99213', '99244', '99223'][g]];
});
const SIZES = { small: { points: 180, rows: 500 }, medium: { points: 1_000, rows: 5_000 }, large: { points: 5_000, rows: 20_000 } } as const;
const ML_CASES: [string, Record<string, unknown>, 'series' | 'matrix'][] = [
  ['anomaly.rolling_mad', { type: 'anomaly', algorithm: 'anomaly.rolling_mad', time_column: 'day', metrics: ['v'], grain: 'day', period: 7 }, 'series'],
  ['anomaly.seasonal_decomposition', { type: 'anomaly', algorithm: 'anomaly.seasonal_decomposition', time_column: 'day', metrics: ['v'], grain: 'day', period: 7 }, 'series'],
  ['forecast.auto', { type: 'forecast', algorithm: 'forecast.auto', time_column: 'day', metric: 'v', grain: 'day', period: 7, horizon: 28 }, 'series'],
  ['outlier.robust_distance', { type: 'outlier', algorithm: 'outlier.robust_distance', id_column: 'id', features: ['amount', 'days', 'corrections'], group_by: 'procedure' }, 'matrix'],
  ['cluster.kmeans', { type: 'cluster', algorithm: 'cluster.kmeans', id_column: 'id', features: ['amount', 'days', 'corrections'], k: 3 }, 'matrix'],
];
const ml: Record<string, Record<string, unknown>> = {};
for (const [name, raw, shape] of ML_CASES) {
  ml[name] = {};
  for (const [size, dims] of Object.entries(SIZES)) {
    const rows = shape === 'series' ? series(dims.points) : matrix(dims.rows);
    const columns = shape === 'series' ? [col('day', 'date'), col('v', 'decimal')] : [col('id', 'string'), col('amount', 'decimal'), col('days', 'integer'), col('corrections', 'integer'), col('procedure', 'string')];
    const { config, issues } = normalizeConfig({ key: 'b', ...raw }, limits);
    if (!config) throw new Error(`${name}: ${JSON.stringify(issues)}`);
    const n = size === 'large' ? Math.max(3, Math.floor(ITER / 2)) : ITER;
    const prepare: number[] = [], algorithm: number[] = [], total: number[] = [];
    let status = '';
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const o = runAnalysis(config, { columns, rows, truncated: false }, limits);
      total.push(performance.now() - t0);
      prepare.push(o.timings.prepare_ms); algorithm.push(o.timings.algorithm_ms);
      status = o.status;
      if (o.status !== 'succeeded') throw new Error(`${name} ${size}: ${o.status} ${o.message}`);
    }
    ml[name][size] = { input: shape === 'series' ? `${dims.points} points` : `${dims.rows} rows × 3 features`, status, total: stats(total), prepare_p50_ms: stats(prepare).p50_ms, algorithm_p50_ms: stats(algorithm).p50_ms };
  }
}

// ---- end-to-end runs through the scheduler, with deliveries.
// Loopback webhook receiver that checks each request's signature.
const hook = await (async () => {
  const received: { signatureValid: boolean }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(req.headers['clearline-signature'] ?? ''));
      received.push({ signatureValid: !!m && createHmac('sha256', SECRET).update(`${m[1]}.${body}`).digest('hex') === m[2] });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
})();
const dests = [
  await api('POST', `${T}/analytics/destinations`, { name: 'Bench inbox', kind: 'in_app', config: { recipients: ['$owner', 'northwind-operator'] } }),
  await api('POST', `${T}/analytics/destinations`, { name: 'Bench webhook', kind: 'webhook', config: { url: hook.url, secret_ref: 'BENCH', include_rows: true } }),
  await api('POST', `${T}/analytics/destinations`, { name: 'Bench email', kind: 'email', config: { to: ['finance@example.org'] }, content: 'summary_with_csv' }),
  await api('POST', `${T}/analytics/destinations`, { name: 'Bench export', kind: 'export', config: {} }),
];
const QUERIES = {
  small: { name: 'Daily paid (180 days)', sql: `SELECT service_date AS day, sum(paid_amount) AS paid, count(*) AS claims FROM claim WHERE service_date >= :start AND service_date <= :end AND _trust_status = 'trusted' GROUP BY 1 ORDER BY 1`,
    parameters: [{ name: 'start', type: 'date', default: '2026-04-04' }, { name: 'end', type: 'date', default: '2026-09-30' }],
    analyses: [{ type: 'anomaly', key: 'a', algorithm: 'anomaly.rolling_mad', time_column: 'day', metrics: ['paid', 'claims'], grain: 'day', period: 7 },
      { type: 'forecast', key: 'f', algorithm: 'forecast.auto', time_column: 'day', metric: 'paid', grain: 'day', period: 7, horizon: 14, missing: 'zero' }] },
  medium: { name: 'Paid by member (top 2,000)', sql: `SELECT member_id, sum(paid_amount) AS paid, count(*) AS claims, max(paid_amount) AS largest FROM claim WHERE _trust_status = 'trusted' GROUP BY 1 ORDER BY 2 DESC LIMIT 2000`,
    parameters: [], analyses: [{ type: 'outlier', key: 'o', algorithm: 'outlier.robust_distance', id_column: 'member_id', features: ['paid', 'claims', 'largest'] }] },
  large: { name: 'Claims (5,000 rows)', sql: `SELECT claim_id, paid_amount, billed_amount, (received_date - service_date) AS days FROM claim WHERE _trust_status = 'trusted' ORDER BY claim_id LIMIT 5000`,
    parameters: [], analyses: [{ type: 'outlier', key: 'o', algorithm: 'outlier.robust_distance', id_column: 'claim_id', features: ['paid_amount', 'billed_amount', 'days'] },
      { type: 'cluster', key: 'c', algorithm: 'cluster.kmeans', id_column: 'claim_id', features: ['paid_amount', 'billed_amount', 'days'], k: 4 }] },
};
const sched = new Scheduler({ workerId: 'bench' });
const runs: Record<string, unknown> = {};
for (const [size, q] of Object.entries(QUERIES)) {
  const saved = await api('POST', `${T}/saved-queries`, { ...q, sharing: 'private' });
  const ph: Record<string, number[]> = { wall: [], queue_wait: [], identity: [], query: [], snapshot: [], analyses: [], delivery: [] };
  let last: any;
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    const queued = await api('POST', `${T}/saved-queries/${saved.id}/runs`, { destination_ids: dests.map((d: any) => d.id) });
    await sched.drain();
    ph.wall.push(performance.now() - t0);
    last = await api('GET', `${T}/analytics/runs/${queued.run_id}`);
    if (last.run.status !== 'succeeded') throw new Error(`${size} run ${last.run.status}: ${last.run.error_code} ${last.run.error_message} ${JSON.stringify(last.deliveries.map((d: any) => [d.kind, d.status, d.last_error_code]))}`);
    const t = last.run.timings;
    ph.queue_wait.push(t.queue_wait_ms ?? 0); ph.identity.push(t.identity_ms ?? 0); ph.query.push(t.query_ms ?? 0); ph.snapshot.push(t.snapshot_ms ?? 0);
    ph.analyses.push(t.analysis_ms ?? 0); ph.delivery.push(t.delivery_ms ?? 0);
  }
  runs[size] = { query: q.name, rows: last.run.result?.row_count, snapshot_bytes: last.run.result?.bytes, analyses: q.analyses.map((a) => a.algorithm), insights: last.insights.length,
    deliveries: last.deliveries.map((d: any) => `${d.kind}:${d.status}`), phases: Object.fromEntries(Object.entries(ph).map(([k, v]) => [k, stats(v)])) };
}
const signed = hook.received.filter((r) => r.signatureValid).length;

// ---- throughput: a burst of queued runs drained by one scheduler process.
const burstQuery = await api('POST', `${T}/saved-queries`, { ...QUERIES.small, name: 'Burst', analyses: [QUERIES.small.analyses[0]] });
const t0 = performance.now();
for (let i = 0; i < BURST; i++) await api('POST', `${T}/saved-queries/${burstQuery.id}/runs`, { destination_ids: [dests[0].id] });
const queuedMs = performance.now() - t0;
const t1 = performance.now();
const ticks = await sched.drain(BURST * 4);
const drainMs = performance.now() - t1;
const burstRows = await withTenant('northwind', async (tx) => (await tx.query(`SELECT status, count(*)::int AS n FROM core.analytics_runs WHERE query_id = $1 GROUP BY 1`, [burstQuery.id])).rows);
const largestTick = Math.max(...ticks.map((t: any) => t.runs ?? 0));

await hook.close();
const pgv = (await getPool().query('SHOW server_version')).rows[0].server_version;
const result = {
  generated_at: new Date().toISOString(),
  environment: { cpu: cpus()[0]?.model, cpu_count: cpus().length, memory_gb: +(totalmem() / 1e9).toFixed(1), os: `${platform()} ${release()}`, node: process.version, postgres: pgv, database_location: 'same host as the application (loopback)' },
  dataset: { claims, extra_random_claims: EXTRA_CLAIMS, iterations: ITER, burst: BURST },
  configuration: { SCHEDULER_MAX_CONCURRENT: cfgLimits.schedulerMaxConcurrent, SCHEDULER_MAX_PER_TENANT: cfgLimits.schedulerMaxPerTenant, ANALYSIS_MAX_ROWS: cfgLimits.analysisMaxRows,
    ANALYSIS_MAX_POINTS: cfgLimits.analysisMaxPoints, DELIVERY_MAX_ROWS: cfgLimits.deliveryMaxRows, ml_limits_for_in_process_cases: 'maxRows/maxPoints raised to 50,000 so the large case exceeds the default caps' },
  ml, runs,
  webhook: { received: hook.received.length, signature_valid: signed },
  throughput: { runs: BURST, enqueue_ms: +queuedMs.toFixed(0), drain_ms: +drainMs.toFixed(0), runs_per_s: +(BURST / (drainMs / 1000)).toFixed(1), ticks: ticks.length, largest_tick_runs: largestTick, outcome: Object.fromEntries(burstRows.map((r: any) => [r.status, r.n])) },
};
mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
writeFileSync(path.join(ROOT, 'test-results/benchmark-analytics.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await app.close();
await closePool();
process.exit(0);
