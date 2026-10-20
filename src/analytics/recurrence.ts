// Schedule recurrence: a subset of RFC 5545 RRULE, evaluated in an IANA time zone.
//
// A schedule has a local wall-clock start (start_local, "YYYY-MM-DDTHH:MM"), a time zone, an
// optional local end (until_local) and an optional RRULE. Supported rules:
//   (none)                                         once, at start_local
//   FREQ=HOURLY;INTERVAL=n                         every n hours of ELAPSED time from the start instant
//   FREQ=DAILY;INTERVAL=n;BYHOUR=h;BYMINUTE=m      every n days at h:m local time
//   FREQ=WEEKLY;INTERVAL=n;BYDAY=MO,TH;BYHOUR..    on those weekdays of every n-th week (weeks start Monday)
//   FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=d|-1;BYHOUR..  on day d (or the last day) of every n-th month
// BYHOUR/BYMINUTE default to the start time. Anything else is rejected.
//
// Daylight saving (as RFC 5545 specifies for local times):
//   - a local time that does not exist (spring-forward gap) runs at the same offset as before the
//     gap, i.e. shifted forward by the gap (02:30 -> 03:30 on a 1-hour change);
//   - a local time that occurs twice (fall-back overlap) runs once, at the first occurrence;
//   - hourly schedules count elapsed hours, so they neither skip nor repeat across a change.
// Monthly rules skip months without the requested day (BYMONTHDAY=31 skips 30-day months);
// BYMONTHDAY=-1 means the last day of every month.

export type Freq = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof DAYS)[number];

export interface Rule { freq: Freq; interval: number; byHour: number | null; byMinute: number | null; byDay: Weekday[]; byMonthDay: number | null }

export interface Recurrence { rule: Rule | null; startLocal: string; timezone: string; untilLocal: string | null }

export class RecurrenceError extends Error { constructor(readonly field: string, message: string) { super(message); } }

/** Structured form the client sends (compiled to an RRULE string, which is what is stored). */
export interface RecurrenceInput {
  frequency: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  interval?: number; at?: string; weekdays?: string[]; month_day?: number;
}

export function compileRule(r: RecurrenceInput): string | null {
  if (r.frequency === 'once') return null;
  const parts = [`FREQ=${r.frequency.toUpperCase()}`];
  if (r.interval && r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.frequency === 'weekly' && r.weekdays?.length) parts.push(`BYDAY=${r.weekdays.map((d) => d.toUpperCase()).join(',')}`);
  if (r.frequency === 'monthly' && r.month_day !== undefined) parts.push(`BYMONTHDAY=${r.month_day}`);
  if (r.at && r.frequency !== 'hourly') {
    const m = /^(\d{2}):(\d{2})$/.exec(r.at);
    if (!m) throw new RecurrenceError('at', 'at must be HH:MM.');
    parts.push(`BYHOUR=${Number(m[1])}`, `BYMINUTE=${Number(m[2])}`);
  }
  return parts.join(';');
}

