// SQL validator: structure, tenant scope, field access and inference resistance.
// Pure unit tests over the real PostgreSQL parser; no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicySet, type FieldPolicy } from '../../src/policy/fields.js';
import { buildCatalog } from '../../src/query/catalog.js';
import { validateSql } from '../../src/query/validate.js';
import type { Contract } from '../../src/contracts/types.js';
import type { Role } from '../../src/control/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NW: Contract = JSON.parse(readFileSync(path.join(root, 'contracts/northwind/v1.json'), 'utf8'));

function policies(rows: Partial<FieldPolicy>[] = []) {
  const m = new Map<string, FieldPolicy>();
  for (const r of rows) {
    m.set(`${r.entity}.${r.field}`, { sensitive: false, redaction: 'full', reason: 'test', unmask_roles: ['admin'], role_access: {}, version: 1, source: 'configured',
      updated_by: 't', updated_at: null, ...r } as FieldPolicy);
  }
  return new PolicySet('northwind', NW, m, 1);
}
// Scenario-L style configuration: ssn hidden from reporters, filter-only for operators; diagnosis_code masked (last4 not valid -> full).
const SET = policies([
  { entity: 'member', field: 'ssn', sensitive: true, redaction: 'last4', role_access: { reporter: 'hidden', operator: 'filter' } },
  { entity: 'claim', field: 'procedure_code', role_access: { reporter: 'discover' } },
]);
const cat = (role: Role, set = SET) => buildCatalog(set, role);
const ok = async (role: Role, sql: string) => {
  const r = await validateSql(sql, cat(role), { maxRows: 1000 });
  assert.ok(r.ok, `${role}: expected valid: ${sql}\n${JSON.stringify(r.issues)}`);
  return r;
};
const bad = async (role: Role, sql: string, code?: string) => {
  const r = await validateSql(sql, cat(role), { maxRows: 1000 });
  assert.equal(r.ok, false, `${role}: expected rejection: ${sql}\n${r.validated_sql}`);
  if (code) assert.equal(r.issues[0].code, code, `${sql}: ${r.issues[0].message}`);
  return r;
};

test('accepts analytical SELECTs and rewrites them onto the tenant query schema with a row cap', async () => {
  const r = await ok('reporter', `SELECT c.status, count(*) AS n, sum(c.paid_amount) AS paid FROM claim c WHERE c.service_date >= current_date - interval '30 days' GROUP BY c.status ORDER BY 2 DESC`);
  assert.match(r.validated_sql!, /FROM q_northwind\.claim AS c/);
  assert.match(r.validated_sql!, /LIMIT 1000/);
  assert.deepEqual(r.output.map((o) => o.name), ['status', 'n', 'paid']);
  assert.ok(r.columns.find((c) => c.column === 'paid_amount')!.usages.includes('aggregate'));
  const small = await ok('reporter', 'SELECT claim_id FROM claim LIMIT 5');
  assert.match(small.validated_sql!, /LIMIT 5/);
  assert.match(await small.withLimit!(21), /LIMIT 5/);
  const big = await ok('reporter', 'SELECT claim_id FROM claim LIMIT 99999');
  assert.match(big.validated_sql!, /LIMIT 1000\b/);
  await ok('reporter', `WITH paid AS (SELECT member_id, sum(paid_amount) AS total FROM claim WHERE status = 'P' GROUP BY member_id) SELECT p.total FROM paid p WHERE p.total > 100`);
  await ok('reporter', `SELECT b.id, b.source_id, count(*) FROM batches b JOIN reconciliation_results r ON r.batch_id = b.id WHERE r.status = 'failed' GROUP BY b.id, b.source_id`);
  await ok('reporter', `SELECT date_trunc('month', service_date) AS month, round(avg(paid_amount), 2) FROM claim GROUP BY 1 ORDER BY 1`);
  await ok('reporter', `SELECT CASE WHEN paid_amount > 1000 THEN 'high' ELSE 'low' END AS band, count(*) FROM claim GROUP BY 1`);
  await ok('reporter', `SELECT extract(year from service_date), coalesce(allowed_amount, 0)::numeric(12,2) FROM claim WHERE status IN ('P','D') AND provider_npi LIKE '1%'`);
});

