// Pure parts of the assistant's data path: period parsing against a fixed clock, metric selection, planning,
// exact number formatting, and the argument limits. No database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeriod, planQuestion, priorWindow, pickMeasure, type MeasureInfo } from '../../src/assistant/planner.js';
import { fmt } from '../../src/assistant/data.js';
import { addDays, toolNames, toolSchemas } from '../../src/assistant/tools.js';
import { classify } from '../../src/assistant/router.js';

const TODAY = '2026-10-20';   // a Tuesday
const M: MeasureInfo[] = [
  { id: 'claims_total', title: 'Claims', description: 'Distinct claims (current adjudication) in any status.', supportsPeriods: true, dimensions: ['status'], aggregation: 'count' },
  { id: 'paid_claims', title: 'Paid claims', description: 'Claims whose current adjudication status is PAID.', supportsPeriods: true, dimensions: ['status'], aggregation: 'count' },
  { id: 'total_paid', title: 'Total paid (medical)', description: 'Sum of paid_amount over current claim versions with status PAID or REVERSED.', supportsPeriods: true, dimensions: ['status'], aggregation: 'sum' },
  { id: 'total_billed', title: 'Total billed (medical)', description: 'Sum of billed_amount over all current claim versions.', supportsPeriods: true, dimensions: [], aggregation: 'sum' },
  { id: 'rx_plan_paid', title: 'Pharmacy plan paid', description: 'Sum of plan_paid over current FILLED pharmacy fills.', supportsPeriods: true, dimensions: [], aggregation: 'sum' },
  { id: 'active_members', title: 'Active members', description: 'Members whose current eligibility status is ACTIVE.', supportsPeriods: false, dimensions: [], aggregation: 'count' },
];

test('periods resolve to exact dates relative to the clock', () => {
  const p = (q: string) => parsePeriod(q, TODAY);
  assert.deepEqual([p('last month')!.from, p('last month')!.to], ['2026-09-01', '2026-09-30']);
  assert.deepEqual([p('this month')!.from, p('this month')!.to], ['2026-10-01', TODAY]);
  assert.deepEqual([p('the last 30 days')!.from, p('the last 30 days')!.to], ['2026-09-21', TODAY]);
  assert.deepEqual([p('last week')!.from, p('last week')!.to], ['2026-10-12', '2026-10-18']);
  assert.deepEqual([p('last quarter')!.from, p('last quarter')!.to], ['2026-07-01', '2026-09-30']);
  assert.deepEqual([p('last year')!.from, p('last year')!.to], ['2025-01-01', '2025-12-31']);
  assert.deepEqual([p('year to date')!.from, p('year to date')!.to], ['2026-01-01', TODAY]);
  assert.deepEqual([p('in 2026-02')!.from, p('in 2026-02')!.to], ['2026-02-01', '2026-02-28']);
  assert.deepEqual([p('in March')!.from, p('in March')!.to], ['2026-03-01', '2026-03-31']);
  assert.deepEqual([p('from 2026-05-01 to 2026-05-31')!.from, p('from 2026-05-01 to 2026-05-31')!.to], ['2026-05-01', '2026-05-31']);
  assert.deepEqual([p('since 2026-06-15')!.from, p('since 2026-06-15')!.to], ['2026-06-15', TODAY]);
  assert.equal(p('what is the total paid'), null);
  assert.equal(parsePeriod('last month', '2026-01-15')!.from, '2025-12-01', 'December rolls into the previous year');
  assert.deepEqual(parsePeriod('last quarter', '2026-02-10'), { from: '2025-10-01', to: '2025-12-31', label: 'the previous calendar quarter' });
});

test('the comparison window is the month before for whole months and an equal-length window otherwise', () => {
  assert.deepEqual(priorWindow({ from: '2026-09-01', to: '2026-09-30', label: '' }), { from: '2026-08-01', to: '2026-08-31', label: 'the month before' });
  assert.deepEqual(priorWindow({ from: '2026-01-01', to: '2026-01-31', label: '' }), { from: '2025-12-01', to: '2025-12-31', label: 'the month before' });
  const w = priorWindow({ from: '2026-09-21', to: '2026-10-20', label: '' });
  assert.deepEqual([w.from, w.to], ['2026-08-22', '2026-09-20']);
});