export function parseRule(text: string | null): Rule | null {
  if (text === null || text === '') return null;
  const kv = new Map<string, string>();
  for (const part of text.split(';')) {
    const [k, v, extra] = part.split('=');
    if (!k || v === undefined || extra !== undefined || kv.has(k)) throw new RecurrenceError('rrule', `Malformed RRULE part "${part}".`);
    kv.set(k.toUpperCase(), v.toUpperCase());
  }
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYDAY', 'BYMONTHDAY']);
  for (const k of kv.keys()) if (!allowed.has(k)) throw new RecurrenceError('rrule', `RRULE ${k} is not supported (supported: ${[...allowed].join(', ')}; use until for an end).`);
  const freq = kv.get('FREQ') as Freq;
  if (!['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) throw new RecurrenceError('rrule', 'FREQ must be HOURLY, DAILY, WEEKLY or MONTHLY.');
  const intOf = (k: string, lo: number, hi: number) => {
    const v = kv.get(k);
    if (v === undefined) return null;
    if (!/^-?\d+$/.test(v) || Number(v) < lo || Number(v) > hi) throw new RecurrenceError('rrule', `${k} must be an integer between ${lo} and ${hi}.`);
    return Number(v);
  };
  const interval = intOf('INTERVAL', 1, freq === 'HOURLY' ? 168 : 366) ?? 1;
  const byHour = intOf('BYHOUR', 0, 23);
  const byMinute = intOf('BYMINUTE', 0, 59);
  const byDay = kv.has('BYDAY') ? kv.get('BYDAY')!.split(',') as Weekday[] : [];
  if (byDay.some((d) => !DAYS.includes(d))) throw new RecurrenceError('rrule', 'BYDAY must list MO, TU, WE, TH, FR, SA or SU.');
  if (byDay.length && freq !== 'WEEKLY') throw new RecurrenceError('rrule', 'BYDAY is supported with FREQ=WEEKLY only.');
  const byMonthDay = intOf('BYMONTHDAY', -1, 31);
  if (byMonthDay === 0) throw new RecurrenceError('rrule', 'BYMONTHDAY must be 1-31 or -1.');
  if (byMonthDay !== null && freq !== 'MONTHLY') throw new RecurrenceError('rrule', 'BYMONTHDAY is supported with FREQ=MONTHLY only.');
  if (freq === 'HOURLY' && (byHour !== null || byMinute !== null)) throw new RecurrenceError('rrule', 'Hourly schedules run at the start minute; BYHOUR/BYMINUTE are not supported with FREQ=HOURLY.');
  return { freq, interval, byHour, byMinute, byDay: [...new Set(byDay)], byMonthDay };
}

export function formatRule(r: Rule | null): string | null {
  if (!r) return null;
  const p = [`FREQ=${r.freq}`];
  if (r.interval !== 1) p.push(`INTERVAL=${r.interval}`);
  if (r.byDay.length) p.push(`BYDAY=${r.byDay.join(',')}`);
  if (r.byMonthDay !== null) p.push(`BYMONTHDAY=${r.byMonthDay}`);
  if (r.byHour !== null) p.push(`BYHOUR=${r.byHour}`);
  if (r.byMinute !== null) p.push(`BYMINUTE=${r.byMinute}`);
  return p.join(';');
}

// ------------------------------------------------------------------ time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz: string): boolean {
  try { formatter(tz); return true; } catch { return false; }
}

interface Local { y: number; mo: number; d: number; h: number; mi: number }

export function localParts(ms: number, tz: string): Local {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute) };
}

/** UTC offset (ms) of `tz` at instant `ms`. */
function offset(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  const s = new Date(ms).getUTCSeconds();
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, s) - Math.floor(ms / 1000) * 1000;
}

/** Instant of a local wall-clock time, applying the RFC 5545 gap and overlap rules above. */
export function localToInstant(l: Local, tz: string): number {
  const guess = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  const before = offset(guess - 36 * 3600_000, tz);
  const after = offset(guess + 36 * 3600_000, tz);
  const matches = (t: number) => { const p = localParts(t, tz); return p.y === l.y && p.mo === l.mo && p.d === l.d && p.h === l.h && p.mi === l.mi; };
  const candidates = [...new Set([guess - before, guess - after])].filter(matches).sort((a, b) => a - b);
  if (candidates.length) return candidates[0];   // overlap: first occurrence
  return guess - before;                          // gap: offset from before the transition
}

const parseLocal = (s: string): Local => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new RecurrenceError('start_local', 'Local times must be YYYY-MM-DDTHH:MM.');
  const l = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  const check = new Date(Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi));
  if (check.getUTCMonth() !== l.mo - 1 || check.getUTCDate() !== l.d || l.h > 23 || l.mi > 59) throw new RecurrenceError('start_local', `${s} is not a valid date and time.`);
  return l;
};

