// End-to-end demonstration against a RUNNING Clearline (API + worker), over
// HTTP only — no database access, no manual editing. Usage:
//   npm run demo                       (API at http://localhost:8080)
//   CLEARLINE_URL=http://host:8080 npm run demo
//   npm run demo -- --with-migration   (also publishes northwind v2 for approval in the dashboard)
//
// It loads the reference dataset (valid rows, defects, corrections, an exact
// redelivery, a non-reconciling batch, two tenants), waits for processing, then
// prints what the platform reports next to ground truth from the generator.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReferenceDataset, type SubmitApi } from '../synthetic/reference-dataset.js';
import { DEV_TOKENS } from './seed.js';

const BASE = (process.env.CLEARLINE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/[\\/]dist$/, '');

async function call(token: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text, headers: res.headers };
}

function submitter(token: string): SubmitApi {
  return {
    csv: (tenant, source, csv, o = {}) => call(token, 'POST', `/api/v1/tenants/${tenant}/batches/csv?source=${source}${o.reportedAt ? `&source_reported_at=${encodeURIComponent(o.reportedAt)}` : ''}`, csv,
      { 'content-type': 'text/csv', ...(o.control ? { 'x-clearline-control': JSON.stringify(o.control) } : {}) }),
    json: (tenant, source, records, o = {}) => call(token, 'POST', `/api/v1/tenants/${tenant}/batches`, { source, records, source_reported_at: o.reportedAt, control: o.control }),
  };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/readyz`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Clearline at ${BASE} did not become ready within 60 s`);
}

async function waitIdle(tenant: string, token: string) {
  for (let i = 0; i < 120; i++) {
    const ops = (await call(token, 'GET', `/api/v1/tenants/${tenant}/reports/operations`)).body;
    if (ops.queue.queued === 0 && ops.queue.processing === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('batches still queued after 60 s — is a worker running? (docker compose ps / npm run dev:worker)');
}

const line = (s = '') => console.log(s);

await waitReady();
const existing = (await call(DEV_TOKENS.northwind.reporter, 'GET', '/api/v1/tenants/northwind/batches?limit=1')).body;
if (Array.isArray(existing) && existing.length) {
  line('This database already contains demo batches. Reset it first (docker compose down -v && docker compose up -d) for a clean, reproducible run.');
  process.exit(2);
}

line(`Clearline demo against ${BASE}`);
line('Loading the reference dataset: northwind (plans, 150 members, 400 claims incl. 3 defective, 25 corrections, 1 exact redelivery, 60 claims with a wrong control count, 120 pharmacy fills) and bluefin (plans, enrollees, 300 rx claims)…');
const truth = await loadReferenceDataset(submitter(DEV_TOKENS.northwind.operator), submitter(DEV_TOKENS.bluefin.operator));
await waitIdle('northwind', DEV_TOKENS.northwind.operator);
await waitIdle('bluefin', DEV_TOKENS.bluefin.operator);

let mismatches = 0;
for (const tenant of ['northwind', 'bluefin'] as const) {
  const biz = (await call(DEV_TOKENS[tenant].reporter, 'GET', `/api/v1/tenants/${tenant}/reports/business`)).body;
  line(`\n${tenant} — business metrics (trusted data only) vs generator truth`);
  for (const m of biz.metrics) {
    const ok = m.value === truth[tenant][m.id];
    if (!ok) mismatches++;
    line(`  ${ok ? 'match   ' : 'MISMATCH'} ${m.id.padEnd(22)} platform ${String(m.value).padStart(12)}   truth ${String(truth[tenant][m.id]).padStart(12)}${m.trusted ? '' : `   (${m.value_including_untrusted} incl. untrusted)`}`);
  }
}

const ops = (await call(DEV_TOKENS.northwind.operator, 'GET', '/api/v1/tenants/northwind/reports/operations')).body;
line('\nnorthwind — batches: ran vs trusted');
for (const b of [...ops.recent_batches].reverse()) {
  line(`  ${b.id.slice(0, 8)}  ${b.source_id.padEnd(22)} ran=${b.status.padEnd(26)} trust=${b.trust_status.padEnd(9)} rows=${b.received_count} accepted=${b.accepted_count} quarantined=${b.quarantined_count}${b.trust_reasons?.length ? `\n            why: ${b.trust_reasons.join('; ')}` : ''}`);
}
line(`  duplicate submissions ignored: ${ops.totals.duplicate_submissions}`);

const untrusted = ops.recent_batches.find((b: { trust_status: string }) => b.trust_status === 'untrusted');
if (untrusted) {
  const d = (await call(DEV_TOKENS.northwind.operator, 'GET', `/api/v1/tenants/northwind/batches/${untrusted.id}`)).body;
  line('\nWhy the untrusted batch is held back:');
  for (const r of d.reconciliation.filter((x: { status: string }) => x.status === 'failed')) line(`  ${r.check_id}: ${r.explanation}`);
}
const exc = (await call(DEV_TOKENS.northwind.operator, 'GET', '/api/v1/tenants/northwind/reports/exceptions')).body;
line('\nQuarantined records (actionable reasons):');
for (const q of exc.quarantined) line(`  row ${q.source_row} of ${q.source_id}: ${q.reasons.map((r: { message: string }) => r.message).join('; ')}`);

const lin = (await call(DEV_TOKENS.northwind.operator, 'GET', `/api/v1/tenants/northwind/lineage/claim/${truth.trustedClaimIds[100]}`)).body;
line(`\nLineage of claim ${lin.key}: ${lin.versions.map((v: { record_id: number; contract_version: string; is_current: boolean; source_row: { row_number: number } }) => `record ${v.record_id} (contract ${v.contract_version}, source row ${v.source_row?.row_number}${v.is_current ? ', current' : ', superseded'})`).join(' -> ')}`);

const g = await call(DEV_TOKENS.bluefin.admin, 'GET', '/api/v1/tenants/northwind/reports/business');
const s = await call(DEV_TOKENS.northwind.reporter, 'GET', '/api/v1/tenants/northwind/extracts/eligibility/csv?include_sensitive=true');
line(`\nPrivacy: bluefin admin reading northwind -> HTTP ${g.status} ${g.body.error?.code}; northwind reporter exporting sensitive fields -> HTTP ${s.status} ${s.body.error?.code}. Both audited.`);

if (process.argv.includes('--with-migration')) {
  const v2 = JSON.parse(readFileSync(path.join(ROOT, 'contracts/northwind/v2.json'), 'utf8'));
  const p = await call(DEV_TOKENS.northwind.admin, 'POST', '/api/v1/tenants/northwind/contracts', v2);
  line(`\nContract evolution: published northwind 2.0.0 -> HTTP ${p.status}, ${p.body.lifecycle}, migration ${p.body.migration_id} (${p.body.plan?.changes.filter((c: { classification: string }) => c.classification === 'breaking').length} breaking changes).`);
  line('  Review the plan under Contracts in the dashboard and approve it signed in with the approver token (cl_dev_northwind_approver).');
}

line(`\nDashboard: ${process.env.DASHBOARD_URL ?? BASE}/  — sign in with ${DEV_TOKENS.northwind.operator} (operator) or ${DEV_TOKENS.northwind.reporter} (reporter).`);
line(mismatches === 0 ? 'Result: every metric matches ground truth.' : `Result: ${mismatches} metric(s) differ from ground truth.`);
process.exit(mismatches === 0 ? 0 : 1);
