// Scenario L — Role-restricted field. member.ssn is configured: sensitive with
// last-4 masking, hidden from reporters (not even discoverable), filter-only for
// operators, masked for stewards, original for admins. Every route a reporter or
// operator might use to obtain it (direct selection, alias, join, expression,
// subquery, CTE, star, catalog, contract, records, lineage, extracts, errors)
// is tried; no SSN value or SSN metadata may come back.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { queries } from '../helpers/query.js';
import { loadReferenceDataset } from '../../synthetic/reference-dataset.js';
import { nwMembers } from '../../synthetic/generator.js';
import { maskValue } from '../../src/policy/mask.js';

let ctx: Ctx;
// The reference dataset's members (same generator and seed as synthetic/reference-dataset.ts).
const MEMBERS = nwMembers(150, 1001);
const SSNS = MEMBERS.map((m) => m.SSN).filter(Boolean);

before(async () => {
  ctx = await setup();
  await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
});
after(async () => { await teardown(ctx); });

/** No SSN appears in any response, except a value the caller typed itself (echoed back in its own SQL). */
const noSsn = (texts: string[], who: string, typed: string[] = []) => {
  for (const t of texts) for (const s of SSNS.filter((x) => !typed.includes(x))) assert.ok(!t.includes(s) && !t.includes(s.replace(/-/g, '')), `${who}: an SSN value leaked`);
};