test('rejects every non-SELECT statement, multiple statements and data-modifying constructs', async () => {
  for (const sql of ['INSERT INTO claim (claim_id) VALUES (1)', 'UPDATE claim SET paid_amount = 0', 'DELETE FROM claim', 'DROP TABLE claim', 'TRUNCATE claim',
    'CREATE TABLE x (a int)', 'COPY claim TO STDOUT', `COPY (SELECT 1) TO PROGRAM 'id'`, 'GRANT SELECT ON claim TO public', 'BEGIN', 'COMMIT', 'SET ROLE postgres',
    'VACUUM claim', 'EXPLAIN SELECT 1', 'MERGE INTO claim USING plan ON true WHEN MATCHED THEN DELETE', `DO $$ BEGIN END $$`, 'LISTEN x', 'CALL p()']) {
    await bad('admin', sql, 'not_read_only');
  }
  await bad('admin', 'SELECT 1; DROP TABLE claim', 'multiple_statements');
  await bad('admin', 'SELECT claim_id FROM claim; SELECT 1', 'multiple_statements');
  await bad('admin', 'WITH d AS (DELETE FROM claim RETURNING claim_id) SELECT claim_id FROM d', 'not_read_only');
  await bad('admin', 'SELECT claim_id INTO newtable FROM claim', 'not_read_only');
  await bad('admin', 'SELECT claim_id FROM claim FOR UPDATE', 'not_read_only');
  await bad('admin', 'SELEC claim_id FROM claim', 'syntax_error');
});

test('rejects system catalogs, internal schemas, other tenants and dangerous functions with uniform errors', async () => {
  for (const t of ['pg_catalog.pg_roles', 'information_schema.tables', 'core.batches', 'core.api_tokens', 't_bluefin.rx_claim', 't_northwind.claim', 'q_bluefin.enrollee',
    'q_northwind.claim', 'reporting.batch_overview', 'public.schema_migrations', 'clearline.core.batches']) {
    const r = await bad('admin', `SELECT 1 FROM ${t}`, 'unknown_table');
    assert.equal(r.issues[0].message, `Table "${t}" is not available.`);
  }
  for (const t of ['pg_roles', 'pg_user', 'pg_stat_activity', 'enrollee', 'rx_claim', 'api_tokens', 'audit_events']) await bad('admin', `SELECT 1 FROM ${t}`, 'unknown_table');
  for (const f of [`pg_read_file('/etc/passwd')`, `pg_sleep(10)`, `current_setting('app.tenant_id')`, `set_config('app.tenant_id','bluefin',true)`, `dblink('x','y')`,
    `lo_import('/etc/passwd')`, `pg_catalog.pg_read_file('x')`, `core.reporting_tenant('x')`, `core.mask_value('a','full')`, `query_to_xml('select 1',true,true,'')`, 'version()']) {
    const r = await bad('admin', `SELECT ${f} FROM claim`);
    assert.ok(['unknown_function', 'unsupported'].includes(r.issues[0].code), f);
  }
  await bad('admin', 'SELECT current_user FROM claim', 'unsupported');
  await bad('admin', `SELECT claim_id FROM generate_series(1, 10) g`, 'unsupported');
  await bad('admin', `SELECT claim_id FROM claim WHERE claim_id ~ 'a.*'`, 'unsupported');
  await bad('admin', `SELECT claim_id::regclass FROM claim`, 'unsupported');
  await bad('admin', `SELECT $1 FROM claim`, 'unsupported');
});

