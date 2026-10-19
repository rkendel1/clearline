// Field policy semantics: masking styles and which changes count as widening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskValue } from '../../src/policy/mask.js';
import { classifyChange, defaultPolicy, PolicySet, type FieldPolicy } from '../../src/policy/fields.js';
import type { Contract } from '../../src/contracts/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NW: Contract = JSON.parse(readFileSync(path.join(root, 'contracts/northwind/v1.json'), 'utf8'));

test('masking styles', () => {
  assert.equal(maskValue('912-34-5678', 'last4'), '***-**-5678');
  assert.equal(maskValue('1234567890', 'last4'), '******7890');
  assert.equal(maskValue('ab-1', 'last4'), '**-*');
  assert.equal(maskValue('Alice', 'first_initial'), 'A***');
  assert.equal(maskValue('1980-02-03', 'year_only'), '1980-**-**');
  assert.equal(maskValue('n/a', 'year_only'), '[redacted]');
  assert.equal(maskValue('anything', 'full'), '[redacted]');
  assert.equal(maskValue('anything', 'full', 'REDACTED'), 'REDACTED');
  assert.equal(maskValue(null, 'last4'), null);
});

test('contract defaults reproduce the pre-existing rule: pii/phi sensitive, unmasked for admins only', () => {
  const set = new PolicySet('northwind', NW, new Map(), 0);
  assert.deepEqual(defaultPolicy(NW, 'member', 'ssn').unmask_roles, ['admin']);
  assert.equal(set.access('admin', 'member', 'last_name'), 'full');
  assert.equal(set.access('operator', 'member', 'last_name'), 'masked');
  assert.equal(set.access('reporter', 'member', 'date_of_birth'), 'masked');
  assert.equal(set.access('reporter', 'claim', 'paid_amount'), 'full');
  assert.equal(set.access('approver', 'claim', 'paid_amount'), 'hidden');
  assert.equal(set.access('platform_admin', 'claim', 'paid_amount'), 'hidden');
  assert.equal(set.access('admin', 'claim', 'no_such_field'), 'hidden');
});

test('change classification: anything that is not strictly narrowing is widening', () => {
  const base: FieldPolicy = { ...defaultPolicy(NW, 'claim', 'provider_npi') };
  const k = (after: Partial<FieldPolicy>, before: FieldPolicy = base) => classifyChange(before, { ...before, ...after }).kind;
  assert.equal(k({ sensitive: true, redaction: 'last4', reason: 'x' }), 'tighten', 'marking sensitive, even with a partial mask');
  const sens = { ...base, sensitive: true, redaction: 'full' as const, reason: 'x' };
  assert.equal(k({ redaction: 'last4' }, sens), 'loosen', 'full -> partial reveals more');
  assert.equal(k({ redaction: 'full' }, { ...sens, redaction: 'last4' }), 'tighten');
  assert.equal(k({ sensitive: false }, sens), 'loosen');
  assert.equal(k({ unmask_roles: [] }, sens), 'tighten');
  assert.equal(k({ unmask_roles: ['admin', 'steward'] }, sens), 'loosen');
  assert.equal(k({ role_access: { reporter: 'hidden' } }), 'tighten');
  assert.equal(k({ role_access: {} }, { ...base, role_access: { reporter: 'filter' } }), 'loosen');
  assert.equal(k({ role_access: { reporter: 'hidden' }, unmask_roles: ['admin', 'steward'] }, sens), 'mixed');
  assert.equal(k({ reason: 'new wording' }, sens), 'none');
});
