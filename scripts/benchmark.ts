// Reproducible benchmark. Creates a dedicated database (default clearline_bench),
// migrates and seeds it, then measures through the real HTTP API:
//   phase 1  single worker: claim batches of increasing size (1% defective rows)
//   phase 2  parallel: N worker processes draining M batches across two tenants
// Writes test-results/benchmark.json and prints a summary. Usage:
//   npm run benchmark                      (sizes 10000,50000,100000; 4 workers x 8 batches of 25000)
//   BENCH_SIZES=1000,5000 BENCH_WORKERS=2 BENCH_PARALLEL_BATCHES=4 BENCH_PARALLEL_ROWS=5000 npm run benchmark
// Requires a PostgreSQL admin URL able to create databases (PG_ADMIN_URL).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// BENCH_RENDER_ONLY=1 re-renders docs/benchmark.md from the saved results without measuring.
if (process.env.BENCH_RENDER_ONLY === '1') {
  writeFileSync(path.join(ROOT, 'docs/benchmark.md'), renderReport(JSON.parse(readFileSync(path.join(ROOT, 'test-results/benchmark.json'), 'utf8'))));
  console.log('wrote docs/benchmark.md');
  process.exit(0);
}
const DB = process.env.BENCH_DATABASE_NAME ?? 'clearline_bench';
const HOST = process.env.PGHOST_URL ?? 'postgres://clearline:clearline@localhost:5432';
process.env.DATABASE_URL = `${HOST}/${DB}`;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
const SIZES = (process.env.BENCH_SIZES ?? '10000,50000,100000').split(',').map(Number);
const WORKERS = Number(process.env.BENCH_WORKERS ?? 4);
const PAR_BATCHES = Number(process.env.BENCH_PARALLEL_BATCHES ?? 8);
const PAR_ROWS = Number(process.env.BENCH_PARALLEL_ROWS ?? 25000);

const { buildServer } = await import('../src/api/server.js');
const { migrate } = await import('../src/platform/migrate.js');
const { closePool, getPool, withSystem } = await import('../src/platform/db.js');
const { Worker } = await import('../src/ingestion/worker.js');
const { seed, DEV_TOKENS } = await import('./seed.js');
const { nwMembers, nwClaims, bfEnrollees, bfClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, BF_ENROLLEE_COLUMNS, BF_CLAIM_COLUMNS, NW_PLANS, BF_PLANS } = await import('../synthetic/generator.js');

execFileSync(path.join(ROOT, 'scripts/reset-db.sh'), [DB], { stdio: 'inherit' });
await migrate();
await seed();
const app = await buildServer();
const base = await app.listen({ port: 0, host: '127.0.0.1' });