test('a hidden field is indistinguishable from a field that does not exist', async () => {
  const hidden = await bad('reporter', 'SELECT ssn FROM member', 'unknown_column');
  const missing = await bad('reporter', 'SELECT no_such_field FROM member', 'unknown_column');
  assert.equal(hidden.issues[0].message.replace('ssn', 'X'), missing.issues[0].message.replace('no_such_field', 'X'));
  for (const sql of ['SELECT m.ssn FROM member m', 'SELECT ssn AS x FROM member', 'SELECT member_id FROM member WHERE ssn IS NULL', 'SELECT count(*) FROM member GROUP BY ssn',
    'SELECT member_id FROM member ORDER BY ssn', 'SELECT member_id FROM member m WHERE EXISTS (SELECT 1 FROM member x WHERE x.ssn = m.member_id)', 'SELECT (SELECT ssn FROM member LIMIT 1) FROM claim']) {
    const r = await bad('reporter', sql, 'unknown_column');
    assert.ok(!/filter|redact|restricted|sensitive/i.test(r.issues[0].message), `no hint that the field exists: ${r.issues[0].message}`);
  }
  // SELECT * silently omits it; the catalog does not list it.
  const star = await ok('reporter', 'SELECT * FROM member');
  assert.ok(!star.output.some((o) => o.name === 'ssn'));
  assert.ok(!cat('reporter').tables.get('member')!.columns.has('ssn'));
  assert.ok(!star.validated_sql!.includes('ssn'));
});

test('filter-only fields: relationship joins and null tests only; never returned, compared, sorted, grouped or aggregated', async () => {
  await ok('operator', `SELECT c.claim_id FROM claim c JOIN member m ON m.member_id = c.member_id WHERE m.ssn IS NOT NULL`);
  for (const [sql, why] of [
    ['SELECT ssn FROM member', 'direct'], ['SELECT ssn AS id_number FROM member', 'alias'], ['SELECT m.ssn FROM member m JOIN claim c ON c.member_id = m.member_id', 'join'],
    ['SELECT x.s FROM (SELECT ssn AS s FROM member) x', 'subquery'], [`WITH s AS (SELECT ssn FROM member) SELECT ssn FROM s`, 'cte'],
    ['SELECT upper(ssn) FROM member', 'expression'], [`SELECT ssn || '' FROM member`, 'concat'], ['SELECT ssn::text FROM member', 'cast'],
    [`SELECT count(*) FROM member WHERE ssn = '123-45-6789'`, 'probe equality'], [`SELECT count(*) FROM member WHERE ssn LIKE '1%'`, 'probe prefix'],
    [`SELECT count(*) FROM member WHERE ssn > '5'`, 'probe range'], [`SELECT count(*) FROM member WHERE ssn IN ('1','2')`, 'probe list'],
    [`SELECT count(*) FROM member WHERE ssn BETWEEN '0' AND '5'`, 'between'], ['SELECT member_id FROM member ORDER BY ssn', 'sort'],
    ['SELECT count(*) FROM member GROUP BY ssn', 'group'], ['SELECT count(DISTINCT ssn) FROM member', 'distinct count'], ['SELECT max(ssn) FROM member', 'max'],
    [`SELECT sum(CASE WHEN ssn LIKE '1%' THEN 1 ELSE 0 END) FROM member`, 'conditional aggregate'], ['SELECT DISTINCT ssn FROM member', 'distinct'],
    [`SELECT member_id FROM member WHERE length(ssn) = 11`, 'length'], [`SELECT member_id FROM member m WHERE m.ssn = m.member_id`, 'unrelated column'],
    [`SELECT member_id FROM member WHERE coalesce(ssn, 'x') = 'x'`, 'coalesce'], [`SELECT count(*) FILTER (WHERE ssn = 'x') FROM member`, 'agg filter'],
    [`SELECT (SELECT ssn FROM member LIMIT 1) FROM claim`, 'scalar subquery'], [`SELECT member_id FROM member WHERE ssn IN (SELECT claim_id FROM claim)`, 'in unrelated'],
    [`SELECT x.s FROM (SELECT ssn AS s FROM member) x WHERE x.s = '1'`, 'probe through subquery'], [`SELECT member_id FROM member ORDER BY ssn DESC LIMIT 1`, 'top-1 sort'],
    [`SELECT member_id, ssn IS NULL FROM member`, 'null test returned is fine but ssn alone is not'],
  ] as const) {
    if (why === 'null test returned is fine but ssn alone is not') { await ok('operator', sql); continue; }
    const r = await bad('operator', sql);
    assert.equal(r.issues[0].code, 'restricted_field', `${why}: ${r.issues[0].message}`);
  }
});

