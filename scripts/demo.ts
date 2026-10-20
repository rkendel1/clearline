// End-to-end demonstration against a RUNNING Clearline (API + worker), over
// HTTP only — no database access, no manual editing. Usage:
//   npm run demo                       (API at http://localhost:8080)
//   CLEARLINE_URL=http://host:8080 npm run demo
//   npm run demo -- --with-migration   (also publishes northwind v2 for approval in the native client)
//   npm run demo -- --skip-query-demo  (leave out the query workspace and field policy demonstration)
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
  line('  Review the plan under Contracts in the native client and approve it signed in with the approver token (cl_dev_northwind_approver).');
}

if (!process.argv.includes('--skip-query-demo')) mismatches += await queryDemo();

line(`\nNative client: npm run native:run -- --url ${process.env.PUBLIC_URL ?? BASE}  (sign in with ${DEV_TOKENS.northwind.operator}, ${DEV_TOKENS.northwind.reporter}, ${DEV_TOKENS.northwind.steward} or ${DEV_TOKENS.northwind.admin}).`);
line(mismatches === 0 ? 'Result: every metric and every checked query result matches ground truth.' : `Result: ${mismatches} figure(s) differ from ground truth.`);
process.exit(mismatches === 0 ? 0 : 1);

// ------------------------------------------------------------------ query workspace and field policy
// The same natural-language request under different roles; an analyst's query checked against
// ground truth; an administrator changes a field's sensitivity; bypass attempts; audit evidence.
async function queryDemo(): Promise<number> {
  let bad = 0;
  const q = (role: keyof typeof DEV_TOKENS.northwind) => ({
    ask: async (question: string) => (await call(DEV_TOKENS.northwind[role], 'POST', '/api/v1/tenants/northwind/queries/proposals', { question })).body,
    sql: async (sqlText: string) => (await call(DEV_TOKENS.northwind[role], 'POST', '/api/v1/tenants/northwind/queries/proposals', { sql: sqlText })).body,
    run: async (id: string) => call(DEV_TOKENS.northwind[role], 'POST', `/api/v1/tenants/northwind/queries/proposals/${id}/execute`, { mode: 'run' }),
  });
  const policy = (role: keyof typeof DEV_TOKENS.northwind, entity: string, field: string, patch: unknown) =>
    call(DEV_TOKENS.northwind[role], 'POST', `/api/v1/tenants/northwind/fields/${entity}/${field}/policy`, patch);
  line('\n=== Query workspace: natural-language SQL under role-aware field policy ===');

  // 1. An authorized analyst generates and executes a query; checked against ground truth.
  const a = await q('reporter').ask('How many claims are there?');
  line(`\n1. Analyst (reporter) asks "How many claims are there?" -> proposal ${a.id.slice(0, 8)}, validated=${a.validation.ok}, executed=${a.executed}`);
  line(`   SQL: ${a.proposed_sql.replace(/\s+/g, ' ')}`);
  const counted = await q('reporter').sql("SELECT count(*) AS claims FROM claim WHERE _trust_status = 'trusted'");
  const cr = (await q('reporter').run(counted.id)).body;
  const ok1 = String(cr.rows[0][0]) === truth.northwind.claims_total;
  if (!ok1) bad++;
  line(`   Edited to count trusted claims and run: ${cr.rows[0][0]} (ground truth ${truth.northwind.claims_total}) ${ok1 ? 'match' : 'MISMATCH'}; ${cr.duration_ms} ms; executed SQL sha256 ${cr.executed_sql_sha256.slice(0, 12)}`);
  const lm = await q('reporter').ask('Show the total paid amount by tenant for the last month.');
  const lmr = (await q('reporter').run(lm.id)).body;
  line(`   "Show the total paid amount by tenant for the last month." -> ${lmr.columns.map((c: { name: string }) => c.name).join(', ')} = ${lmr.rows[0].join(', ')}`);

  // 2. A protected field: configure it, then the same request under four roles.
  const set = await policy('admin', 'member', 'ssn', { sensitive: true, redaction: 'last4', reason: 'Government identifier', unmask_roles: ['admin'], role_access: { operator: 'filter', reporter: 'hidden' } });
  line(`\n2. Admin sets member.ssn: sensitive (last4), operator filter-only, reporter hidden -> HTTP ${set.status}, effective ${JSON.stringify(set.body.effective_access)}`);
  const request = 'List members with their ssn';
  for (const role of ['admin', 'steward', 'operator', 'reporter'] as const) {
    const p = await q(role).ask(request);
    let outcome: string;
    if (p.validation.ok) {
      const r = (await q(role).run(p.id)).body;
      outcome = `ran: first ssn value "${r.rows[0][1]}"${r.columns[1].masked ? ` (redacted by the database: ${r.columns[1].masked})` : ''}`;
    } else outcome = `safe denial: ${p.validation.issues[0].message}`;
    line(`   ${role.padEnd(8)} "${request}" -> ${outcome}`);
  }

  // 3-4. An administrator marks a field sensitive; it becomes redacted in queries and record views.
  const mark = await policy('admin', 'claim', 'provider_npi', { sensitive: true, redaction: 'last4', reason: 'Provider identifiers are restricted by the network contract' });
  line(`\n3. Admin marks claim.provider_npi sensitive (last4) -> HTTP ${mark.status}, ${mark.body.change?.kind} change, version ${mark.body.policy?.version}`);
  const npi = await q('reporter').sql('SELECT claim_id, provider_npi FROM claim ORDER BY claim_id LIMIT 3');
  const nr = (await q('reporter').run(npi.id)).body;
  line(`4. Reporter query: ${nr.rows.map((r: unknown[]) => `${r[0]}=${r[1]}`).join(', ')}`);
  const rec = (await call(DEV_TOKENS.northwind.operator, 'GET', '/api/v1/tenants/northwind/entities/claim/records?limit=2')).body;
  line(`   Operator record view: ${rec.records.map((r: Record<string, unknown>) => `${r.claim_id}=${r.provider_npi}`).join(', ')} (redacted fields: ${JSON.stringify(rec.redacted)})`);
  const lin = (await call(DEV_TOKENS.northwind.operator, 'GET', `/api/v1/tenants/northwind/lineage/claim/${truth.trustedClaimIds[100]}`)).body;
  line(`   Operator lineage of ${lin.key}: provider_npi=${lin.versions[0].values.provider_npi}, raw source RENDERING_NPI=${lin.versions[0].source_row?.mapped_columns?.RENDERING_NPI}`);
  const steward = await policy('steward', 'claim', 'provider_npi', { sensitive: false });
  line(`   Steward tries to remove the sensitivity (a widening) -> HTTP ${steward.status} ${steward.body.error?.code}`);

  // 5. SQL bypass attempts are rejected before anything runs.
  line('\n5. Bypass attempts (as the reporter):');
  for (const attempt of ['SELECT member_id, ssn FROM member', "SELECT count(*) FROM member WHERE ssn LIKE '9%'", 'SELECT * FROM t_bluefin.rx_claim',
    'SELECT token_hash FROM core.api_tokens', 'SELECT claim_id FROM claim; DELETE FROM claim', "SELECT count(*) FROM claim WHERE provider_npi = '1234567890'"]) {
    const p = await q('reporter').sql(attempt);
    const r = await q('reporter').run(p.id);
    line(`   ${attempt.padEnd(58)} -> ${p.validation.issues[0]?.code ?? 'accepted'}; execute HTTP ${r.status}`);
  }

  // 6. Audit evidence: decisions and outcomes, without the sensitive values.
  const audit = (await call(DEV_TOKENS.northwind.admin, 'GET', '/api/v1/tenants/northwind/audit?limit=400')).body as { action: string; outcome: string; details: unknown }[];
  const counts: Record<string, number> = {};
  for (const e of audit.filter((x) => /^(query\.|policy\.)/.test(x.action))) counts[`${e.action}:${e.outcome}`] = (counts[`${e.action}:${e.outcome}`] ?? 0) + 1;
  line('\n6. Audit evidence (query and policy events):');
  for (const [k, n] of Object.entries(counts).sort()) line(`   ${k.padEnd(40)} ${n}`);
  const admin = (await q('admin').sql('SELECT ssn FROM member')).id;
  const originals = (await q('admin').run(admin)).body.rows.map((r: unknown[]) => String(r[0]));
  const leaked = originals.filter((v: string) => JSON.stringify(audit).includes(v)).length;
  if (leaked) bad++;
  line(`   SSN values present in the audit trail: ${leaked} of ${originals.length} ${leaked ? 'LEAK' : '(none: payloads carry ids, hashes, counts and column names only)'}`);
  return bad;
}