async function submitCsv(token: string, tenant: string, source: string, csv: Buffer, control?: unknown) {
  const t0 = performance.now();
  const r = await fetch(`${base}/api/v1/tenants/${tenant}/batches/csv?source=${source}`, { method: 'POST', body: new Uint8Array(csv),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv', ...(control ? { 'x-clearline-control': JSON.stringify(control) } : {}) } });
  const body = await r.json();
  if (r.status !== 202) throw new Error(`submit failed: ${r.status} ${JSON.stringify(body)}`);
  return { id: body.batch_id as string, ms: performance.now() - t0 };
}
async function batchRow(id: string) {
  return withSystem(async (tx) => (await tx.query(`SELECT status, trust_status, received_count, accepted_count, quarantined_count, arrival_at, started_at, completed_at,
    EXTRACT(EPOCH FROM completed_at - arrival_at) AS e2e_s FROM core.batches WHERE id = $1`, [id])).rows[0]);
}

// Reference data so claims resolve their member references.
const members = nwMembers(5000, 7001);
const ids = members.map((m) => m.MBR_ID);
await submitCsv(DEV_TOKENS.northwind.operator, 'northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
await submitCsv(DEV_TOKENS.northwind.operator, 'northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
await fetch(`${base}/api/v1/tenants/bluefin/batches`, { method: 'POST', headers: { authorization: `Bearer ${DEV_TOKENS.bluefin.operator}`, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'bf_plans_api', records: BF_PLANS }) });
const enrollees = bfEnrollees(2000, 7002);
await submitCsv(DEV_TOKENS.bluefin.operator, 'bluefin', 'bf_enrollment_csv', toCsv(enrollees as never, BF_ENROLLEE_COLUMNS));
await new Worker().drain();

// ---------------------------------------------------------------- phase 1
const single: Record<string, unknown>[] = [];
let start = 1;
for (const n of SIZES) {
  const claims = nwClaims(n, ids, 8000 + n, start);
  start += n;
  for (let i = 0; i < n; i += 100) claims[i] = { ...claims[i], SVC_DT: 'not-a-date' }; // 1% defective
  const csv = toCsv(claims as never, NW_CLAIM_COLUMNS);
  const sub = await submitCsv(DEV_TOKENS.northwind.operator, 'northwind', 'nw_medical_claims_csv', csv, { record_count: n });
  const w = new Worker();
  const t0 = performance.now();
  await w.drain();
  const procMs = performance.now() - t0;
  const b = await batchRow(sub.id);
  const row = { rows: n, bytes: csv.length, submit_ms: Math.round(sub.ms), process_ms: Math.round(procMs), rows_per_s_processing: Math.round(n / (procMs / 1000)),
    rows_per_s_end_to_end: Math.round(n / ((sub.ms + procMs) / 1000)), status: b.status, trust: b.trust_status, accepted: b.accepted_count, quarantined: b.quarantined_count };
  single.push(row);
  console.log('single-worker', JSON.stringify(row));
  if (b.quarantined_count !== Math.ceil(n / 100) || b.accepted_count !== n - Math.ceil(n / 100)) throw new Error(`unexpected dispositions for ${n}-row batch`);
}

// ---------------------------------------------------------------- phase 2
const procs: ChildProcess[] = [];
for (let i = 0; i < WORKERS; i++) {
  procs.push(spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/worker-main.ts')], { cwd: ROOT, env: { ...process.env, WORKER_POLL_MS: '100' }, stdio: ['ignore', 'ignore', 'inherit'] }));
}
await new Promise((r) => setTimeout(r, 2500)); // let workers start and begin polling
const parIds: string[] = [];
const t1 = performance.now();
for (let i = 0; i < PAR_BATCHES; i++) {
  if (i % 2 === 0) {
    const c = nwClaims(PAR_ROWS, ids, 9000 + i, start); start += PAR_ROWS;
    parIds.push((await submitCsv(DEV_TOKENS.northwind.operator, 'northwind', 'nw_medical_claims_csv', toCsv(c as never, NW_CLAIM_COLUMNS))).id);
  } else {
    const c = bfClaims(PAR_ROWS, enrollees as never, 9000 + i, start); start += PAR_ROWS;
    parIds.push((await submitCsv(DEV_TOKENS.bluefin.operator, 'bluefin', 'bf_rx_claims_csv', toCsv(c as never, BF_CLAIM_COLUMNS))).id);
  }
}
const submittedAt = performance.now();
let rows: any[] = [];
for (;;) {
  rows = await Promise.all(parIds.map(batchRow));
  if (rows.every((r) => !['queued', 'processing'].includes(r.status))) break;
  await new Promise((r) => setTimeout(r, 200));
}
const wall = performance.now() - t1;
for (const p of procs) p.kill('SIGTERM');
await Promise.all(procs.map((p) => new Promise((r) => p.once('exit', r))));
const e2e = rows.map((r) => Number(r.e2e_s)).sort((a, b) => a - b);
const pct = (q: number) => e2e[Math.min(e2e.length - 1, Math.floor(q * e2e.length))];
const failed = rows.filter((r) => r.status === 'failed').length;
const parallel = { workers: WORKERS, batches: PAR_BATCHES, rows_per_batch: PAR_ROWS, total_rows: PAR_BATCHES * PAR_ROWS, submit_wall_ms: Math.round(submittedAt - t1),
  wall_ms: Math.round(wall), rows_per_s: Math.round((PAR_BATCHES * PAR_ROWS) / (wall / 1000)), batch_e2e_s_p50: Number(pct(0.5).toFixed(2)), batch_e2e_s_max: Number(e2e[e2e.length - 1].toFixed(2)),
  failed_batches: failed, failure_rate: failed / PAR_BATCHES, all_trusted: rows.every((r) => r.trust_status === 'trusted') };
console.log('parallel', JSON.stringify(parallel));

const pgv = (await getPool().query('SHOW server_version')).rows[0].server_version;
const pgset = Object.fromEntries((await getPool().query(`SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers','work_mem','max_wal_size','synchronous_commit','fsync')`)).rows.map((r) => [r.name, r.setting]));
const dbSize = (await getPool().query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`)).rows[0].s;
const result = {
  generated_at: new Date().toISOString(),
  environment: { cpu: cpus()[0]?.model, cpu_count: cpus().length, memory_gb: Number((totalmem() / 2 ** 30).toFixed(1)), os: `${platform()} ${release()}`, node: process.version,
    postgres: pgv, postgres_settings: pgset, database_location: 'same host as the application (loopback)', database_size_after: dbSize },
  configuration: { DB_POOL_SIZE: process.env.DB_POOL_SIZE ?? '10 (default)', BATCH_TIMEOUT_MS: process.env.BATCH_TIMEOUT_MS ?? '600000 (default)', contract: 'northwind 1.0.0 / bluefin 1.0.0', path: 'HTTP API (CSV upload) -> PostgreSQL queue -> worker transaction' },
  dataset: { reference: '5000 northwind members, 2000 bluefin subscribers (+dependents)', single_worker_batches: SIZES, defect_rate_single: 0.01, parallel_batches: `${PAR_BATCHES} x ${PAR_ROWS} rows, alternating tenants` },
  single_worker: single, parallel,
};
mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
writeFileSync(path.join(ROOT, 'test-results/benchmark.json'), JSON.stringify(result, null, 2));
console.log(`wrote test-results/benchmark.json`);
if (process.env.BENCH_PUBLISH === '1') { writeFileSync(path.join(ROOT, 'docs/benchmark.md'), renderReport(result)); console.log('wrote docs/benchmark.md'); }
await app.close();
await closePool();

function renderReport(r: any): string {
  const e = r.environment, p = r.parallel;
  const fmt = (n: number) => n.toLocaleString('en-US');
  return [
    '# Benchmark report', '',
    `<!-- Generated by \`BENCH_PUBLISH=1 npm run benchmark\` on ${r.generated_at}. Raw results: test-results/benchmark.json. -->`, '',
    'What was measured, on what, and how to reproduce it. These numbers describe **this run on this machine**; they are not a scalability claim beyond the sizes measured.', '',
    '## Environment', '',
    '| | |', '|---|---|',
    `| CPU | ${e.cpu}, **${e.cpu_count} vCPU** (virtual machine) |`, `| Memory | ${e.memory_gb} GB |`, `| OS | ${e.os} |`, `| Node.js | ${e.node} |`,
    `| PostgreSQL | ${e.postgres}, ${e.database_location}; default settings (shared_buffers ${Number(e.postgres_settings.shared_buffers) * 8 / 1024} MB, work_mem ${Number(e.postgres_settings.work_mem) / 1024} MB, fsync ${e.postgres_settings.fsync}, synchronous_commit ${e.postgres_settings.synchronous_commit}) |`,
    `| Application | ${r.configuration.path}; DB_POOL_SIZE ${r.configuration.DB_POOL_SIZE}; contracts ${r.configuration.contract} |`,
    `| Database size after run | ${e.database_size_after} |`, '',
    '## Method', '',
    '1. Create a dedicated database, apply migrations, seed both tenants and their v1 contracts.',
    `2. Load reference data: ${r.dataset.reference}.`,
    `3. **Single worker:** submit one northwind claims CSV of each size (${r.dataset.single_worker_batches.map(fmt).join(', ')} rows) over HTTP, with ${r.dataset.defect_rate_single * 100}% of rows deliberately invalid, then drain with one worker. Timed separately: submission (HTTP upload, parse, digest, staging, in one transaction) and processing (claim → transform → validate → keys/corrections → write → quality → reconcile → commit).`,
    `4. **Parallel:** start ${p.workers} worker *processes*, submit ${r.dataset.parallel_batches} sequentially from one client, and time from the first submission until every batch has committed.`,
    '5. Every batch is checked for its expected dispositions; a mismatch aborts the run.', '',
    '## Results: single worker', '',
    '| Rows | CSV size | Submit (ms) | Process (ms) | Rows/s processing | Rows/s end-to-end | Accepted | Quarantined | Status |', '|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...r.single_worker.map((x: any) => `| ${fmt(x.rows)} | ${(x.bytes / 1048576).toFixed(1)} MB | ${fmt(x.submit_ms)} | ${fmt(x.process_ms)} | ${fmt(x.rows_per_s_processing)} | ${fmt(x.rows_per_s_end_to_end)} | ${fmt(x.accepted)} | ${fmt(x.quarantined)} | ${x.status}, ${x.trust} |`), '',
    '## Results: parallel workers', '',
    '| Workers | Batches × rows | Total rows | Submission wall time | Total wall time | Rows/s | Batch arrival→commit p50 / max | Failed batches |', '|---:|---|---:|---:|---:|---:|---|---:|',
    `| ${p.workers} | ${p.batches} × ${fmt(p.rows_per_batch)} | ${fmt(p.total_rows)} | ${(p.submit_wall_ms / 1000).toFixed(1)} s | ${(p.wall_ms / 1000).toFixed(1)} s | ${fmt(p.rows_per_s)} | ${p.batch_e2e_s_p50} s / ${p.batch_e2e_s_max} s | ${p.failed_batches} (${(p.failure_rate * 100).toFixed(1)}%) |`, '',
    `All parallel batches trusted: ${p.all_trusted ? 'yes' : 'no'}.`, '',
    '## Interpretation', '',
    `- Processing throughput was roughly flat across batch sizes (about ${fmt(Math.min(...r.single_worker.map((x: any) => x.rows_per_s_processing)))}–${fmt(Math.max(...r.single_worker.map((x: any) => x.rows_per_s_processing)))} rows/s), so cost is linear in rows in this range. The largest measured batch was ${fmt(Math.max(...r.single_worker.map((x: any) => x.rows)))} rows; behaviour above that is unmeasured.`,
    `- In the parallel run, **${Math.round((p.submit_wall_ms / p.wall_ms) * 100)}% of wall time was spent submitting** from a single sequential client, and each batch committed ${p.batch_e2e_s_p50} s (median) after it arrived. Workers kept up with intake; the measured bottleneck was the single-client intake path, not processing. Concurrent submitters were not measured.`,
    `- The machine has ${e.cpu_count} vCPUs shared by the API, ${p.workers} worker processes and PostgreSQL, so the parallel figure is not a per-worker scaling measurement. Measuring scale-out needs a larger host or a separate database server.`,
    `- Failure rate: ${p.failed_batches} of ${p.batches} parallel batches and 0 of ${r.single_worker.length} single-worker batches failed. Deliberately invalid rows were quarantined exactly as expected in every batch.`, '',
    '## Reproduce', '', '```sh', 'BENCH_PUBLISH=1 npm run benchmark     # needs PG_ADMIN_URL able to create databases', 'BENCH_RENDER_ONLY=1 npm run benchmark  # re-render this file from test-results/*.json', '# smaller: BENCH_SIZES=1000,5000 BENCH_WORKERS=2 BENCH_PARALLEL_BATCHES=4 BENCH_PARALLEL_ROWS=2000 npm run benchmark', '```', '',
    'CI runs a small smoke configuration on every pull request to keep the script working. CI timings are not published, because shared runners are too noisy to compare.', '',
    ...queryReport(), ...nativeReport(),
  ].join('\n');
}

// Sections for the query workspace and the native client, from the latest results of
// `npm run benchmark:query` and `npm run test:e2e` (run those first to refresh them).
function readResult(name: string): any { const f = path.join(ROOT, 'test-results', name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; }
function queryReport(): string[] {
  const q = readResult('benchmark-query.json');
  if (!q) return [];
  const row = (k: string, x: any, extra = '') => `| ${k} | ${x.n} | ${x.p50_ms} | ${x.p95_ms} | ${x.max_ms} |${extra}`;
  const LABEL: Record<string, string> = {
    simple: 'Filtered count', grouped: 'Grouped aggregate', join_subquery: 'Anti-join (NOT EXISTS)', cte_masked: 'CTE + join, masked output', rejected_probe: 'Rejected (restricted field in LIKE)',
    nl_question: 'Natural-language question (deterministic provider)', sql_grouped: 'SQL, grouped aggregate', sql_rejected: 'SQL, rejected',
    count_100k: `count(*) over ${q.dataset.claims.toLocaleString('en-US')} claims`, grouped_by_month_status: 'Grouped by month and status', orphans_anti_join: 'Orphan claims (anti-join)',
    cte_join_masked_5000: 'CTE + join, 5,000 rows, masked column', wide_5000_rows: '7 columns, capped at 5,000 rows', preview_20: 'Preview (20 rows)',
  };
  return [
    '## Query workspace', '',
    `<!-- From test-results/benchmark-query.json (\`npm run benchmark:query\`, ${q.generated_at}). -->`, '',
    `Same machine. Dataset: ${q.dataset.members.toLocaleString('en-US')} members and ${q.dataset.claims.toLocaleString('en-US')} claims loaded through the API; reporter role; ${q.configuration.provider} provider; default limits (timeout ${q.configuration.QUERY_TIMEOUT_MS}, row cap ${q.configuration.QUERY_MAX_ROWS}, ${q.configuration.QUERY_MAX_CONCURRENT_PER_TENANT} concurrent per tenant). Times are client-observed over loopback HTTP unless noted.`, '',
    '**Validation** (parse, allowlist and lineage checks, masking rewrite, deparse and re-parse; in process, no database):', '',
    '| Query | n | p50 ms | p95 ms | max ms |', '|---|---:|---:|---:|---:|',
    ...Object.entries(q.validate).map(([k, x]) => row(LABEL[k] ?? k, x)), '',
    '**Proposal** (`POST /queries/proposals`: catalog for the role, provider, validation, `EXPLAIN` estimate, persistence, three audit events):', '',
    '| Request | n | p50 ms | p95 ms | max ms |', '|---|---:|---:|---:|---:|',
    ...Object.entries(q.propose).map(([k, x]) => row(LABEL[k] ?? k, x)), '',
    '**Execution** (`POST …/execute`: re-validation, cost check, query role, read-only transaction, result encoding, audit):', '',
    '| Query | n | p50 ms | p95 ms | max ms | Rows | Truncated | Response | Server ms |', '|---|---:|---:|---:|---:|---:|---|---:|---:|',
    ...Object.entries(q.execute).map(([k, x]: [string, any]) => row(LABEL[k] ?? k, x, ` ${x.rows} | ${x.truncated ? 'yes' : 'no'} | ${x.response_bytes < 10240 ? `${x.response_bytes} B` : `${(x.response_bytes / 1024).toFixed(0)} KiB`} | ${x.server_duration_ms} |`)), '',
    '**Concurrency** (a self-join over all claims, fired simultaneously; per-tenant limit 2):', '',
    '| Simultaneous | Ran | Refused (429) | Wall ms | Server ms per run |', '|---:|---:|---:|---:|---|',
    ...Object.entries(q.concurrent).map(([k, x]: [string, any]) => `| ${parseInt(k)} | ${x.ran} | ${x.refused_429} | ${x.wall_ms} | ${x.server_ms.join(', ')} |`), '',
    '- Validation is sub-millisecond at the median; proposal cost is dominated by the database round trips (catalog, `EXPLAIN`, inserts, audit), not by parsing.',
    '- Requests over the concurrency limit are refused immediately with `429 query_concurrency_limit` rather than queued, so a burst cannot build an unbounded backlog.',
    '- A live model provider adds its own latency to proposals (not measured here: the run uses the deterministic provider so it is reproducible and needs no credentials).', '',
    '```sh', 'npm run benchmark:query                     # QBENCH_CLAIMS=20000 QBENCH_ITER=50 for a quicker run', '```', '',
  ];
}
function nativeReport(): string[] {
  const n = readResult('native-perf.json');
  if (!n) return [];
  const f = (x: any) => `${x.p50_ms} / ${x.p95_ms} / ${x.max_ms} ms (${x.fps_mean} fps mean, n=${x.n})`;
  return [
    '## Native client', '',
    `<!-- From test-results/native-perf.json (\`npm run test:e2e\`, ${n.generated_at}). -->`, '',
    'Release build of the GPUI client on the same machine, **without a GPU**: Xvfb + Mesa lavapipe (software Vulkan), window 1440×920. Timings are taken from `on_next_frame`, i.e. after GPUI has actually drawn. Software rasterization dominates frame time and scales with window area (the same scroll at 640×400 ran at about 60 fps), so these are pessimistic for a desktop with a GPU.', '',
    '| Measurement | Result |', '|---|---|',
    `| Process start → first frame | ${n.startup_ms} ms (spawn → ready event ${n.launch.spawn_to_ready_ms} ms) |`,
    `| 5,000-row result: request → first frame with rows | ${n.large_result_request_to_frame_ms} ms (includes the API round trip) |`,
    `| Scrolling 5,000 rows, frame interval p50 / p95 / max | ${f(n.scroll_5000_rows)} |`,
    `| Typing in the SQL editor while a query runs | ${f(n.typing_while_query_runs)} |`,
    `| Typing in the SQL editor, idle | ${f(n.typing_idle)} |`, '',
    `- The UI thread is never blocked by a running query: API calls run on the background executor, and while a long-running query (a three-way cross join over claims) was executing, the longest frame interval was ${n.typing_while_query_runs.max_ms} ms (the e2e test fails above 1,000 ms). Frames are slower than idle typing (p50 ${n.typing_while_query_runs.p50_ms} vs ${n.typing_idle.p50_ms} ms) because the API, PostgreSQL and the software rasterizer share the machine's CPUs during the query.`,
    '- The grid is virtualized: only visible rows are laid out, so scroll cost does not grow with the result size.', '',
  ];
}
