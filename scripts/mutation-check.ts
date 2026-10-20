// Mutation checks: does the test suite actually catch the defects that matter?
// Each mutation plants one realistic bug in a temporary copy of the repository,
// runs the tests that should catch it, and records whether they did ("killed").
// A surviving mutation means a claim in the docs is not really protected by tests.
//   npm run test:mutation       -> test-results/mutation.json (exit 1 if any mutation survives)

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Mutation { id: string; protects: string; file: string; find: string; replace: string; tests: string[] }
const MUTATIONS: Mutation[] = [
  { id: 'trust-always-granted', protects: 'a failed reconciliation or reject threshold must never yield a trusted batch',
    file: 'src/ingestion/processor.ts', find: "const trust: 'trusted' | 'untrusted' = reasons.length ? 'untrusted' : 'trusted';", replace: "const trust: 'trusted' | 'untrusted' = 'trusted';",
    tests: ['test/scenarios/d-bad-data.test.ts', 'test/scenarios/i-reconciliation-failure.test.ts'] },
  { id: 'route-tenant-check-removed', protects: 'cross-tenant requests are denied (route layer) and audited',
    file: 'src/control/auth.ts', find: "else if (tenantId !== null && p.tenantId !== tenantId) reason = 'cross_tenant';", replace: '/* removed */',
    tests: ['test/scenarios/g-privacy-violation.test.ts'] },
  { id: 'data-layer-tenant-guard-removed', protects: 'the data layer independently refuses another tenant’s scope',
    file: 'src/platform/db.ts', find: 'if (bound && bound.tenantId !== tenantId) return Promise.reject(new TenantScopeViolation(tenantId, bound.tenantId));', replace: '',
    tests: ['test/integration/api.test.ts'] },
  { id: 'idempotency-removed', protects: 'resubmitting identical bytes has no business effect',
    file: 'src/ingestion/intake.ts', find: 'if (existing.rows[0]) {', replace: 'if (false && existing.rows[0]) {',
    tests: ['test/scenarios/c-duplicate-delivery.test.ts'] },
  { id: 'redaction-removed', protects: 'sensitive fields are redacted in default extracts',
    file: 'src/reporting/extracts.ts', find: "const redacted = new Set(fields.filter((f) => level.get(f) === 'masked' || (sensitive.has(f) && !req.include_sensitive)));", replace: 'const redacted = new Set<string>();',
    tests: ['test/scenarios/a-normal-ingestion.test.ts', 'test/scenarios/g-privacy-violation.test.ts'] },
  { id: 'control-count-ignored', protects: 'source control counts are reconciled',
    file: 'src/reconciliation/batch.ts', find: "status: diff === 0 ? 'passed' : 'failed',", replace: "status: 'passed',",
    tests: ['test/scenarios/i-reconciliation-failure.test.ts'] },
  { id: 'untrusted-versions-count-as-duplicates', protects: 'a trusted resend re-establishes rows held only by an untrusted batch',
    file: 'src/ingestion/processor.ts', find: 'const same = versions.find((v) => v.hash === hash && !v.untrusted);', replace: 'const same = versions.find((v) => v.hash === hash);',
    tests: ['test/scenarios/i-reconciliation-failure.test.ts'] },
  { id: 'trusted-view-uses-current-only', protects: 'an untrusted correction does not displace the trusted value',
    file: 'src/reporting/sql.ts', find: "if (scope === 'trusted') {", replace: "if (scope === 'trusted' && false) {",
    tests: ['test/scenarios/i-reconciliation-failure.test.ts'] },
  { id: 'self-approval-allowed', protects: 'tenant admins cannot approve breaking migrations',
    file: 'src/control/auth.ts', find: "'contract:read', 'contract:publish', 'batch:submit'", replace: "'contract:read', 'contract:publish', 'contract:approve', 'batch:submit'",
    tests: ['test/scenarios/h-contract-evolution.test.ts'] },
  { id: 'platform-admin-escalation', protects: 'platform admins cannot mint tenant tokens after bootstrap',
    file: 'src/control/tenants.ts', find: 'if (admins.rows.length) throw', replace: 'if (false && admins.rows.length) throw',
    tests: ['test/integration/api.test.ts'] },
  { id: 'migration-drift-unchecked', protects: 'drift in migration-created rows is detected',
    file: 'src/reconciliation/reverify.ts', find: 'if (expectedMig > 0 || mig > 0) {', replace: 'if (false) {',
    tests: ['test/scenarios/h-contract-evolution.test.ts'] },
  { id: 'queued-batch-uses-superseded-contract', protects: 'batches queued before a breaking migration are not processed under the old contract',
    file: 'src/ingestion/processor.ts', find: 'if (breaking.length) {', replace: 'if (false) {',
    tests: ['test/scenarios/h-contract-evolution.test.ts'] },
  { id: 'dataset-checks-ignored-by-metrics', protects: 'failing dataset checks qualify trusted metrics',
    file: 'src/reporting/reports.ts', find: 'const qualifications = failing.get(m.entity) ?? [];', replace: 'const qualifications: never[] = [];',
    tests: ['test/scenarios/i-reconciliation-failure.test.ts'] },
  { id: 'audit-floor-removed', protects: 'young audit events cannot be deleted even in a retention session',
    file: 'db/migrations/0002_review_hardening.sql', find: 'IF OLD.at < now() - make_interval(days => coalesce(keep_days, 2555)) THEN', replace: 'IF true THEN',
    tests: ['test/integration/api.test.ts'] },
  // ---- query workspace and field policy (scenarios K-N)
  { id: 'validator-restricted-check-removed', protects: 'restricted fields cannot be compared, sorted, grouped, aggregated or derived',
    file: 'src/query/validate.ts', find: "    throw new Reject('restricted_field', `Field ${fq(b)} cannot be used in ${where}:", replace: "    return; throw new Reject('restricted_field', `Field ${fq(b)} cannot be used in ${where}:",
    tests: ['test/unit/query-validate.test.ts', 'test/scenarios/n-tenant-isolation-inference.test.ts'] },
  { id: 'mask-rewrite-skipped', protects: 'masked fields are returned only in the redacted form computed by the database',
    file: 'src/query/validate.ts', find: "        rt.val = { FuncCall: { funcname: [{ String: { sval: 'core' } }, { String: { sval: 'mask_value' } }],", replace: "        if (Date.now() < 0) rt.val = { FuncCall: { funcname: [{ String: { sval: 'core' } }, { String: { sval: 'mask_value' } }],",
    tests: ['test/scenarios/l-role-restricted-field.test.ts', 'test/scenarios/m-sensitivity-redaction.test.ts'] },
  { id: 'hidden-columns-granted', protects: 'the database grants a query role no column its role may not use',
    file: 'src/query/surface.ts', find: ".filter((c) => c.level !== 'hidden' && c.level !== 'discover')", replace: '.filter(() => true)',
    tests: ['test/scenarios/l-role-restricted-field.test.ts'] },
  { id: 'steward-may-widen', protects: 'policy:manage may only tighten a field policy',
    file: 'src/policy/fields.ts', find: "if ((change.kind === 'loosen' || change.kind === 'mixed') && !can(p, 'policy:grant')) {", replace: 'if (false) {',
    tests: ['test/scenarios/m-sensitivity-redaction.test.ts'] },
  { id: 'sensitivity-does-not-mask', protects: 'a sensitive field is redacted for roles outside its unmask list',
    file: 'src/policy/fields.ts', find: "if (base === 'full' && p.sensitive && !p.unmask_roles.includes(role)) return 'masked';", replace: '',
    tests: ['test/unit/policy.test.ts', 'test/scenarios/m-sensitivity-redaction.test.ts'] },
  { id: 'history-not-withheld', protects: 'query history does not show other users\' SQL that the viewer may not use',
    file: 'src/query/service.ts', find: 'withheld = !own && !v.ok && ACCESS_CODES.has(v.issues[0]?.code);', replace: 'withheld = false;',
    tests: ['test/scenarios/n-tenant-isolation-inference.test.ts'] },
  { id: 'execute-without-revalidation', protects: 'every execution re-validates the stored SQL under the current policy',
    file: 'src/query/service.ts', find: "    throw new AppError(403, 'query_not_permitted', v.issues[0]?.message ?? 'The query is not permitted.', { issues: v.issues });", replace: '',
    tests: ['test/scenarios/k-natural-language-sql.test.ts'] },
  { id: 'records-unredacted', protects: 'record listings apply the field policy',
    file: 'src/reporting/lineage.ts', find: 'records: rows.map((r) => ({ ...viewer.record(entity, r), _key: viewer.key(entity, e.key, r._key) })) };', replace: 'records: rows };',
    tests: ['test/scenarios/m-sensitivity-redaction.test.ts', 'test/scenarios/g-privacy-violation.test.ts'] },
  // ---- saved analytics: schedules, runs, analyses, delivery (scenarios P-T)
  { id: 'revoked-identity-still-runs', protects: 'a schedule whose execution identity was revoked does not run',
    file: 'src/analytics/identity.ts', find: "if (!tok) return { ok: false, code: 'identity_revoked'", replace: "if (false) return { ok: false, code: 'identity_revoked'",
    tests: ['test/scenarios/t-analytics-end-to-end.test.ts'] },
  { id: 'run-as-role-not-delegation-checked', protects: 'a schedule cannot run with a role its creator may not delegate',
    file: 'src/analytics/schedules.ts', find: "  if (!DELEGABLE_ROLES[p.role].includes(role)) throw new AppError(403, 'role_not_delegable'", replace: "  if (false) throw new AppError(403, 'role_not_delegable'",
    tests: ['test/scenarios/q-scheduling.test.ts'] },
  { id: 'delivery-not-reauthorized', protects: 'results that became restricted after the query ran are not delivered',
    file: 'src/delivery/deliver.ts', find: "      if (!access.ok) return { kind: 'blocked', code: access.code, message: access.message };", replace: '',
    tests: ['test/scenarios/r-delivery.test.ts', 'test/scenarios/t-analytics-end-to-end.test.ts'] },
  { id: 'webhook-private-targets-allowed', protects: 'webhooks cannot target private, loopback or link-local addresses',
    file: 'src/delivery/ssrf.ts', find: "      if (why) throw new DestinationError('private_address'", replace: "      if (false) throw new DestinationError('private_address'",
    tests: ['test/unit/delivery.test.ts', 'test/scenarios/t-analytics-end-to-end.test.ts'] },
  { id: 'failed-delivery-reported-success', protects: 'a successful query followed by a failed delivery is not reported as delivered',
    file: 'src/delivery/deliver.ts', find: "    else if (['failed', 'blocked', 'partial'].includes(delivery)) {", replace: '    else if (false) {',
    tests: ['test/scenarios/r-delivery.test.ts'] },
  { id: 'sensitive-feature-allowed', protects: 'fields derived from sensitive data are not analysis inputs',
    file: 'src/analysis/config.ts', find: "      else if (col.sensitive) issues.push(", replace: "      else if (false) issues.push(",
    tests: ['test/unit/analysis.test.ts', 'test/scenarios/s-ml-analyses.test.ts'] },
  { id: 'narrative-not-grounded', protects: 'model summaries are accepted only when grounded in computed evidence',
    file: 'src/analysis/narrate.ts', find: '    const g = groundingCheck(text, insight.evidence);', replace: '    const g = { ok: true, reason: null };',
    tests: ['test/unit/analysis.test.ts', 'test/scenarios/s-ml-analyses.test.ts'] },
  { id: 'run-results-not-remasked', protects: 'saved run results are re-masked for a viewer whose access is narrower now',
    file: 'src/analytics/runs.ts', find: '    if (now && now !== c.masked) { remask.set(i, now); restricted.add(c.name); }', replace: '',
    tests: ['test/scenarios/r-delivery.test.ts'] },
  { id: 'notifications-not-recipient-scoped', protects: 'users see only their own notifications',
    file: 'src/delivery/inbox.ts', find: 'WHERE n.tenant_id = $1 AND n.recipient = $2 AND', replace: 'WHERE n.tenant_id = $1 AND $2::text IS NOT NULL AND',
    tests: ['test/scenarios/r-delivery.test.ts'] },
];