export function validateRecurrence(r: Recurrence): void {
  if (!validTimeZone(r.timezone)) throw new RecurrenceError('timezone', `Unknown time zone "${r.timezone}" (use an IANA name such as America/New_York).`);
  parseLocal(r.startLocal);
  if (r.untilLocal) { parseLocal(r.untilLocal); if (r.untilLocal <= r.startLocal) throw new RecurrenceError('until_local', 'until must be after the start.'); }
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dayNumber = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);
const weekdayOf = (y: number, mo: number, d: number) => DAYS[(new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7];

/** First occurrence strictly after `afterMs` (epoch ms), or null when the schedule has ended. */
export function nextOccurrence(r: Recurrence, afterMs: number): number | null {
  const start = parseLocal(r.startLocal);
  const startMs = localToInstant(start, r.timezone);
  const untilMs = r.untilLocal ? localToInstant(parseLocal(r.untilLocal), r.timezone) : Infinity;
  const done = (t: number | null) => (t === null || t > untilMs ? null : t);
  const rule = r.rule;
  if (!rule) return done(startMs > afterMs ? startMs : null);
  if (rule.freq === 'HOURLY') {
    const step = rule.interval * 3600_000;
    if (afterMs < startMs) return done(startMs);
    return done(startMs + (Math.floor((afterMs - startMs) / step) + 1) * step);
  }
  const h = rule.byHour ?? start.h;
  const mi = rule.byMinute ?? start.mi;
  const startDay = dayNumber(start.y, start.mo, start.d);
  const from = localParts(Math.max(afterMs, startMs - 86_400_000), r.timezone);
  let day = Math.max(dayNumber(from.y, from.mo, from.d) - 1, startDay);
  // Bounded search: far enough for the sparsest rule (every 366 months, or a 31st every few months).
  const limit = day + (rule.freq === 'MONTHLY' ? 31 * 12 * rule.interval + 62 : rule.freq === 'WEEKLY' ? 7 * rule.interval + 14 : rule.interval + 2);
  for (; day <= limit; day++) {
    const dt = new Date(day * 86_400_000);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    let ok = false;
    if (rule.freq === 'DAILY') ok = (day - startDay) % rule.interval === 0;
    else if (rule.freq === 'WEEKLY') {
      const weekIdx = Math.floor((day - (startDay - ((new Date(startDay * 86_400_000).getUTCDay() + 6) % 7))) / 7);
      const days = rule.byDay.length ? rule.byDay : [weekdayOf(start.y, start.mo, start.d)];
      ok = weekIdx % rule.interval === 0 && days.includes(weekdayOf(y, mo, d));
    } else {
      const months = (y - start.y) * 12 + (mo - start.mo);
      const want = rule.byMonthDay ?? start.d;
      const target = want === -1 ? daysInMonth(y, mo) : want;
      ok = months >= 0 && months % rule.interval === 0 && d === target;
    }
    if (!ok) continue;
    const t = localToInstant({ y, mo, d, h, mi }, r.timezone);
    if (t > afterMs && t >= startMs) return done(t);
  }
  return null;
}

/** The next `n` occurrences after `afterMs` (for previews). */
export function upcoming(r: Recurrence, afterMs: number, n: number): number[] {
  const out: number[] = [];
  let t = afterMs;
  while (out.length < n) {
    const x = nextOccurrence(r, t);
    if (x === null) break;
    out.push(x);
    t = x;
  }
  return out;
}

/** Human description, e.g. "Daily at 06:00 (America/New_York)". */
export function describe(r: Recurrence): string {
  const rule = r.rule;
  const at = (h: number | null, m: number | null) => {
    const s = r.startLocal.slice(11);
    return h === null && m === null ? s : `${String(h ?? Number(s.slice(0, 2))).padStart(2, '0')}:${String(m ?? Number(s.slice(3))).padStart(2, '0')}`;
  };
  const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  let text: string;
  if (!rule) text = `Once at ${r.startLocal.replace('T', ' ')}`;
  else if (rule.freq === 'HOURLY') text = `${every(rule.interval, 'hour')} from ${r.startLocal.replace('T', ' ')}`;
  else if (rule.freq === 'DAILY') text = `${rule.interval === 1 ? 'Daily' : every(rule.interval, 'day')} at ${at(rule.byHour, rule.byMinute)}`;
  else if (rule.freq === 'WEEKLY') text = `${rule.interval === 1 ? 'Weekly' : every(rule.interval, 'week')} on ${(rule.byDay.length ? rule.byDay : [weekdayOf(...(r.startLocal.slice(0, 10).split('-').map(Number) as [number, number, number]))]).join(', ')} at ${at(rule.byHour, rule.byMinute)}`;
  else text = `${rule.interval === 1 ? 'Monthly' : every(rule.interval, 'month')} on ${rule.byMonthDay === -1 ? 'the last day' : `day ${rule.byMonthDay ?? Number(r.startLocal.slice(8, 10))}`} at ${at(rule.byHour, rule.byMinute)}`;
  return `${text} (${r.timezone})${r.untilLocal ? `, until ${r.untilLocal.replace('T', ' ')}` : ''}`;
}