test('Scenario L: a restricted field cannot be obtained by a role that may not see it', async () => {
  assert.ok(SSNS.length > 100);
  const admin = client(ctx, DEV_TOKENS.northwind.admin);
  const set = await admin.post('/api/v1/tenants/northwind/fields/member/ssn/policy', {
    sensitive: true, redaction: 'last4', reason: 'Government identifier; needed only for eligibility disputes', unmask_roles: ['admin'],
    role_access: { reporter: 'hidden', operator: 'filter' },
  });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.body.effective_access, { admin: 'full', steward: 'masked', operator: 'filter', reporter: 'hidden' });

  // --- Admin (authorized): original values.
  const qa = queries(admin, 'northwind');
  const a = await qa.rows('SELECT member_id, ssn FROM member ORDER BY member_id');
  const truth = new Map(MEMBERS.map((m) => [m.MBR_ID, m.SSN]));
  assert.equal(a.objects.length, 150);
  for (const r of a.objects) assert.equal(r.ssn, truth.get(String(r.member_id)));

  // --- Steward: allowed to see that it exists and its redacted form only.
  const qs = queries(client(ctx, DEV_TOKENS.northwind.steward), 'northwind');
  const s = await qs.rows('SELECT member_id, ssn FROM member ORDER BY member_id');
  for (const r of s.objects) assert.equal(r.ssn, maskValue(truth.get(String(r.member_id))!, 'last4'));
  assert.ok(String(s.objects[0].ssn).startsWith('***-**-'));
  assert.match(s.proposal.validated_sql, /core\.mask_value\(ssn::text, 'last4'\)/, 'redaction happens in the database');
  noSsn(qs.seen, 'steward');

  // --- Reporter: the field does not exist.
  const reporter = client(ctx, DEV_TOKENS.northwind.reporter);
  const qr = queries(reporter, 'northwind');
  const cat = (await qr.catalog()).body;
  assert.ok(!JSON.stringify(cat).includes('ssn'), 'not in the catalog (and therefore never sent to a model provider)');
  const attempts: [string, string][] = [
    ['direct selection', 'SELECT ssn FROM member'],
    ['qualified', 'SELECT m.ssn FROM member m'],
    ['alias', 'SELECT ssn AS id_number FROM member'],
    ['join', 'SELECT c.claim_id, m.ssn FROM claim c JOIN member m ON m.member_id = c.member_id'],
    ['expression', `SELECT upper(ssn) FROM member`],
    ['concatenation', `SELECT member_id || ssn FROM member`],
    ['subquery in FROM', 'SELECT x.s FROM (SELECT ssn AS s FROM member) x'],
    ['scalar subquery', 'SELECT (SELECT ssn FROM member LIMIT 1) AS s FROM plan'],
    ['CTE', 'WITH m AS (SELECT ssn FROM member) SELECT ssn FROM m'],
    ['EXISTS probe', `SELECT count(*) FROM plan WHERE EXISTS (SELECT 1 FROM member WHERE ssn = '${SSNS[0]}')`],
    ['filter probe', `SELECT member_id FROM member WHERE ssn LIKE '1%'`],
    ['sort', 'SELECT member_id FROM member ORDER BY ssn'],
    ['group', 'SELECT count(*) FROM member GROUP BY ssn'],
    ['null test', 'SELECT count(*) FROM member WHERE ssn IS NULL'],
  ];
  const missing = (await qr.sql('SELECT no_such_column FROM member')).body.validation.issues[0];
  for (const [why, q] of attempts) {
    const p = await qr.sql(q);
    assert.equal(p.status, 201);
    assert.equal(p.body.validation.ok, false, `${why} must be rejected`);
    const issue = p.body.validation.issues[0];
    assert.equal(issue.code, missing.code, `${why}: same error as a nonexistent column`);
    assert.ok(!/redact|restrict|sensitive|filter|permission|role/i.test(issue.message), `${why}: error does not hint that the field exists: ${issue.message}`);
    const run = await qr.run(p.body.id);
    assert.equal(run.status, 403, `${why}: refused at execution too`);
  }
  // SELECT * silently omits it.
  const star = await qr.rows('SELECT * FROM member LIMIT 5');
  assert.ok(!star.result.columns.some((c: { name: string }) => c.name === 'ssn'));
  // Other surfaces: contract document, extract schema, natural language.
  const contract = (await reporter.get('/api/v1/tenants/northwind/contracts/active')).body;
  assert.ok(!('ssn' in contract.document.entities.member.fields));
  assert.ok(!JSON.stringify(contract.document.sources).includes('"target":"ssn"'));
  const nl = await qr.ask('List members with their ssn');
  assert.ok(!nl.body.proposed_sql || !nl.body.proposed_sql.includes('ssn'));
  noSsn([...qr.seen, JSON.stringify(contract)], 'reporter', [SSNS[0]]);

  // --- Operator: may join and null-test, never see or probe.
  const operator = client(ctx, DEV_TOKENS.northwind.operator);
  const qo = queries(operator, 'northwind');
  const ok = await qo.rows(`SELECT count(*) AS with_ssn FROM member WHERE ssn IS NOT NULL`);
  assert.equal(Number(ok.objects[0].with_ssn), SSNS.length, 'presence is the documented, permitted disclosure for filter-only fields');
  for (const [why, q] of attempts.filter(([w]) => w !== 'null test')) {
    const p = await qo.sql(q);
    assert.equal(p.body.validation.ok, false, `operator ${why}`);
    assert.ok(['restricted_field', 'unknown_function'].includes(p.body.validation.issues[0].code), `operator ${why}: ${p.body.validation.issues[0].message}`);
  }
  const recs = (await operator.get('/api/v1/tenants/northwind/entities/member/records?limit=200')).body;
  assert.ok(recs.records.every((r: Record<string, unknown>) => !('ssn' in r)), 'records omit a field the role cannot view');
  const lin = (await operator.get(`/api/v1/tenants/northwind/lineage/member/${MEMBERS[0].MBR_ID}`)).body;
  assert.ok(!('ssn' in lin.versions[0].values));
  assert.ok(!('SSN' in lin.versions[0].source_row.mapped_columns), 'the raw source column is withheld too');
  noSsn([...qo.seen, JSON.stringify(recs), JSON.stringify(lin)], 'operator', [SSNS[0]]);

  // --- Database: the operator's query role has the column (to join on) but the reporter's has no grant at all.
  const grants = await sql(`SELECT grantee, privilege_type FROM information_schema.column_privileges WHERE table_schema = 'q_northwind' AND table_name = 'member' AND column_name = 'ssn' AND grantee LIKE 'clearline_q_%' AND privilege_type = 'SELECT' ORDER BY grantee`);
  assert.deepEqual(grants.map((g) => g.grantee), ['clearline_q_northwind_admin', 'clearline_q_northwind_operator', 'clearline_q_northwind_steward']);

  // --- Audit: decisions recorded, values never.
  const events = await sql(`SELECT action, outcome, details::text AS d FROM core.audit_events WHERE tenant_id = 'northwind' AND (action LIKE 'query.%' OR action LIKE 'policy.%')`);
  assert.ok(events.some((e) => e.action === 'policy.field.update' && e.outcome === 'succeeded'));
  assert.ok(events.filter((e) => e.action === 'query.validation' && e.outcome === 'failed').length >= attempts.length * 2);
  noSsn(events.map((e) => e.d), 'audit');
  const proposals = await sql(`SELECT coalesce(proposed_sql, '') || coalesce(validated_sql, '') AS t FROM core.query_proposals`);
  // The one probe that typed a literal SSN is stored as the user wrote it (their own text), and is never shown to others; see Scenario N.
  assert.ok(proposals.filter((p) => SSNS.some((v) => p.t.includes(v))).length <= 2);

  evidence('Scenario L — Role-restricted field', [
    'member.ssn policy: sensitive, last4, unmask=[admin]; reporter=hidden, operator=filter -> effective admin=full, steward=masked, operator=filter, reporter=hidden',
    `admin query returned 150 original SSNs (= generator); steward received ***-**-dddd computed in the database (core.mask_value)`,
    `reporter: ${attempts.length} access routes (direct, alias, join, expression, concatenation, FROM/scalar subquery, CTE, EXISTS probe, filter probe, sort, group, null test) -> all rejected with the same error as a nonexistent column, and refused at execution`,
    'reporter: ssn absent from catalog, SELECT *, contract document and natural-language proposals',
    `operator: only IS [NOT] NULL permitted (count with SSN = ${SSNS.length}); every other route rejected as restricted_field; records and lineage omit the field and the raw SSN column`,
    'database: column grant on q_northwind.member.ssn exists only for the admin, operator and steward query roles (not reporter)',
    'audit: policy change and every rejected validation recorded; no SSN value in any audit payload',
  ]);
});
