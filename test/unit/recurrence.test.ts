// Schedule recurrence: RRULE subset, time zones and the explicit daylight-saving rules.
// America/New_York 2026: DST starts Sun 8 March 02:00 (gap 02:00-03:00), ends Sun 1 November
// 02:00 (01:00-02:00 occurs twice).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule, describe, localToInstant, nextOccurrence, parseRule, RecurrenceError, upcoming, validateRecurrence, type Recurrence } from '../../src/analytics/recurrence.js';

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z';
const rec = (rrule: string | null, startLocal: string, timezone = 'America/New_York', untilLocal: string | null = null): Recurrence => ({ rule: parseRule(rrule), startLocal, timezone, untilLocal });
const at = (s: string) => Date.parse(s);

test('daily at a local time keeps the wall-clock time across DST; the spring-forward gap shifts forward', () => {
  const r = rec('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', '2026-03-06T02:30');
  assert.deepEqual(upcoming(r, at('2026-03-01T00:00Z'), 4).map(iso), [
    '2026-03-06T07:30Z',   // 02:30 EST
    '2026-03-07T07:30Z',   // 02:30 EST
    '2026-03-08T07:30Z',   // 02:30 does not exist: runs at 03:30 EDT (same offset as before the gap)
    '2026-03-09T06:30Z',   // 02:30 EDT
  ]);
  const daily6 = rec('FREQ=DAILY;BYHOUR=6;BYMINUTE=0', '2026-03-07T06:00');
  assert.deepEqual(upcoming(daily6, at('2026-03-07T00:00Z'), 3).map(iso), ['2026-03-07T11:00Z', '2026-03-08T10:00Z', '2026-03-09T10:00Z']);
});

test('fall-back overlap: an ambiguous local time runs once, at its first occurrence', () => {
  const r = rec('FREQ=DAILY;BYHOUR=1;BYMINUTE=30', '2026-10-30T01:30');
  assert.deepEqual(upcoming(r, at('2026-10-30T00:00Z'), 4).map(iso), ['2026-10-30T05:30Z', '2026-10-31T05:30Z', '2026-11-01T05:30Z', '2026-11-02T06:30Z']);
  assert.equal(localToInstant({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, 'America/New_York'), at('2026-11-01T05:30Z'));
});

test('hourly counts elapsed hours: no skipped or repeated run across a DST change', () => {
  const r = rec('FREQ=HOURLY;INTERVAL=1', '2026-11-01T00:00');
  const runs = upcoming(r, at('2026-11-01T03:00Z'), 4);
  assert.deepEqual(runs.map(iso), ['2026-11-01T04:00Z', '2026-11-01T05:00Z', '2026-11-01T06:00Z', '2026-11-01T07:00Z']);
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i] - runs[i - 1], 3600_000);
});

test('weekly on chosen days of every second week; monthly day 31 skips short months, -1 is the last day', () => {
  const w = rec('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0', '2026-01-05T09:00', 'UTC');
  assert.deepEqual(upcoming(w, at('2026-01-01T00:00Z'), 5).map(iso), ['2026-01-05T09:00Z', '2026-01-08T09:00Z', '2026-01-19T09:00Z', '2026-01-22T09:00Z', '2026-02-02T09:00Z']);
  const m31 = rec('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=7;BYMINUTE=0', '2026-01-31T07:00', 'UTC');
  assert.deepEqual(upcoming(m31, at('2026-01-01T00:00Z'), 3).map(iso), ['2026-01-31T07:00Z', '2026-03-31T07:00Z', '2026-05-31T07:00Z']);
  const last = rec('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=23;BYMINUTE=0', '2026-01-31T23:00', 'Europe/London');
  assert.deepEqual(upcoming(last, at('2026-01-01T00:00Z'), 4).map(iso), ['2026-01-31T23:00Z', '2026-02-28T23:00Z', '2026-03-31T22:00Z', '2026-04-30T22:00Z']);
});

test('once, start and end bounds', () => {
  const once = rec(null, '2026-06-01T08:15', 'Asia/Tokyo');
  assert.equal(iso(nextOccurrence(once, at('2026-01-01T00:00Z'))!), '2026-05-31T23:15Z');
  assert.equal(nextOccurrence(once, at('2026-06-01T00:00Z')), null);
  const bounded = rec('FREQ=DAILY', '2026-02-01T10:00', 'UTC', '2026-02-03T10:00');
  assert.deepEqual(upcoming(bounded, at('2026-01-01T00:00Z'), 10).map(iso), ['2026-02-01T10:00Z', '2026-02-02T10:00Z', '2026-02-03T10:00Z']);
  // Never before the start, even when asked from far earlier.
  assert.equal(iso(nextOccurrence(rec('FREQ=DAILY', '2026-07-04T00:00', 'UTC'), 0)!), '2026-07-04T00:00Z');
});

test('invalid rules, zones and times are rejected server-side with the field at fault', () => {
  for (const bad of ['FREQ=YEARLY', 'FREQ=DAILY;COUNT=3', 'FREQ=DAILY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=HOURLY;BYHOUR=3', 'FREQ=DAILY;INTERVAL=0', 'FREQ']) {
    assert.throws(() => parseRule(bad), RecurrenceError, bad);
  }
  assert.throws(() => validateRecurrence(rec('FREQ=DAILY', '2026-01-01T09:00', 'Mars/Olympus')), /Unknown time zone/);
  assert.throws(() => validateRecurrence(rec('FREQ=DAILY', '2026-02-30T09:00')), /not a valid date/);
  assert.throws(() => validateRecurrence(rec('FREQ=DAILY', '2026-02-10T09:00', 'UTC', '2026-02-01T09:00')), /until must be after/);
  assert.equal(compileRule({ frequency: 'weekly', weekdays: ['mo', 'fr'], at: '07:45' }), 'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=7;BYMINUTE=45');
  assert.equal(compileRule({ frequency: 'once' }), null);
  assert.equal(describe(rec('FREQ=DAILY;BYHOUR=6;BYMINUTE=0', '2026-03-07T06:00')), 'Daily at 06:00 (America/New_York)');
});
