// Unit tests: whitelisted transforms, canonical coercion and exact decimal math.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform, TransformError } from '../../src/transform/transforms.js';
import { parseCanonical, normalizeDecimal, addDecimal, subDecimal, compareCanonical, checkConstraints, isValidDate } from '../../src/transform/coerce.js';

test('string transforms are null-preserving', () => {
  for (const op of [{ op: 'trim' }, { op: 'upper' }, { op: 'lower' }, { op: 'strip_non_digits' }, { op: 'left_pad', length: 5, char: '0' }] as const) {
    assert.equal(applyTransform(op as never, null), null, op.op);
  }
  assert.equal(applyTransform({ op: 'trim' }, '  a b '), 'a b');
  assert.equal(applyTransform({ op: 'strip_non_digits' }, '12345-6789-01'), '12345678901');
  assert.equal(applyTransform({ op: 'left_pad', length: 11, char: '0' }, '1234'), '00000001234');
  assert.equal(applyTransform({ op: 'default', value: 'X' }, ''), 'X');
  assert.equal(applyTransform({ op: 'default', value: 'X' }, null), 'X');
  assert.equal(applyTransform({ op: 'default', value: 'X' }, 'Y'), 'Y');
});

test('map_values honours the unmapped policy', () => {
  const map = { A: 'ACTIVE' };
  assert.equal(applyTransform({ op: 'map_values', map, unmapped: 'error' }, 'A'), 'ACTIVE');
  assert.equal(applyTransform({ op: 'map_values', map, unmapped: 'keep' }, 'Q'), 'Q');
  assert.equal(applyTransform({ op: 'map_values', map, unmapped: 'null' }, 'Q'), null);
  assert.throws(() => applyTransform({ op: 'map_values', map, unmapped: 'error' }, 'Q'), TransformError);
  // Prototype keys are not mappings.
  assert.throws(() => applyTransform({ op: 'map_values', map, unmapped: 'error' }, 'toString'), TransformError);
});

test('parse_date accepts only real calendar dates in the declared format', () => {
  assert.equal(applyTransform({ op: 'parse_date', format: 'MM/DD/YYYY' }, '02/29/2024'), '2024-02-29');
  assert.equal(applyTransform({ op: 'parse_date', format: 'YYYYMMDD' }, '20260131'), '2026-01-31');
  assert.equal(applyTransform({ op: 'parse_date', format: 'YYYY-MM-DD' }, '2026-3-7'), '2026-03-07');
  assert.throws(() => applyTransform({ op: 'parse_date', format: 'MM/DD/YYYY' }, '02/29/2025'), /not a valid calendar date/);
  assert.throws(() => applyTransform({ op: 'parse_date', format: 'YYYY-MM-DD' }, '2026-02-30'), /not a valid calendar date/);
  assert.throws(() => applyTransform({ op: 'parse_date', format: 'YYYY-MM-DD' }, '01/02/2026'), /expected date in YYYY-MM-DD/);
  assert.equal(isValidDate(1799, 1, 1), false);
});

test('parse_decimal handles currency formatting, accounting negatives and implied scale', () => {
  const p = (v: string, implied_scale?: number) => applyTransform({ op: 'parse_decimal', implied_scale }, v);
  assert.equal(p('$1,234.50'), '1234.50');
  assert.equal(p('(12.00)'), '-12.00');
  assert.equal(p('12345', 2), '123.45');
  assert.equal(p('5', 2), '0.05');
  assert.equal(p('-5', 2), '-0.05');
  assert.throws(() => p('1.5', 2), /implied-scale amount must not contain a decimal point/);
  assert.throws(() => p('12abc'), /not a decimal number/);
  assert.throws(() => p('1e5'), /not a decimal number/, 'no exponent notation');
});

test('parse_integer and parse_boolean reject anything ambiguous', () => {
  assert.equal(applyTransform({ op: 'parse_integer' }, ' 42 '), '42');
  assert.throws(() => applyTransform({ op: 'parse_integer' }, '4.0'), TransformError);
  const b = { op: 'parse_boolean', true_values: ['Y'], false_values: ['N'] } as const;
  assert.equal(applyTransform(b as never, 'Y'), 'true');
  assert.equal(applyTransform(b as never, 'N'), 'false');
  assert.throws(() => applyTransform(b as never, 'y'), TransformError);
});

test('decimal normalisation enforces scale and precision without rounding', () => {
  assert.deepEqual(normalizeDecimal('1.5', 2), { ok: true, value: '1.50' });
  assert.deepEqual(normalizeDecimal('007.10', 2), { ok: true, value: '7.10' });
  assert.deepEqual(normalizeDecimal('-0.00', 2), { ok: true, value: '0.00' }, 'no negative zero');
  assert.deepEqual(normalizeDecimal('1.230', 2), { ok: true, value: '1.23' }, 'trailing zeros beyond scale are not data');
  assert.equal(normalizeDecimal('1.234', 2).ok, false, 'never rounds');
  assert.equal(normalizeDecimal('123456', 2, 7).ok, false, 'integer digits exceed precision');
  assert.equal(normalizeDecimal('12345', 2, 7).ok, true);
});

test('exact decimal arithmetic for financial totals', () => {
  assert.equal(addDecimal('0.10', '0.20'), '0.30');
  assert.equal(addDecimal('999999999999.99', '0.01'), '1000000000000.00');
  assert.equal(subDecimal('10.00', '10.01'), '-0.01');
  assert.equal(subDecimal('5.5', '-1.25'), '6.75');
  assert.equal(subDecimal('1.00', '1.00'), '0.00');
  // Floating point would get this wrong.
  let s = '0.00';
  for (let i = 0; i < 1000; i++) s = addDecimal(s, '0.10');
  assert.equal(s, '100.00');
  assert.equal(compareCanonical('decimal', '10.5', '10.50'), 0);
  assert.ok(compareCanonical('decimal', '-1.00', '0.99') < 0);
});

test('parseCanonical produces stable canonical forms per type', () => {
  assert.deepEqual(parseCanonical({ type: 'integer' }, '9007199254740993'), { ok: false, error: 'integer out of range' });
  assert.deepEqual(parseCanonical({ type: 'timestamp' }, '2026-10-01T10:00:00-04:00'), { ok: true, value: '2026-10-01T14:00:00.000Z' });
  assert.equal(parseCanonical({ type: 'timestamp' }, '2026-10-01T10:00:00').ok, false, 'zone is mandatory');
  assert.equal(parseCanonical({ type: 'enum', values: ['A'] }, 'B').ok, false);
  assert.deepEqual(parseCanonical({ type: 'boolean' }, 'true'), { ok: true, value: true });
  assert.deepEqual(parseCanonical({ type: 'decimal', precision: 5, scale: 2 }, 12.5), { ok: true, value: '12.50' });
});

test('field constraints', () => {
  assert.equal(checkConstraints({ type: 'string', max_length: 3 }, 'abcd'), 'longer than 3 characters');
  assert.equal(checkConstraints({ type: 'string', format: 'npi10' }, '123'), 'does not match format npi10');
  assert.equal(checkConstraints({ type: 'string', format: 'icd10' }, 'E11.9'), null);
  assert.equal(checkConstraints({ type: 'decimal', precision: 8, scale: 2, min: 0 }, '-0.01'), 'below minimum 0');
  assert.equal(checkConstraints({ type: 'date', max: '2026-12-31' }, '2027-01-01'), 'above maximum 2026-12-31');
  assert.equal(checkConstraints({ type: 'integer', min: 1 }, null), null, 'nulls are a nullability concern, not a constraint');
});