test('masked fields are returned only in redacted form, computed by the database', async () => {
  // Contract-default PII for an operator: masked, full redaction.
  const r = await ok('operator', 'SELECT m.member_id, m.last_name AS surname FROM member m');
  assert.match(r.validated_sql!, /core\.mask_value\(m\.last_name::text, 'full'\) AS surname/);
  assert.deepEqual(r.output.map((o) => [o.name, o.masked]), [['member_id', null], ['surname', 'full']]);
  const sub = await ok('operator', 'SELECT x.n FROM (SELECT first_name AS n FROM member) x');
  assert.match(sub.validated_sql!, /mask_value\(x\.n::text, 'full'\) AS n/);
  // Admin: original values.
  const a = await ok('admin', 'SELECT last_name, ssn FROM member');
  assert.ok(!a.validated_sql!.includes('mask_value(last_name'));
  // Admin is not in the ssn unmask list? It is (default); a steward is not -> last4.
  const st = await ok('steward', 'SELECT ssn FROM member');
  assert.match(st.validated_sql!, /mask_value\(ssn::text, 'last4'\)/);
  for (const sql of [`SELECT upper(last_name) FROM member`, `SELECT count(*) FROM member WHERE last_name = 'Smith'`, `SELECT last_name FROM member ORDER BY last_name`,
    `SELECT left(last_name, 1) FROM member`, `SELECT last_name, count(*) FROM member GROUP BY last_name`, `SELECT DISTINCT gender FROM member`]) {
    const x = await bad('operator', sql);
    assert.ok(['restricted_field', 'unknown_function'].includes(x.issues[0].code), sql);
  }
});

test('discover-only fields are listed but unusable', async () => {
  assert.equal(cat('reporter').tables.get('claim')!.columns.get('procedure_code')!.level, 'discover');
  const r = await bad('reporter', 'SELECT procedure_code FROM claim', 'restricted_field');
  assert.match(r.issues[0].message, /cannot be used/);
  const star = await ok('reporter', 'SELECT * FROM claim');
  assert.ok(!star.output.some((o) => o.name === 'procedure_code'));
});

test('marking a field sensitive never widens access', async () => {
  const base = policies([{ entity: 'claim', field: 'paid_amount', role_access: { reporter: 'hidden' } }]);
  const marked = policies([{ entity: 'claim', field: 'paid_amount', role_access: { reporter: 'hidden' }, sensitive: true, unmask_roles: ['admin', 'steward', 'operator', 'reporter'] }]);
  for (const s of [base, marked]) {
    assert.equal(s.access('reporter', 'claim', 'paid_amount'), 'hidden');
    assert.equal((await validateSql('SELECT paid_amount FROM claim', cat('reporter', s), { maxRows: 10 })).issues[0].code, 'unknown_column');
  }
  const m2 = policies([{ entity: 'claim', field: 'paid_amount', sensitive: true, reason: 'x', unmask_roles: ['admin'] }]);
  assert.equal(m2.access('reporter', 'claim', 'paid_amount'), 'masked');
  assert.equal(m2.access('admin', 'claim', 'paid_amount'), 'full');
  // Approvers and platform admins never see tenant data whatever the policy says.
  assert.equal(m2.access('approver', 'claim', 'claim_id'), 'hidden');
  assert.equal(buildCatalog(m2, 'platform_admin').tables.size, 0);
});

test('table-level policy hides a whole table', async () => {
  const s = policies([{ entity: 'pharmacy_fill', field: '*', role_access: { reporter: 'hidden' } }]);
  assert.ok(!buildCatalog(s, 'reporter').tables.has('pharmacy_fill'));
  assert.equal((await validateSql('SELECT count(*) FROM pharmacy_fill', buildCatalog(s, 'reporter'), { maxRows: 10 })).issues[0].code, 'unknown_table');
  assert.ok(buildCatalog(s, 'operator').tables.has('pharmacy_fill'));
});

