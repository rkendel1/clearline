// Query workspace benchmark. Creates a dedicated database (default clearline_bench_query),
// loads 5,000 members and QBENCH_CLAIMS claims (default 100,000) through the real API, then
// measures through the real HTTP API and database:
//   validate   parse + allowlist validation + rewrite + deparse round trip (no database)
//   propose    POST /queries/proposals for NL questions (deterministic provider) and SQL, incl. EXPLAIN
//   execute    small aggregate, grouped aggregate, 5,000-row result (row cap), preview
//   concurrent 2 and 4 simultaneous executions against the per-tenant limit
// Writes test-results/benchmark-query.json and prints a summary.
//   npm run benchmark:query                 QBENCH_CLAIMS=20000 QBENCH_ITER=50 npm run benchmark:query

import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.BENCH_DATABASE_NAME ?? 'clearline_bench_query';
const HOST = process.env.PGHOST_URL ?? 'postgres://clearline:clearline@localhost:5432';
process.env.DATABASE_URL = `${HOST}/${DB}`;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
const CLAIMS = Number(process.env.QBENCH_CLAIMS ?? 100_000);
const ITER = Number(process.env.QBENCH_ITER ?? 100);

const { buildServer } = await import('../src/api/server.js');
const { migrate } = await import('../src/platform/migrate.js');
const { closePool, getPool, withTenant } = await import('../src/platform/db.js');
const { Worker } = await import('../src/ingestion/worker.js');
const { seed, DEV_TOKENS } = await import('./seed.js');
const { nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, NW_PLANS } = await import('../synthetic/generator.js');
const { getActiveContract } = await import('../src/contracts/registry.js');
const { loadPolicies } = await import('../src/policy/fields.js');
const { buildCatalog } = await import('../src/query/catalog.js');
const { validateSql } = await import('../src/query/validate.js');

execFileSync(path.join(ROOT, 'scripts/reset-db.sh'), [DB], { stdio: 'inherit' });
await migrate();
await seed();
const app = await buildServer();
const base = await app.listen({ port: 0, host: '127.0.0.1' });
const TOKEN = DEV_TOKENS.northwind.reporter;

async function post(url: string, body: unknown, token = TOKEN) {
  const r = await fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text), bytes: text.length };
}
async function csv(source: string, data: Buffer) {
  const r = await fetch(`${base}/api/v1/tenants/northwind/batches/csv?source=${source}`, { method: 'POST', body: new Uint8Array(data), headers: { authorization: `Bearer ${DEV_TOKENS.northwind.operator}`, 'content-type': 'text/csv' } });
  if (r.status !== 202) throw new Error(`submit ${source}: ${r.status}`);
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
  return { n: s.length, p50_ms: +q(0.5).toFixed(2), p95_ms: +q(0.95).toFixed(2), max_ms: +s[s.length - 1].toFixed(2), mean_ms: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) };
};
async function timed<T>(n: number, f: () => Promise<T>) { const t: number[] = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await f(); t.push(performance.now() - t0); } return stats(t); }