test('metric selection follows the question, and ambiguity is reported instead of guessed', () => {
  assert.equal(pickMeasure('What was the total paid amount?', M).measure?.id, 'total_paid');
  assert.equal(pickMeasure('How much did we bill in total?', M).measure?.id, 'total_billed');
  assert.equal(pickMeasure('What is the pharmacy plan paid amount?', M).measure?.id, 'rx_plan_paid');
  assert.equal(pickMeasure('How many claims are there?', M).measure?.id, 'claims_total');
  assert.equal(pickMeasure('How many paid claims?', M).measure?.id, 'paid_claims');
  assert.equal(pickMeasure('what is the weather', M).measure, undefined);
});

test('planning produces only known tools with absolute dates', () => {
  const plan = (q: string) => planQuestion(q, TODAY, M);
  const c = (q: string) => (plan(q) as { calls: { tool: string; args: Record<string, unknown> }[] }).calls;
  assert.deepEqual(c('What was the total paid amount last month?')[0], { tool: 'measure_by_period', args: { measure: 'total_paid', from: '2026-09-01', to: '2026-09-30', grain: 'none' } });
  assert.deepEqual(c('Compare claims last month with the month before')[0], { tool: 'compare_periods', args: { measure: 'claims_total', a_from: '2026-08-01', a_to: '2026-08-31', b_from: '2026-09-01', b_to: '2026-09-30' } });
  assert.equal(c('How many claims by status last quarter?')[0].args.dimension, 'status');
  assert.equal(c('claims per month in 2026-03')[0].args.grain, 'month');
  assert.deepEqual(c('What is the total paid amount?')[0], { tool: 'metric_current', args: { measure: 'total_paid' } });
  assert.equal(c('What is the exception rate last month?')[0].tool, 'quality_summary');
  assert.equal(c('Is reconciliation passing right now?')[0].tool, 'reconciliation_status');
  assert.equal(c('Which metrics can I ask about?')[0].tool, 'list_metrics');
  // A metric without a date field reports only a current value and says so.
  const am = plan('How many active members last month?') as { calls: { tool: string }[]; note?: string };
  assert.equal(am.calls[0].tool, 'metric_current'); assert.match(am.note ?? '', /current value/);
  assert.ok('clarify' in plan('Compare it'));
  assert.ok('clarify' in plan('How many claims by month?'), 'a trend needs a period');
  for (const q of ['total paid last month; DROP TABLE x', "total paid in 2026-03' OR 1=1"]) for (const k of c(q)) assert.ok(toolNames().includes(k.tool as never));
});

test('exact decimals are formatted without changing their digits', () => {
  assert.equal(fmt('189670.45', 'usd'), '$189,670.45'); assert.equal(fmt('1234567'), '1,234,567'); assert.equal(fmt('-1200.50', 'usd'), '-$1,200.50');
  assert.equal(fmt('0.00', 'percent'), '0.00%'); assert.equal(fmt('12.5', 'percent'), '12.5%'); assert.equal(fmt(null), 'no value'); assert.equal(fmt('PAID'), 'PAID');
  assert.equal(fmt('123456789012345678.99', 'usd'), '$123,456,789,012,345,678.99', 'no floating-point rounding');
});

test('tool schemas expose no SQL parameter, and signed-in-only tools are hidden from anonymous callers', () => {
  const pub = toolSchemas('public'), authed = toolSchemas('authenticated');
  for (const t of authed) assert.ok(!JSON.stringify(t.input_schema).match(/"sql"|"query"|"statement"/), t.name);
  assert.ok(!pub.some((t) => t.name === 'recent_runs' || t.name === 'run_insights'));
  assert.ok(authed.some((t) => t.name === 'recent_runs'));
  for (const t of authed) assert.equal((t.input_schema as { additionalProperties: boolean }).additionalProperties, false, t.name);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('routing sends current-value and status questions to the data path, design questions to retrieval', () => {
  for (const q of ['What is the exception rate?', 'How many claims were quarantined last month?', 'Is reconciliation passing right now?', 'What was the total paid amount last month?']) assert.equal(classify(q), 'data', q);
  for (const q of ['How does reconciliation decide trust?', 'Why does the platform quarantine rows?', 'Explain how the exception rate is defined']) assert.notEqual(classify(q), 'data', q);
});
