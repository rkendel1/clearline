// Rule-based planning of data questions: which tool, with which arguments. Pure functions (the clock is an
// argument), deterministic and offline. A model planner exists for questions these rules cannot map, but it can
// only choose among the same tools and its arguments go through the same validation.

import type { ToolCall } from './tools.js';
import { addDays } from './tools.js';
import { tokenize } from './embed.js';

export interface Win { from: string; to: string; label: string }
export interface MeasureInfo { id: string; title: string; description: string; supportsPeriods: boolean; dimensions: string[]; aggregation?: string }
export type Plan = { calls: ToolCall[]; note?: string } | { clarify: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthWin = (y: number, m: number, label: string): Win => ({ from: iso(utc(y, m, 1)), to: iso(utc(y, m + 1, 0)), label });

/** The period a question names, as exact dates. `today` is the current UTC date. Returns null when no period is named. */
export function parsePeriod(q: string, today: string): Win | null {
  const s = q.toLowerCase();
  const t = new Date(`${today}T00:00:00Z`);
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  let r: RegExpExecArray | null;
  if ((r = /\b(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|and|through|until)\s+(\d{4}-\d{2}-\d{2})/.exec(s))) return { from: r[1], to: r[2], label: `${r[1]} to ${r[2]}` };
  if ((r = /\bsince\s+(\d{4}-\d{2}-\d{2})/.exec(s))) return { from: r[1], to: today, label: `since ${r[1]}` };
  if ((r = /\b(?:in|during|for)\s+(\d{4})-(\d{2})\b(?!-)/.exec(s))) return monthWin(Number(r[1]), Number(r[2]) - 1, `${r[1]}-${r[2]}`);
  if ((r = new RegExp(`\\b(?:in|during|for)\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`).exec(s))) {
    const mi = MONTHS.indexOf(r[1]);
    const yr = r[2] ? Number(r[2]) : mi > m ? y - 1 : y;
    return monthWin(yr, mi, `${r[1]} ${yr}`);
  }
  if (/\b(last|previous|prior) month\b/.test(s)) return monthWin(y, m - 1, 'the previous calendar month');
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(s)) return { from: iso(utc(y, m, 1)), to: today, label: 'this month to date' };
  if (/\b(last|previous|prior) quarter\b/.test(s)) { const q0 = Math.floor(m / 3) * 3 - 3; return { from: iso(utc(y, q0, 1)), to: iso(utc(y, q0 + 3, 0)), label: 'the previous calendar quarter' }; }
  if (/\b(last|previous|prior) year\b/.test(s)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `${y - 1}` };
  if (/\bthis year\b|\byear to date\b|\bytd\b/.test(s)) return { from: `${y}-01-01`, to: today, label: 'this year to date' };
  if (/\b(last|previous|prior) week\b/.test(s)) { const dow = (t.getUTCDay() + 6) % 7; const mon = addDays(today, -dow - 7); return { from: mon, to: addDays(mon, 6), label: 'the previous Monday to Sunday week' }; }
  if (/\bthis week\b/.test(s)) { const dow = (t.getUTCDay() + 6) % 7; return { from: addDays(today, -dow), to: today, label: 'this week to date' }; }
  if ((r = /\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b/.exec(s))) {
    const n = Number(r[1]);
    if (r[2] === 'month') return { from: iso(utc(y, m - n + 1, 1)), to: today, label: `the last ${n} month(s) to date` };
    const days = r[2] === 'week' ? n * 7 : n;
    return { from: addDays(today, -(days - 1)), to: today, label: `the last ${days} days` };
  }
  if (/\byesterday\b/.test(s)) return { from: addDays(today, -1), to: addDays(today, -1), label: 'yesterday' };
  if (/\btoday\b/.test(s)) return { from: today, to: today, label: 'today' };
  return null;
}

/** The window of equal length immediately before `w`; for whole calendar months, the previous month. */
export function priorWindow(w: Win): Win {
  const from = new Date(`${w.from}T00:00:00Z`), to = new Date(`${w.to}T00:00:00Z`);
  const wholeMonth = from.getUTCDate() === 1 && iso(utc(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)) === w.to;
  if (wholeMonth) return monthWin(from.getUTCFullYear(), from.getUTCMonth() - 1, 'the month before');
  const days = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  return { from: addDays(w.from, -days), to: addDays(w.from, -1), label: 'the preceding period of equal length' };
}