test('unsupported constructs fail closed', async () => {
  for (const sql of [
    'SELECT claim_id FROM claim UNION SELECT plan_code FROM plan', 'SELECT row_number() OVER () FROM claim', 'SELECT claim_id FROM claim NATURAL JOIN member',
    'SELECT claim_id FROM claim JOIN member USING (member_id)', 'SELECT x.a FROM claim c, LATERAL (SELECT c.claim_id AS a) x', 'WITH RECURSIVE r AS (SELECT 1 AS n) SELECT n FROM r',
    'SELECT DISTINCT ON (status) status FROM claim', 'SELECT status, count(*) FROM claim GROUP BY ROLLUP (status)', 'SELECT ARRAY[1,2] FROM claim', 'SELECT (claim_id, status) FROM claim',
    `SELECT claim_id FROM claim WHERE status = ANY(ARRAY['P'])`, `SELECT claim_id FROM claim WHERE status SIMILAR TO 'P'`, 'SELECT claim_id FROM claim TABLESAMPLE SYSTEM (1)',
    `SELECT claim_id FROM claim ORDER BY claim_id USING <`, 'SELECT count(*) FROM claim c1, claim c2, claim c3, claim c4, claim c5, claim c6, claim c7, claim c8, claim c9, claim c10, claim c11, claim c12, claim c13',
    `SELECT claim_id COLLATE "C" FROM claim`, `SELECT claim_id FROM claim LIMIT (SELECT 1)`, 'VALUES (1)', 'SELECT sum(sum(paid_amount)) FROM claim',
    'SELECT claim_id FROM claim WHERE count(*) > 1', `SELECT string_agg(claim_id, ',') FROM claim`,
  ]) {
    const r = await validateSql(sql, cat('admin'), { maxRows: 10 });
    assert.equal(r.ok, false, `${sql} -> ${r.validated_sql}`);
  }
  // Redundant parentheses produce no tree nodes; nested calls and subqueries do.
  const deep = `SELECT ${'abs('.repeat(80)}paid_amount${')'.repeat(80)} FROM claim`;
  assert.equal((await validateSql(deep, cat('admin'), { maxRows: 10 })).issues[0].code, 'too_complex');
  const nested = `SELECT claim_id FROM claim WHERE ${'EXISTS (SELECT 1 FROM claim WHERE '.repeat(20)}true${')'.repeat(20)}`;
  assert.equal((await validateSql(nested, cat('admin'), { maxRows: 10 })).issues[0].code, 'too_complex');
  assert.equal((await validateSql('SELECT 1 FROM claim WHERE ' + 'true AND '.repeat(4000) + 'true', cat('admin'), { maxRows: 10 })).issues[0].code, 'too_long');
});

test('ambiguous and unknown references are rejected', async () => {
  await bad('admin', 'SELECT member_id FROM claim, member', 'ambiguous_column');
  await bad('admin', 'SELECT z.claim_id FROM claim c', 'unknown_table');
  await bad('admin', 'SELECT c.claim_id FROM claim c, member c', 'invalid_reference');
});

test('relationship joins between restricted keys are allowed only along declared relationships', async () => {
  const s = policies([{ entity: 'claim', field: 'member_id', role_access: { reporter: 'filter' } }, { entity: 'member', field: 'member_id', role_access: { reporter: 'filter' } }]);
  const c = buildCatalog(s, 'reporter');
  assert.ok((await validateSql(`SELECT c.claim_id FROM claim c WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m.member_id = c.member_id)`, c, { maxRows: 10 })).ok);
  assert.ok((await validateSql(`SELECT c.claim_id FROM claim c WHERE c.member_id IN (SELECT member_id FROM member)`, c, { maxRows: 10 })).ok);
  assert.ok((await validateSql(`SELECT c.claim_id FROM claim c JOIN pharmacy_fill p ON p.member_id = c.member_id`, c, { maxRows: 10 })).ok, 'siblings referencing the same key');
  assert.equal((await validateSql(`SELECT c.claim_id FROM claim c JOIN member m ON m.member_id = c.claim_id`, c, { maxRows: 10 })).ok, false);
  assert.equal((await validateSql(`SELECT c.claim_id FROM claim c JOIN member m ON m.zip = c.member_id`, c, { maxRows: 10 })).ok, false);
  assert.ok((await validateSql(`SELECT a.zip FROM member a JOIN member b ON a.member_id = b.member_id`, c, { maxRows: 10 })).ok, 'a key with itself');
  const op = buildCatalog(SET, 'operator');
  assert.equal((await validateSql(`SELECT a.member_id FROM member a JOIN member b ON a.ssn = b.ssn`, op, { maxRows: 10 })).ok, false, 'a self-join on a restricted non-key column reveals shared values');
});