const only = process.argv[2];
const results: Record<string, unknown>[] = [];
let survived = 0;
for (const m of MUTATIONS.filter((x) => !only || x.id === only)) {
  const dir = mkdtempSync(path.join(tmpdir(), `clearline-mut-${m.id}-`));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|dist|test-results|target)([\\/]|$)/.test(src.slice(ROOT.length)) });
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  const f = path.join(dir, m.file);
  const src = readFileSync(f, 'utf8');
  if (!src.includes(m.find)) throw new Error(`mutation ${m.id}: target text not found in ${m.file} (update the mutation)`);
  writeFileSync(f, src.replace(m.find, m.replace));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...m.tests], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, TEST_DATABASE_NAME: 'clearline_mut', LOG_LEVEL: 'error' }, timeout: 300_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const failing = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]);
  const killed = r.status !== 0 && failing.length > 0;
  if (!killed) survived++;
  results.push({ id: m.id, protects: m.protects, file: m.file, tests: m.tests, killed, failing_tests: failing, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${m.id.padEnd(40)} ${failing.length ? `by: ${failing.join('; ')}` : ''}`);
  rmSync(dir, { recursive: true, force: true });
}
mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
if (!only) writeFileSync(path.join(ROOT, 'test-results/mutation.json'), JSON.stringify({ generated_at: new Date().toISOString(), mutations: results.length, killed: results.length - survived, survived, results }, null, 2));
console.log(`${results.length - survived}/${results.length} mutations killed`);
process.exit(survived ? 1 : 0);
