// End-to-end demonstration against a RUNNING Clearline (API + worker), over
// HTTP only — no database access, no manual editing. Usage:
//   npm run demo                       (API at http://localhost:8080)
//   CLEARLINE_URL=http://host:8080 npm run demo
//   npm run demo -- --with-migration   (also publishes northwind v2 for approval in the native client)
//   npm run demo -- --skip-query-demo  (leave out the query workspace and field policy demonstration)
//   npm run demo -- --skip-analytics-demo (leave out saved queries, schedules, analyses and delivery)
//
// It loads the reference dataset (valid rows, defects, corrections, an exact
// redelivery, a non-reconciling batch, two tenants), waits for processing, then
// prints what the platform reports next to ground truth from the generator.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReferenceDataset, type SubmitApi } from '../synthetic/reference-dataset.js';
import { DEV_TOKENS } from './seed.js';
import { analyticsClaims, ANOMALY_DATE } from '../synthetic/analytics-dataset.js';
import { nwMembers, toCsv, NW_CLAIM_COLUMNS } from '../synthetic/generator.js';

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
if (!process.argv.includes('--skip-analytics-demo')) mismatches += await analyticsDemo();

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

// ------------------------------------------------------------------ saved analytics
// Save a natural-language-generated query, run it and check it, schedule it, add anomaly
// detection and forecasting, run the schedule and inspect insights, deliver a notification and a
// summary, read the audit trail, and show the safe failure after the identity is revoked.
// Offline and deterministic: deterministic SQL provider, built-in algorithms, file email outbox.
async function analyticsDemo(): Promise<number> {
  let bad = 0;
  const T = '/api/v1/tenants/northwind';
  const as = (token: string) => ({
    get: async (u: string) => (await call(token, 'GET', `${T}${u}`)),
    post: async (u: string, b: unknown = {}) => (await call(token, 'POST', `${T}${u}`, b)),
  });
  const reporter = as(DEV_TOKENS.northwind.reporter);
  const admin = as(DEV_TOKENS.northwind.admin);
  const must = (r: { status: number; body: any }, what: string) => { if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
  const waitRun = async (who: ReturnType<typeof as>, id: string) => {
    for (let i = 0; i < 240; i++) {
      const r = must(await who.get(`/analytics/runs/${id}`), 'run');
      if (!['queued', 'running', 'delivering'].includes(r.run.status)) return r;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('the run did not finish within 120 s — is the worker (with its scheduler) running?');
  };
  line('\n=== Saved analytics: saved queries, schedules, ML analyses and delivery ===');
  const { rows, truth } = analyticsClaims(nwMembers(150, 1).map((m) => m.MBR_ID));
  must(await submitter(DEV_TOKENS.northwind.operator).csv('northwind', 'nw_medical_claims_csv', toCsv(rows as never, NW_CLAIM_COLUMNS)), 'analytics claims');
  await waitIdle('northwind', DEV_TOKENS.northwind.operator);
  line(`Loaded ${truth.claims} more claims over ${truth.from}..${truth.to} (weekly pattern; one unusual day planted on ${ANOMALY_DATE}).`);

  // 1. Save a natural-language-generated query.
  const question = 'Daily paid claim amounts, claim counts and average payment for the last 180 days.';
  const prop = must(await reporter.post('/queries/proposals', { question }), 'proposal');
  const saved = must(await reporter.post('/saved-queries', { name: 'Daily paid claims', proposal_id: prop.id, purpose: 'Alert on unusual payment days', category: 'finance', tags: ['claims', 'daily'] }), 'save');
  line(`\n1. "${question}"\n   -> deterministic provider proposal ${prop.id.slice(0, 8)} (validated=${prop.validation.ok}), saved as "${saved.name}" v${saved.version}; output ${saved.current.output_schema.map((c: any) => `${c.name}:${c.type}`).join(', ')}`);

  // 2. Run it and check the result against an independently written query.
  const ex = must(await reporter.post(`/saved-queries/${saved.id}/execute`, { mode: 'run' }), 'execute');
  const day = ex.rows.find((r: unknown[]) => r[0] === ANOMALY_DATE);
  const ind = must(await reporter.post('/queries/proposals', { sql: `SELECT sum(paid_amount) AS paid FROM claim WHERE service_date = '${ANOMALY_DATE}' AND _trust_status = 'trusted'` }), 'independent');
  const indRun = must(await reporter.post(`/queries/proposals/${ind.id}/execute`, { mode: 'run' }), 'independent run');
  const ok2 = day && String(day[1]) === String(indRun.rows[0][0]);
  if (!ok2) bad++;
  line(`2. Ran it: ${ex.row_count} days in ${ex.duration_ms} ms; ${ANOMALY_DATE} paid ${day?.[1]} vs independent SQL ${indRun.rows[0][0]} ${ok2 ? 'match' : 'MISMATCH'}`);

  // 3. Configure recurring execution with destinations.
  const inbox = must(await admin.post('/analytics/destinations', { name: 'Analyst inbox', kind: 'in_app', config: { recipients: ['$owner'] }, notify_on: 'always' }), 'inbox');
  const mail = must(await admin.post('/analytics/destinations', { name: 'Finance email', kind: 'email', config: { to: ['finance@example.org'] }, notify_on: 'anomaly', content: 'summary_with_csv' }), 'email');
  const sched = must(await reporter.post('/analytics/schedules', { query_id: saved.id, name: 'Daily 06:00 New York', recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-11-02T06:00',
    timezone: 'America/New_York', run_as_role: 'reporter', destination_ids: [inbox.id, mail.id] }), 'schedule');
  const pv = must(await reporter.post('/analytics/schedules/preview', { recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-31T06:00', timezone: 'America/New_York', count: 3 }), 'preview');
  line(`3. Schedule "${sched.name}": ${sched.description}, runs as ${sched.run_as.actor} (${sched.run_as.role}), next ${sched.next_run_at}; across the 1 Nov DST change: ${pv.next.join(', ')}`);

  // 4. Enable anomaly detection and forecasting (a new version). The version also replaces
  // "the last 180 days" by typed date parameters whose defaults are the generated window, so
  // the demonstration gives the same result whatever today's date is.
  const pinned = saved.current.sql.replace('c.service_date >= current_date - 180', 'c.service_date >= :start AND c.service_date <= :end');
  if (pinned === saved.current.sql) throw new Error('unexpected SQL from the deterministic provider');
  const v2 = must(await reporter.post(`/saved-queries/${saved.id}/versions`, { change_note: 'Typed date window; anomaly detection and a two-week forecast', sql: pinned,
    parameters: [{ name: 'start', type: 'date', label: 'From', default: '2026-04-04' }, { name: 'end', type: 'date', label: 'To', default: '2026-09-30' }], analyses: [
    { type: 'anomaly', key: 'daily-anomalies', label: 'Daily anomalies', algorithm: 'anomaly.rolling_mad', time_column: 'day', metrics: ['paid', 'claims'], grain: 'day', period: 7 },
    { type: 'forecast', key: 'daily-forecast', label: 'Two-week forecast', algorithm: 'forecast.auto', time_column: 'day', metric: 'paid', grain: 'day', horizon: 14, period: 7, missing: 'zero' },
  ] }), 'version');
  line(`4. Version ${v2.version}: parameters ${v2.current.parameters.map((x: any) => `:${x.name} ${x.type} = ${x.default}`).join(', ')}; analyses ${v2.current.analyses.map((a: any) => `${a.key} (${a.algorithm})`).join(', ')}`);

  // 5. Run the schedule now (same identity and destinations) and inspect its insights.
  const q5 = must(await reporter.post(`/analytics/schedules/${sched.id}/run`), 'run now');
  const run = await waitRun(reporter, q5.run_id);
  const top = run.insights.find((i: any) => i.kind === 'anomaly' && i.title.includes(ANOMALY_DATE));
  const ok5 = !!top;
  if (!ok5) bad++;
  line(`5. Run ${run.run.id.slice(0, 8)}: ${run.run.status} (query ${run.run.query_status}, analyses ${run.run.analysis_status}, delivery ${run.run.delivery_status}); query ${run.run.timings.query_ms} ms, analyses ${run.run.timings.analysis_ms} ms`);
  for (const i of run.insights.slice(0, 4)) line(`   [${i.severity}] ${i.title}\n          ${i.body.slice(0, 260)}${i.body.length > 260 ? '…' : ''}`);
  line(`   planted anomaly on ${ANOMALY_DATE} detected: ${ok5 ? 'yes' : 'NO'}`);

  // 6. Notification and result summary.
  const notes = must(await reporter.get('/notifications'), 'notifications').items.filter((n: any) => n.run_id === run.run.id);
  line(`6. Deliveries: ${run.deliveries.map((d: any) => `${d.destination} (${d.kind}) ${d.status}${d.last_error ? ` — ${d.last_error}` : ''}`).join('; ')}`);
  for (const n of notes) line(`   in-app for the analyst: [${n.kind}] ${n.title}`);

  // 7. Audit trail of the run.
  const audit = must(await admin.get('/audit?limit=500'), 'audit').filter((e: any) => e.correlation_id === run.run.id || e.resource === `run:${run.run.id}` || e.details?.run_id === run.run.id);
  line(`7. Audit trail for the run: ${[...new Set(audit.reverse().map((e: any) => `${e.action}:${e.outcome}`))].join(' -> ')}`);

  // 8. Revoke the execution identity: the next run is denied and nothing is delivered.
  const tok = must(await admin.post('/tokens', { name: 'analyst-demo', role: 'reporter' }), 'token');
  const dana = as(tok.token);
  const dq = must(await dana.post('/saved-queries', { name: 'Daily paid (analyst-demo)', proposal_id: must(await dana.post('/queries/proposals', { question }), 'p').id }), 'save');
  const ds = must(await dana.post('/analytics/schedules', { query_id: dq.id, recurrence: { frequency: 'daily', at: '07:00' }, start_local: '2026-11-02T07:00', timezone: 'UTC', run_as_role: 'reporter', destination_ids: [inbox.id] }), 'schedule');
  const first = await waitRun(dana, must(await dana.post(`/analytics/schedules/${ds.id}/run`), 'run').run_id);
  must(await admin.post('/tokens/analyst-demo/revoke'), 'revoke');
  const after = await waitRun(admin, must(await admin.post(`/analytics/schedules/${ds.id}/run`), 'run').run_id);
  const ok8 = first.run.status === 'succeeded' && after.run.status === 'denied' && after.run.error_code === 'identity_revoked';
  if (!ok8) bad++;
  const att = must(await admin.get(`/analytics/schedules/${ds.id}`), 'schedule').attention;
  line(`8. Schedule of token "analyst-demo": ran (${first.run.status}); token revoked; next run ${after.run.status} (${after.run.failure_class}: ${after.run.error_code}), query executed: ${after.run.execution_id ? 'yes' : 'no'}, deliveries: ${after.deliveries.length ? after.deliveries.map((d: any) => `${d.status}${d.last_error_code ? ` (${d.last_error_code})` : ''}`).join(', ') : 'none'}\n   schedule attention: ${att}`);
  return bad;
}