const SYN: [RegExp, string[]][] = [
  [/\bpaid\b|\bpayments?\b|\bspend\b|\bpaid out\b/, ['paid']], [/\bbill(?:ed|ing|ings|s)?\b/, ['billed']], [/\bdenied\b|\bdenials?\b/, ['denied']],
  [/\bclaims?\b/, ['claim', 'claims']], [/\bmembers?\b|\benrollees?\b/, ['member', 'members', 'enrollee', 'enrollees']], [/\bpharmacy\b|\brx\b|\bfills?\b|\bprescriptions?\b/, ['pharmacy', 'rx', 'fills', 'fill']],
  [/\bplan cost\b|\bplan paid\b/, ['plan']], [/\bcopay\b/, ['copay']], [/\bactive\b/, ['active']], [/\butili[sz]ing\b/, ['utilizing']],
];
/** Pick the declared metric a question is about. Ambiguity is reported, not guessed. */
export function pickMeasure(q: string, measures: MeasureInfo[]): { measure?: MeasureInfo; options?: MeasureInfo[] } {
  const words = new Set(tokenize(q));
  for (const [re, ws] of SYN) if (re.test(q.toLowerCase())) ws.forEach((w) => words.add(w));
  const asksAmount = /\b(amount|dollars?|\$|usd|total|sum|spend|cost)\b/i.test(q);
  const asksCount = /\b(how many|number of|count)\b/i.test(q);
  const scored = measures.map((m) => {
    const hay = new Set(tokenize(`${m.id.replace(/_/g, ' ')} ${m.title} ${m.description}`));
    let s = 0;
    for (const w of words) if (hay.has(w)) s += tokenize(m.title).includes(w) || m.id.split('_').includes(w) ? 2 : 1;
    if (new RegExp(`\\b${m.title.toLowerCase().replace(/[^a-z0-9 ]/g, '')}\\b`).test(q.toLowerCase().replace(/[^a-z0-9 ]/g, ''))) s += 3;   // the exact metric title appears in the question
    const isAmount = /sum|usd|\$/i.test(m.description) || /total|paid|billed|cost/i.test(m.id) && !/claims$/.test(m.id);
    if (asksAmount && /(total|plan_paid|plan_cost)/.test(m.id)) s += 2;
    if (asksAmount && (m.aggregation === 'count' || m.aggregation === 'count_distinct')) s -= 2;
    // How much of the metric's own name the question covers: "total paid amount" covers most of "Total paid (medical)", little of "Pharmacy plan paid".
    const nameTokens = tokenize(m.title);
    if (nameTokens.length) s += 2 * (nameTokens.filter((w) => words.has(w)).length / nameTokens.length);
    if (asksCount && !isAmount) s += 1;
    return { m, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return {};
  if (scored.length > 1 && scored[0].s - scored[1].s < 2) return { options: scored.slice(0, 3).map((x) => x.m) };
  return { measure: scored[0].m };
}

/** Plan a data question. `today` is injected so tests are deterministic. */
export function planQuestion(q: string, today: string, measures: MeasureInfo[]): Plan {
  const s = q.toLowerCase();
  const period = parsePeriod(q, today);
  if (/\b(reconcil\w*)\b/.test(s)) return { calls: [{ tool: 'reconciliation_status', args: {} }] };
  if (/\b(rejection|rejected|reject rate|exception rate|exceptions?|quarantin\w*|data quality|error rate)\b/.test(s)) {
    const w = period ?? { from: addDays(today, -1829), to: today, label: 'the last five years' };
    return { calls: [{ tool: 'quality_summary', args: { from: w.from, to: w.to } }], note: period ? undefined : 'No period was named, so the last five years (the longest window allowed) are included.' };
  }
  if (/\b(which|what|list|show|available)\b.*\b(metrics|measures)\b|\bwhat can i ask\b/.test(s)) return { calls: [{ tool: 'list_metrics', args: {} }] };
  const { measure, options } = pickMeasure(q, measures);
  if (!measure) return { clarify: options ? `That could mean more than one metric: ${options.map((o) => `"${o.title}"`).join(', ')}. Which one?` : 'I could not tell which metric you mean.' };
  const m = measure;
  const compare = /\b(compare|compared|versus|vs\.?|than|change|changed|difference|trend|up or down|increase|decrease)\b/.test(s);
  const grain = /\b(by|per|each)\s+month|monthly\b/.test(s) ? 'month' : /\b(by|per|each)\s+week|weekly\b/.test(s) ? 'week' : /\b(by|per|each)\s+day|daily\b/.test(s) ? 'day' : 'none';
  const dimension = m.dimensions.find((d) => new RegExp(`\\bby\\s+${d.replace(/_/g, '[ _]')}\\b`).test(s));
  if (!period) {
    if (compare || grain !== 'none' || dimension) return { clarify: 'Which period? For example "last month", "the last 30 days", or "from 2026-01-01 to 2026-03-31".' };
    return { calls: [{ tool: 'metric_current', args: { measure: m.id } }] };
  }
  if (!m.supportsPeriods) return { calls: [{ tool: 'metric_current', args: { measure: m.id } }], note: `${m.title} can only be reported as a current value, not for a period.` };
  if (compare) { const a = priorWindow(period); return { calls: [{ tool: 'compare_periods', args: { measure: m.id, a_from: a.from, a_to: a.to, b_from: period.from, b_to: period.to } }] }; }
  return { calls: [{ tool: 'measure_by_period', args: { measure: m.id, from: period.from, to: period.to, grain, ...(dimension ? { dimension } : {}) } }] };
}
