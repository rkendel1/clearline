// Captures real API responses and extracts for docs/examples from a fresh
// database loaded with the reference dataset. `npm run docs:examples`.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'clearline_examples';
process.env.DATABASE_URL = `${process.env.PGHOST_URL ?? 'postgres://clearline:clearline@localhost:5432'}/${DB}`;
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'error';
const { buildServer } = await import('../src/api/server.js');
const { migrate } = await import('../src/platform/migrate.js');
const { closePool } = await import('../src/platform/db.js');
const { Worker } = await import('../src/ingestion/worker.js');
const { seed, DEV_TOKENS } = await import('./seed.js');
const { loadReferenceDataset } = await import('../synthetic/reference-dataset.js');

execFileSync(path.join(ROOT, 'scripts/reset-db.sh'), [DB], { stdio: 'inherit' });
await migrate(); await seed();
const app = await buildServer();
const mk = (token: string) => {
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}`, ...headers } });
    return { status: r.statusCode, body: (r.headers['content-type'] ?? '').toString().includes('json') ? JSON.parse(r.body) : r.body, headers: r.headers };
  };
  return { get: (u: string) => call('GET', u), call,
    csv: (t: string, s: string, b: Buffer, o: { reportedAt?: string; control?: unknown } = {}) => call('POST', `/api/v1/tenants/${t}/batches/csv?source=${s}${o.reportedAt ? `&source_reported_at=${encodeURIComponent(o.reportedAt)}` : ''}`, b, { 'content-type': 'text/csv', ...(o.control ? { 'x-clearline-control': JSON.stringify(o.control) } : {}) }),
    json: (t: string, s: string, records: unknown[], o: { reportedAt?: string; control?: unknown } = {}) => call('POST', `/api/v1/tenants/${t}/batches`, { source: s, records, source_reported_at: o.reportedAt, control: o.control }) };
};
const op = mk(DEV_TOKENS.northwind.operator), rep = mk(DEV_TOKENS.northwind.reporter);
await loadReferenceDataset(op as never, mk(DEV_TOKENS.bluefin.operator) as never);
await new Worker().drain();
const out = path.join(ROOT, 'docs/examples');
mkdirSync(out, { recursive: true });
const save = (f: string, v: unknown) => writeFileSync(path.join(out, f), typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n');
const batches = (await op.get('/api/v1/tenants/northwind/batches')).body;
const untrusted = batches.find((b: { trust_status: string }) => b.trust_status === 'untrusted');
const withEx = batches.find((b: { status: string }) => b.status === 'completed_with_exceptions');
save('batch-untrusted.json', (await op.get(`/api/v1/tenants/northwind/batches/${untrusted.id}`)).body);
save('batch-with-quarantine.json', (await op.get(`/api/v1/tenants/northwind/batches/${withEx.id}`)).body);
save('business-summary.json', (await rep.get('/api/v1/tenants/northwind/reports/business')).body);
const ops = (await rep.get('/api/v1/tenants/northwind/reports/operations')).body;
save('operations-report.json', { ...ops, recent_batches: ops.recent_batches.slice(0, 3) });
save('exception-report.json', (await op.get('/api/v1/tenants/northwind/reports/exceptions')).body);
save('lineage-claim-C000000104.json', (await op.get('/api/v1/tenants/northwind/lineage/claim/C000000104')).body);
save('extract-claims.schema.json', (await rep.get('/api/v1/tenants/northwind/extracts/claims/schema')).body);
const x = await rep.get('/api/v1/tenants/northwind/extracts/claims/csv');
save('extract-claims.sample.csv', String(x.body).split('\n').slice(0, 21).join('\n') + '\n');
save('extract-claims.headers.txt', Object.entries(x.headers).filter(([k]) => k.startsWith('x-clearline')).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');
const el = await rep.get('/api/v1/tenants/northwind/extracts/eligibility/csv');
save('extract-eligibility.sample.csv', String(el.body).split('\n').slice(0, 11).join('\n') + '\n');
save('denied-sensitive-export.json', (await rep.get('/api/v1/tenants/northwind/extracts/eligibility/csv?include_sensitive=true')).body);
save('denied-cross-tenant.json', (await mk(DEV_TOKENS.bluefin.admin).get('/api/v1/tenants/northwind/reports/business')).body);
console.log('wrote docs/examples');
await app.close(); await closePool();
