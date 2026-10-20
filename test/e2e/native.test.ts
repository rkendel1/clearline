// End-to-end: the native GPUI client against the real API, database and worker.
//
//   Scenario J (native half): the numbers a person sees in the native overview equal
//     ground truth and independent SQL, for both tenants (formerly test/e2e/dashboard.test.ts).
//   Scenario O: launch the native client, authenticate as several roles, navigate,
//     submit a natural-language query, inspect and edit the proposal, execute it,
//     verify restricted fields stay protected, change a field's sensitivity as an
//     administrator, and verify redaction in the workspace and detail views.
//   Measurements: startup, large-result rendering, scrolling and typing frame times
//     (test-results/native-perf.json, reported in docs/benchmark.md).
//
// Needs the built client (npm run native:build) and an X display (Xvfb is started if
// DISPLAY is unset) with a Vulkan driver (lavapipe/llvmpipe works). Screenshots of the
// real window are written to test-results/native/.

process.env.QUERY_MAX_COST = '1000000000000';
process.env.QUERY_TIMEOUT_MS = '15000';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, ROOT, type Ctx } from '../helpers/harness.js';
import { Display, NativeApp, NATIVE_BIN } from '../helpers/native.js';
import { loadReferenceDataset, type Truth } from '../../synthetic/reference-dataset.js';
import { nwMembers } from '../../synthetic/generator.js';
import { maskValue } from '../../src/policy/mask.js';

let ctx: Ctx;
let truth: Truth;
let base: string;
const display = new Display();
let app: NativeApp;
const SSNS = nwMembers(150, 1001).map((m) => m.SSN);
const perf: Record<string, unknown> = {};

before(async () => {
  assert.ok(NATIVE_BIN, 'build the native client first: npm run native:build');
  ctx = await setup();
  truth = await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  await display.start();
  app = new NativeApp(display, base);
  perf.launch = await app.start();
});
after(async () => { await app?.stop(); display.stop(); await teardown(ctx); });

const view = (s: any) => s.view;
const noSsn = (v: unknown, typed: string[] = []) => { const t = JSON.stringify(v); for (const s of SSNS) if (!typed.includes(s)) assert.ok(!t.includes(s), 'no SSN in what the client shows'); };

test('Scenario J (native): the overview shows ground truth for both tenants; roles see only their views', async () => {
  const lines: string[] = [];
  for (const tenant of ['northwind', 'bluefin'] as const) {
    const s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS[tenant].reporter });
    assert.equal(s.signed_in, true);
    assert.equal(s.tenant, tenant);
    const shown = Object.fromEntries(view(s).metrics.map((m: any) => [m.id, m]));
    for (const [id, want] of Object.entries(truth[tenant])) {
      assert.equal(shown[id].value, want, `${tenant}.${id}`);
      assert.equal(String(shown[id].shown).replace(/[$,]/g, ''), want, `${tenant}.${id} as displayed (${shown[id].shown})`);
    }
    const t = view(s).totals;
    const q = (await sql(`SELECT count(*)::int batches, count(*) FILTER (WHERE status IN ('completed','completed_with_exceptions'))::int succeeded,
        count(*) FILTER (WHERE trust_status = 'trusted')::int trusted, count(*) FILTER (WHERE trust_status = 'untrusted')::int untrusted FROM core.batches WHERE tenant_id = $1`, [tenant]))[0];
    for (const k of Object.keys(q)) assert.equal(t[k], q[k], `${tenant} ${k}`);
    if (tenant === 'bluefin') {
      assert.ok(!s.nav.includes('Lineage') && !s.nav.includes('Records'), 'a reporter gets no record-level views');
      assert.ok(!JSON.stringify(view(s)).includes('claims_total'), 'no northwind metrics in the bluefin view');
    }
    app.screenshot(`01-overview-${tenant}-reporter`);
    lines.push(`${tenant} reporter: ${Object.keys(truth[tenant]).length} metric tiles display exactly the ground-truth values; ran/trusted tiles equal SQL (${q.batches} batches, ${q.trusted} trusted, ${q.untrusted} not trusted).`);
    await app.cmd({ cmd: 'sign_out' });
  }
  // The untrusted batch is shown as ran-but-not-trusted, and its detail explains why.
  const op = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.operator });
  const untrusted = view(op).recent_batches.filter((b: any) => b.trust === 'untrusted');
  assert.equal(untrusted.length, 1);
  assert.equal(untrusted[0].status, 'completed');
  const b = await app.cmd({ cmd: 'nav', view: 'batch', arg: untrusted[0].id });
  const check = view(b).reconciliation.find((r: any) => r.check_id === 'source_control_count');
  assert.equal(check.status, 'failed');
  assert.match(check.explanation, /Sender declared 61 rows but 60 arrived/);
  app.screenshot('02-batch-untrusted-operator');
  lines.push('operator: the untrusted batch appears as Ran + Not trusted; its detail shows the failed source_control_count check and its explanation.');
  await app.cmd({ cmd: 'sign_out' });
  const ap = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.approver });
  assert.deepEqual(ap.nav, ['Contracts']);
  assert.equal(ap.route, 'contracts');
  app.screenshot('03-approver-contracts');
  lines.push('approver: lands on Contracts, the only navigation item; no data views.');
  await app.cmd({ cmd: 'sign_out' });
  evidence('Scenario J — Reporting correctness (native GPUI client)', lines);
});