// ---- data
const members = nwMembers(5000, 9001);
await csv('nw_plans_csv', toCsv(NW_PLANS as never));
await csv('nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
await csv('nw_medical_claims_csv', toCsv(nwClaims(CLAIMS, members.map((m) => m.MBR_ID), 9002) as never, NW_CLAIM_COLUMNS));
const worker = new Worker();
await worker.drain();
await getPool().query('ANALYZE');

// ---- validate (in process, no database)
const catalog = await withTenant('northwind', async (tx) => buildCatalog(await loadPolicies(tx, 'northwind', (await getActiveContract(tx, 'northwind'))!.document), 'reporter'));
const QUERIES: Record<string, string> = {
  simple: "SELECT count(*) FROM claim WHERE status = 'PAID'",
  grouped: "SELECT date_trunc('month', service_date) AS m, status, count(*), sum(paid_amount) FROM claim WHERE _trust_status = 'trusted' GROUP BY 1, 2 ORDER BY 1, 2",
  join_subquery: 'SELECT c.claim_id, c.member_id FROM claim c WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m.member_id = c.member_id) ORDER BY c.claim_id',
  cte_masked: "WITH p AS (SELECT member_id, sum(paid_amount) AS total FROM claim GROUP BY member_id) SELECT m.member_id, m.last_name, p.total FROM member m JOIN p ON p.member_id = m.member_id ORDER BY p.total DESC",
};
const validate: Record<string, unknown> = {};
for (const [k, q] of Object.entries(QUERIES)) {
  const r = await validateSql(q, catalog, { maxRows: 5000 });
  if (!r.ok) throw new Error(`${k} invalid: ${JSON.stringify(r.issues)}`);
  validate[k] = await timed(ITER, () => validateSql(q, catalog, { maxRows: 5000 }));
}
validate.rejected_probe = await timed(ITER, () => validateSql("SELECT count(*) FROM member WHERE last_name LIKE 'A%'", catalog, { maxRows: 5000 }));

// ---- propose over HTTP (includes catalog load, provider, validation, EXPLAIN, persistence, audit)
const propose = {
  nl_question: await timed(Math.min(ITER, 50), () => post('/api/v1/tenants/northwind/queries/proposals', { question: 'Compare paid amounts across the last three reporting periods.' })),
  sql_grouped: await timed(Math.min(ITER, 50), () => post('/api/v1/tenants/northwind/queries/proposals', { sql: QUERIES.grouped })),
  sql_rejected: await timed(Math.min(ITER, 50), () => post('/api/v1/tenants/northwind/queries/proposals', { sql: "SELECT count(*) FROM member WHERE last_name LIKE 'A%'" })),
};

// ---- execute
async function prop(sql: string) { const p = await post('/api/v1/tenants/northwind/queries/proposals', { sql }); if (!p.body.validation.ok) throw new Error(JSON.stringify(p.body.validation.issues)); return p.body.id as string; }
const execute: Record<string, unknown> = {};
const cases: [string, string, 'run' | 'preview'][] = [
  ['count_100k', QUERIES.simple, 'run'], ['grouped_by_month_status', QUERIES.grouped, 'run'], ['orphans_anti_join', QUERIES.join_subquery, 'run'],
  ['cte_join_masked_5000', QUERIES.cte_masked, 'run'], ['wide_5000_rows', 'SELECT claim_id, member_id, service_date, billed_amount, allowed_amount, paid_amount, status FROM claim ORDER BY claim_id', 'run'],
  ['preview_20', 'SELECT claim_id, member_id, service_date, paid_amount FROM claim ORDER BY claim_id', 'preview'],
];
for (const [k, sql, mode] of cases) {
  const id = await prop(sql);
  let last: any;
  const t = await timed(Math.min(ITER, 30), async () => { last = await post(`/api/v1/tenants/northwind/queries/proposals/${id}/execute`, { mode }); if (last.body.status !== 'succeeded') throw new Error(JSON.stringify(last.body)); });
  execute[k] = { ...t, rows: last.body.row_count, truncated: last.body.truncated, response_bytes: last.bytes, server_duration_ms: last.body.duration_ms };
}

// ---- concurrency against the per-tenant limit (2)
const heavy = await prop('SELECT count(*) FROM claim a JOIN claim b ON a.member_id = b.member_id');
const concurrent: Record<string, unknown> = {};
for (const n of [1, 2, 4]) {
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: n }, () => post(`/api/v1/tenants/northwind/queries/proposals/${heavy}/execute`, { mode: 'run' })));
  concurrent[`${n}_parallel`] = { wall_ms: +(performance.now() - t0).toFixed(1), ran: rs.filter((r) => r.status === 200).length, refused_429: rs.filter((r) => r.status === 429).length,
    server_ms: rs.filter((r) => r.status === 200).map((r) => r.body.duration_ms) };
}

const pgv = (await getPool().query('SHOW server_version')).rows[0].server_version;
const result = {
  generated_at: new Date().toISOString(),
  environment: { cpu: cpus()[0]?.model, cpu_count: cpus().length, memory_gb: +(totalmem() / 1e9).toFixed(1), os: `${platform()} ${release()}`, node: process.version, postgres: pgv,
    database_location: 'same host as the application (loopback)' },
  dataset: { members: 5000, claims: CLAIMS, iterations: ITER },
  configuration: { QUERY_TIMEOUT_MS: process.env.QUERY_TIMEOUT_MS ?? '10000 (default)', QUERY_MAX_ROWS: process.env.QUERY_MAX_ROWS ?? '5000 (default)', QUERY_MAX_CONCURRENT_PER_TENANT: process.env.QUERY_MAX_CONCURRENT_PER_TENANT ?? '2 (default)', provider: 'deterministic' },
  validate, propose, execute, concurrent,
};
mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
writeFileSync(path.join(ROOT, 'test-results/benchmark-query.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await app.close();
await closePool();
process.exit(0);