test('Scenario O: native workflow — NL query, edit, run, restricted fields, sensitivity change, redaction', async () => {
  const lines: string[] = [];
  const executions = async () => Number((await sql(`SELECT count(*) AS n FROM core.query_executions`))[0].n);

  // 1. Reporter: natural-language question -> proposal; nothing runs.
  let s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.reporter });
  s = await app.cmd({ cmd: 'nav', view: 'query' });
  assert.equal(view(s).catalog.provider, 'deterministic');
  const before = await executions();
  s = await app.cmd({ cmd: 'query.ask', text: 'Show the total paid amount by tenant for the last month.' });
  const prop = view(s).proposal;
  assert.equal(prop.source, 'generated');
  assert.equal(prop.ok, true);
  assert.equal(prop.executed, false);
  assert.match(view(s).sql_editor, /sum\(c\.paid_amount\)/, 'the proposal is loaded into the SQL editor');
  assert.ok(prop.summary.length >= 3 && prop.model_explanation);
  assert.equal(await executions(), before, 'generation executed nothing');
  app.screenshot('04-query-proposal-reporter');

  // 2. Edit: the edited text cannot run until it is re-validated as a new proposal.
  s = await app.cmd({ cmd: 'query.set_sql', text: view(s).sql_editor + "\n  AND c.status = 'PAID'" });
  assert.equal(view(s).sql_dirty, true);
  s = await app.cmd({ cmd: 'query.run', mode: 'run' });
  assert.equal(view(s).result, null, 'Run is refused for edited, unvalidated SQL');
  assert.equal(await executions(), before);
  s = await app.cmd({ cmd: 'query.validate' });
  assert.equal(view(s).proposal.source, 'edited');
  assert.equal(view(s).proposal.parent_id, prop.id);
  assert.equal(view(s).proposal.ok, true);
  s = await app.cmd({ cmd: 'query.run', mode: 'run' });
  const r = view(s).result;
  assert.equal(r.status, 'succeeded');
  const [want] = await sql(`SELECT count(*)::text n, coalesce(sum(x.paid_amount), 0)::text s FROM t_northwind.claim x JOIN core.batches b ON b.id = x."_batch_id"
    WHERE x."_is_current" AND b.trust_status = 'trusted' AND x.status = 'PAID' AND x.service_date >= date_trunc('month', current_date) - interval '1 month' AND x.service_date < date_trunc('month', current_date)`);
  assert.deepEqual(r.displayed[0], ['northwind', want.n, want.s], 'the grid shows exactly the independent SQL result');
  app.screenshot('05-query-result-reporter');
  lines.push(`reporter: NL question -> generated proposal ${prop.id.slice(0, 8)} (0 executions); edited SQL blocked until re-validated, then edited proposal run: ${want.n} paid claims, ${want.s} total = independent SQL`);

  // 3. Restricted fields stay protected: PII is redacted by the server, copies are redacted too.
  s = await app.cmd({ cmd: 'query.set_sql', text: 'SELECT member_id, last_name, ssn FROM member ORDER BY member_id LIMIT 10' });
  s = await app.cmd({ cmd: 'query.validate' });
  assert.deepEqual(view(s).proposal.output.map((o: any) => o.masked), [null, 'full', 'full']);
  s = await app.cmd({ cmd: 'query.run', mode: 'run' });
  assert.ok(view(s).result.displayed.every((row: string[]) => row[1] === '[redacted]' && row[2] === '[redacted]'));
  noSsn(s);
  const copied = await app.cmd({ cmd: 'query.copy_row' });
  assert.match(copied.copied, /\[redacted\]\t\[redacted\]$/m);
  noSsn(copied);
  app.screenshot('06-query-pii-redacted-reporter');
  lines.push('reporter: last_name and ssn (contract PII) returned as [redacted] by the database; the copied row is redacted too; no SSN reached the client');
  await app.cmd({ cmd: 'sign_out' });

  // 4. Administrator changes sensitivity in the field-policy view.
  s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.admin });
  s = await app.cmd({ cmd: 'nav', view: 'fields' });
  assert.equal(view(s).can_edit, true);
  await app.cmd({ cmd: 'fields.select', entity: 'claim', field: 'provider_npi' });
  await app.cmd({ cmd: 'fields.set', sensitive: true, redaction: 'last4', reason: 'Provider identifiers are restricted by the network contract' });
  s = await app.cmd({ cmd: 'fields.apply' });
  assert.match(view(s).outcome, /Saved version 1 \(tighten change\)/);
  assert.match(view(s).outcome, /reporter: masked/);
  await app.cmd({ cmd: 'fields.select', entity: 'member', field: 'ssn' });
  await app.cmd({ cmd: 'fields.set', role_access: { reporter: 'hidden' } });
  s = await app.cmd({ cmd: 'fields.apply' });
  assert.match(view(s).outcome, /reporter: hidden/);
  app.screenshot('07-fields-admin');
  const versions = await sql(`SELECT entity, field, version, change_kind, changed_by FROM core.field_policy_versions WHERE tenant_id = 'northwind' ORDER BY id`);
  assert.deepEqual(versions.map((v) => `${v.entity}.${v.field} v${v.version} ${v.change_kind} by ${v.changed_by}`), ['claim.provider_npi v1 tighten by northwind-admin', 'member.ssn v1 tighten by northwind-admin']);
  // The admin still sees original NPIs (admin is in the unmask list).
  await app.cmd({ cmd: 'nav', view: 'query' });
  await app.cmd({ cmd: 'query.set_sql', text: 'SELECT claim_id, provider_npi FROM claim ORDER BY claim_id LIMIT 5' });
  await app.cmd({ cmd: 'query.validate' });
  s = await app.cmd({ cmd: 'query.run', mode: 'run' });
  const npis = new Map((await sql(`SELECT claim_id, provider_npi FROM t_northwind.claim WHERE "_is_current"`)).map((x) => [x.claim_id, x.provider_npi]));
  for (const row of view(s).result.displayed) assert.equal(row[1], npis.get(row[0]));
  lines.push('admin (native field-policy view): claim.provider_npi marked sensitive (last4) and member.ssn hidden from reporters; both versioned as tightening changes; admin still sees original NPIs');
  await app.cmd({ cmd: 'sign_out' });

  // 5. Reporter: the hidden field no longer exists; the newly sensitive field arrives masked.
  s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.reporter });
  s = await app.cmd({ cmd: 'nav', view: 'query' });
  const member = view(s).catalog.tables.find((t: any) => t.name === 'member');
  assert.ok(!member.columns.some((c: any) => c[0] === 'ssn'), 'ssn is gone from the reporter catalog');
  assert.deepEqual(view(s).catalog.tables.find((t: any) => t.name === 'claim').columns.find((c: any) => c[0] === 'provider_npi'), ['provider_npi', 'masked']);
  await app.cmd({ cmd: 'query.set_sql', text: 'SELECT member_id, ssn FROM member' });
  s = await app.cmd({ cmd: 'query.validate' });
  assert.equal(view(s).proposal.ok, false);
  assert.equal(view(s).proposal.issues[0].code, 'unknown_column');
  app.screenshot('08-query-hidden-field-reporter');
  await app.cmd({ cmd: 'query.set_sql', text: 'SELECT claim_id, provider_npi FROM claim ORDER BY claim_id LIMIT 5' });
  await app.cmd({ cmd: 'query.validate' });
  s = await app.cmd({ cmd: 'query.run', mode: 'run' });
  for (const row of view(s).result.displayed) assert.equal(row[1], maskValue(npis.get(row[0])!, 'last4'));
  assert.equal(view(s).result.columns[1].masked, 'last4');
  app.screenshot('09-query-masked-reporter');
  lines.push('reporter: ssn absent from the catalog and rejected as an unknown column; provider_npi returned as ******dddd (masked by the database), labelled redacted in the grid');
  await app.cmd({ cmd: 'sign_out' });

  // 6. Operator: detail views apply the same redaction (records, lineage incl. the raw source column).
  s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.operator });
  await app.cmd({ cmd: 'nav', view: 'records' });
  s = await app.cmd({ cmd: 'records.entity', entity: 'claim' });
  const cols: string[] = view(s).columns.map((c: any) => c.name);
  const npiCol = cols.indexOf('provider_npi');
  assert.equal(view(s).columns[npiCol].masked, 'last4');
  for (const row of view(s).displayed) assert.match(row[npiCol], /^\*{6}\d{4}$/);
  app.screenshot('10-records-claims-operator');
  const key = truth.trustedClaimIds[100];
  s = await app.cmd({ cmd: 'lineage.lookup', entity: 'claim', key });
  for (const v of view(s).versions) {
    assert.equal(v.values.provider_npi, maskValue(npis.get(key)!, 'last4'));
    if (v.source_columns) assert.match(v.source_columns.RENDERING_NPI, /^\*{6}\d{4}$/);
  }
  assert.ok(!JSON.stringify(view(s)).includes(npis.get(key)!), 'the original NPI is nowhere in the lineage view');
  app.screenshot('11-lineage-operator');
  lines.push(`operator: records grid and lineage of ${key} (values and raw RENDERING_NPI) show the masked NPI; the original appears nowhere`);
  await app.cmd({ cmd: 'sign_out' });

  // 7. Steward: query history across users, with the withholding rule applied.
  s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.steward });
  await app.cmd({ cmd: 'nav', view: 'history' });
  s = await app.cmd({ cmd: 'history.all', all: true });
  const actors = new Set(view(s).items.map((i: any) => i.actor));
  assert.ok(actors.has('northwind-reporter') && actors.has('northwind-admin'));
  app.screenshot('12-history-steward');
  s = await app.cmd({ cmd: 'theme', dark: true });
  assert.equal(s.theme, 'dark');
  app.screenshot('13-history-steward-dark');
  lines.push(`steward: history of all users (${view(s).items.length} entries); dark theme rendered`);
  await app.cmd({ cmd: 'theme', dark: false });
  await app.cmd({ cmd: 'sign_out' });
  evidence('Scenario O — Native GPUI end-to-end workflow', lines);
});

test('Native client integration: the Rust API client decodes every endpoint for every role (cargo test)', { skip: spawnSync('cargo', ['--version']).status !== 0 && 'cargo not installed' }, async () => {
  // Asynchronous on purpose: the API under test runs in this process and must keep serving.
  const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('cargo', ['test', '--manifest-path', path.join(ROOT, 'native/Cargo.toml'), '-p', 'clearline-client', '--', '--nocapture'], { env: { ...process.env, CLEARLINE_TEST_URL: base } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (status) => resolve({ status, out }));
  });
  const out = r.out;
  assert.equal(r.status, 0, out.slice(-4000));
  assert.match(out, /every_role_decodes_what_it_may_see_and_is_refused_the_rest \.\.\. ok/);
  evidence('Native client integration (Rust)', ['clearline-client contract test against the live backend: 4 data roles x 16 endpoints decode or are refused (403) exactly per the server permissions; query lifecycle with client-chosen execution id; steward tighten/widen; approver, platform admin and cross-tenant tokens refused']);
});

test('Native client measurements: startup, large result, scrolling, typing during a running query', async () => {
  let s = await app.cmd({ cmd: 'sign_in', token: DEV_TOKENS.northwind.reporter });
  await app.cmd({ cmd: 'nav', view: 'query' });
  // Large result: 5,000 rows (the configured row cap) from a cross join.
  await app.cmd({ cmd: 'query.set_sql', text: 'SELECT a.claim_id, a.member_id, a.paid_amount, b.claim_id AS other_claim, b.billed_amount FROM claim a, claim b ORDER BY a.claim_id, b.claim_id' });
  await app.cmd({ cmd: 'query.validate' });
  s = await app.cmd({ cmd: 'query.run', mode: 'run' });
  assert.equal(view(s).result.row_count, 5000);
  assert.equal(view(s).result.grid_rows, 5000);
  const scroll = await app.cmd({ cmd: 'bench.scroll', frames: 150 });
  app.screenshot('14-large-result-reporter');
  // Typing in the SQL editor while a slow query runs on the server (UI thread must stay free).
  await app.cmd({ cmd: 'query.set_sql', text: 'SELECT count(*) AS n FROM claim a, claim b, claim c' });
  await app.cmd({ cmd: 'query.validate' });
  const typing = await app.cmd({ cmd: 'bench.type', frames: 120, while_running: true });
  assert.equal(typing.query_running_at_start, true);
  // A blocked UI thread would show one frame gap as long as the query (seconds); allow generous software-rendering jitter.
  assert.ok(typing.frames.max_ms < 1000, `UI thread stalled while a query ran: max frame interval ${typing.frames.max_ms} ms`);
  const idleTyping = await app.cmd({ cmd: 'bench.type', frames: 120 });
  const report = await app.cmd({ cmd: 'perf' });
  const mark = report.marks.find((m: any) => /5000 rows/.test(m.label));
  assert.ok(mark, 'large-result render time recorded');
  Object.assign(perf, { startup_ms: report.startup_ms, large_result_request_to_frame_ms: mark.ms, scroll_5000_rows: scroll.frames, typing_while_query_runs: typing.frames, typing_idle: idleTyping.frames,
    note: 'Measured under Xvfb with Mesa lavapipe (software Vulkan); a GPU desktop renders faster. Frame intervals are between frames GPUI actually drew.' });
  writeFileSync(path.join(ROOT, 'test-results/native-perf.json'), JSON.stringify({ generated_at: new Date().toISOString(), binary: NATIVE_BIN, ...perf }, null, 2) + '\n');
  evidence('Native client measurements', [
    `startup (process start -> first frame): ${report.startup_ms} ms; spawn -> automation ready: ${(perf.launch as any).spawn_to_ready_ms} ms`,
    `5,000-row result: request -> grid frame drawn ${mark.ms} ms; scrolling through all rows: p50 ${scroll.frames.p50_ms} ms, p95 ${scroll.frames.p95_ms} ms per frame`,
    `typing while a query runs: p50 ${typing.frames.p50_ms} ms, p95 ${typing.frames.p95_ms} ms per frame (idle: p50 ${idleTyping.frames.p50_ms} ms)`,
  ]);
  await app.cmd({ cmd: 'sign_out' });
});
