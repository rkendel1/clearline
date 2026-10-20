// The data path of the assistant: plan a tool call, execute it through the validated tools, and render the result.
// Every number in the answer text comes from a persisted tool result, rendered by a template. A language model is
// used at most to choose among the same tools when the rules cannot map the question; it never writes SQL and it
// never writes the figures. When a tool fails the answer says so and contains no figure.

import Anthropic from '@anthropic-ai/sdk';
import type { Principal } from '../control/auth.js';
import { log } from '../platform/logger.js';
import { planQuestion, type MeasureInfo } from './planner.js';
import { contractMeasures, dataToolConfig, executeTool, publicPrincipal, ToolError, toolSchemas, type Evidence, type ToolCall, type ToolContext } from './tools.js';

export interface ToolSummary { id: string; tool: string; title: string; computed_at: string; execution_id?: string; row_count: number; measure?: string; window?: { from: string; to: string }; qualifications: string[]; source: string }
export interface DataAnswer { answer: string; mode: 'computed' | 'declined' | 'unavailable'; tools: ToolSummary[]; evidence: Evidence[]; notice?: string; suggestions?: string[] }

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ rendering

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Format an exact decimal string for display without changing its digits. */
export function fmt(v: unknown, unit?: string): string {
  if (v === null || v === undefined) return 'no value';
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const [i, f] = s.split('.');
  const neg = i.startsWith('-');
  const body = group(neg ? i.slice(1) : i) + (f ? `.${f}` : '');
  const sign = neg ? '-' : '';
  return unit === 'usd' ? `${sign}$${body}` : unit === 'percent' ? `${sign}${body}%` : `${sign}${body}`;
}
const win = (w?: { from: string; to: string }) => (w ? (w.from === w.to ? w.from : `${w.from} to ${w.to}`) : '');
const col = (ev: Evidence, name: string, row: unknown[]) => row[ev.columns.findIndex((c) => c.name === name)];

export function render(ev: Evidence): string {
  const unit = ev.measure?.unit;
  const m = ev.measure;
  const lines: string[] = [];
  switch (ev.tool) {
    case 'list_metrics':
      lines.push(`These business metrics are declared for this tenant (contract ${ev.contract_version}):`, ...ev.rows.map((r) => `- **${r[1]}** (\`${r[0]}\`)${r[3] ? '' : ', current value only'}: ${r[2]}`));
      break;
    case 'metric_current': {
      const [value, incl, excl] = ev.rows[0];
      lines.push(`**${m!.title}** is **${fmt(value, unit)}** over trusted data (all time).`);
      if (String(incl) !== String(value)) lines.push(`Including records from untrusted batches it would be ${fmt(incl, unit)} (${fmt(excl)} current records excluded).`);
      lines.push(`Definition: ${m!.definition}`);
      break;
    }
    case 'measure_by_period': {
      const g = ev.grouping ?? [];
      if (!g.length) {
        const r = ev.rows[0];
        lines.push(`**${m!.title}** for ${win(ev.window)} was **${fmt(col(ev, 'value', r), unit)}**, from ${fmt(col(ev, 'records', r))} records (trusted data only).`);
      } else {
        lines.push(`**${m!.title}** for ${win(ev.window)}, by ${g.join(' and ')} (trusted data only):`);
        for (const r of ev.rows) lines.push(`- ${ev.columns.filter((c) => c.name !== 'value' && c.name !== 'records').map((c) => String(col(ev, c.name, r)).slice(0, 10)).join(' / ')}: ${fmt(col(ev, 'value', r), unit)} (${fmt(col(ev, 'records', r))} records)`);
        if (!ev.rows.length) lines.push('- no records in this window');
      }
      lines.push(`Definition: ${m!.definition}`);
      break;
    }
    case 'compare_periods': {
      const r = ev.rows[0];
      const a = col(ev, 'a_value', r), b = col(ev, 'b_value', r), ch = col(ev, 'change', r), pct = col(ev, 'pct_change', r);
      lines.push(`**${m!.title}**: ${fmt(b, unit)} for ${win(ev.compare!.b)} compared with ${fmt(a, unit)} for ${win(ev.compare!.a)}.`);
      lines.push(ch === null || ch === undefined ? 'The change cannot be computed because one window has no value.' : `The difference is ${fmt(ch, unit)}${pct === null || pct === undefined ? '' : ` (${fmt(pct, 'percent')} relative to the earlier window)`}.`);
      lines.push(`Definition: ${m!.definition}`);
      break;
    }
    case 'quality_summary': {
      const r = ev.rows[0];
      lines.push(`Across ${fmt(col(ev, 'batches', r))} processed batches that arrived ${win(ev.window)}, **${fmt(col(ev, 'rows_quarantined', r))}** of ${fmt(col(ev, 'rows_received', r))} rows were quarantined: an exception rate of **${fmt(col(ev, 'exception_rate_pct', r), 'percent')}**.`);
      lines.push(`Definition: ${m!.definition}`);
      break;
    }
    case 'reconciliation_status': {
      const bad = ev.rows.filter((r) => r[1] !== 'passed');
      lines.push(ev.rows.length ? `The latest dataset reconciliation ran ${ev.rows.length} checks: ${ev.rows.length - bad.length} passed and ${bad.length} did not.` : 'No dataset-level reconciliation run is recorded yet.');
      for (const r of bad) lines.push(`- **${r[0]}** (${r[1]}): ${r[2]}`);
      break;
    }
    case 'recent_runs':
      lines.push(ev.rows.length ? 'Your most recent runs:' : 'You have no saved-query runs yet.', ...ev.rows.map((r) => `- ${String(r[0]).slice(0, 8)}: "${r[1]}", ${r[2]}${r[4] !== null ? `, ${fmt(r[4])} rows` : ''}`));
      break;
    case 'run_insights': {
      const an = ev.rows.filter((r) => r[1] !== null && r[3] === null), ins = ev.rows.filter((r) => r[3] !== null);
      lines.push(`**${ev.title}**`, 'Measured (recorded by the run):');
      lines.push(...an.map((r) => `- Analysis \`${r[0]}\` by ${r[1]}: ${r[2]}${r[4] ? `. ${r[4]}` : ''}`));
      lines.push(...ins.map((r) => `- [${r[3]}] ${r[4]}`));
      if (!an.length && !ins.length) lines.push('- no analyses or insights were recorded for this run');
      break;
    }
  }
  return lines.join('\n');
}

const HYPOTHESES = [
  'a change in the source data or a late or duplicated delivery (check the batches and exceptions around that time)',
  'a contract or transformation change that altered how records are counted',
  'a real change in the underlying activity, such as seasonality, a holiday or a business event',
  'a one-off data-entry or system error in a small number of records',
];

function foot(evs: Evidence[]): string[] {
  const out: string[] = [];
  for (const e of evs) {
    for (const q of e.qualifications) out.push(q);
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ model planner (fallback only)

async function modelPlan(question: string, ctx: ToolContext, measures: MeasureInfo[]): Promise<ToolCall[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || process.env.ASSISTANT_PROVIDER === 'none') return [];
  const client = new Anthropic({ apiKey: key, timeout: Number(process.env.ASSISTANT_TIMEOUT_MS ?? 45_000), maxRetries: 1, defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : undefined });
  const res = await client.messages.create({
    model: process.env.ASSISTANT_MODEL ?? 'claude-sonnet-5-5', max_tokens: 600,
    system: `You choose which data tool answers the user's question about Clearline demo data. Today is ${today()}. Call at most ${dataToolConfig().limits.max_calls_per_question} tools. Use absolute dates (YYYY-MM-DD) computed from today. Available metric ids: ${measures.map((m) => `${m.id} (${m.title})`).join('; ')}. If no tool fits, call none. You never write SQL and you never state figures.`,
    messages: [{ role: 'user', content: question }], tools: toolSchemas(ctx.audience) as Anthropic.Tool[],
  });
  return res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use').slice(0, dataToolConfig().limits.max_calls_per_question).map((b) => ({ tool: b.name as ToolCall['tool'], args: (b.input ?? {}) as Record<string, unknown> }));
}

// ------------------------------------------------------------------ entry

const summary = (e: Evidence): ToolSummary => ({ id: e.id, tool: e.tool, title: e.title, computed_at: e.computed_at, execution_id: e.execution_id, row_count: e.row_count, measure: e.measure?.title, window: e.window ?? e.compare?.b, qualifications: e.qualifications, source: e.source });

function failure(e: unknown): DataAnswer {
  if (e instanceof ToolError) {
    const mode = e.code === 'failed' || e.code === 'timeout' || e.code === 'rejected' ? 'unavailable' : 'declined';
    return { answer: `I could not complete that calculation: ${e.message} I will not estimate or guess a figure.`, mode, tools: [], evidence: [] };
  }
  log.warn('assistant data path failed', { error: (e as Error).message.slice(0, 200) });
  return { answer: 'I could not complete that calculation, and I will not estimate or guess a figure.', mode: 'unavailable', tools: [], evidence: [] };
}

export async function answerData(args: { question: string; category: 'data' | 'interpretation'; audience: 'public' | 'authenticated'; principal?: Principal; correlationId: string; runId?: string }): Promise<DataAnswer> {
  const principal = args.audience === 'authenticated' ? args.principal : publicPrincipal(args.correlationId);
  if (args.audience === 'public' && !principal) return { answer: 'Questions about the demo data are not enabled for anonymous visitors on this server. Sign in to the demo and ask again, or use the query workspace.', mode: 'declined', tools: [], evidence: [] };
  if (!principal?.tenantId) return { answer: 'This identity is not bound to a tenant, so there is no data to ask about.', mode: 'declined', tools: [], evidence: [] };
  const ctx: ToolContext = { principal, audience: args.audience };

  if (args.category === 'interpretation') {
    if (args.audience !== 'authenticated') return { answer: 'Interpreting a specific result needs that result\'s run and its evidence, which are available after you sign in. I can explain how the analyses work and what they cannot show.', mode: 'declined', tools: [], evidence: [] };
    try {
      let runId = args.runId;
      const evs: Evidence[] = [];
      if (!runId) {
        const recent = await executeTool(ctx, { tool: 'recent_runs', args: {} }); evs.push(recent);
        runId = (recent.rows.find((r) => r[2] === 'succeeded') ?? recent.rows[0])?.[0] as string | undefined;
        if (!runId) return { answer: 'There are no runs to interpret yet. Run a saved query with analyses first.', mode: 'declined', tools: evs.map(summary), evidence: evs };
      }
      const ev = await executeTool(ctx, { tool: 'run_insights', args: { run_id: runId } }); evs.push(ev);
      const text = [render(ev), '', '**What this does not establish:** these are statistical deviations or projections from the listed methods. They are not causes.', '', '**Hypotheses to investigate (not evidence):**', ...HYPOTHESES.map((h) => `- ${h}`)];
      const f = foot([ev]); if (f.length) text.push('', ...f);
      if (ev.limitations.length) text.push('', ...ev.limitations.slice(0, 3).map((l) => `Limitation: ${l}`));
      return { answer: text.join('\n'), mode: 'computed', tools: evs.map(summary), evidence: evs };
    } catch (e) { return failure(e); }
  }

  let measures: MeasureInfo[];
  try { const c = await contractMeasures(principal); measures = c.measures.map((m) => ({ id: m.def.id, title: m.def.title, description: m.def.description, supportsPeriods: m.dateField !== null, dimensions: m.dimensions, aggregation: m.def.aggregation })); }
  catch (e) { return failure(e); }

  let plan = planQuestion(args.question, today(), measures);
  let notice: string | undefined;
  if ('clarify' in plan && /could not tell/.test(plan.clarify)) {
    try { const calls = await modelPlan(args.question, ctx, measures); if (calls.length) { plan = { calls }; notice = 'The tool for this question was chosen by the language model; the figures come only from the tool result.'; } }
    catch (e) { log.warn('assistant model planner failed', { error: (e as Error).message.slice(0, 200) }); }
  }
  if ('clarify' in plan) {
    return { answer: `${plan.clarify} Metrics I can compute: ${measures.map((m) => m.title).slice(0, 8).join('; ')}. Ask, for example, "What was the total paid amount last month?" or "Compare claims last month with the month before".`, mode: 'declined', tools: [], evidence: [], suggestions: measures.slice(0, 3).map((m) => `What was ${m.title.toLowerCase()} last month?`) };
  }
  try {
    const evs: Evidence[] = [];
    for (const c of plan.calls.slice(0, dataToolConfig().limits.max_calls_per_question)) evs.push(await executeTool(ctx, c));
    const text = evs.map(render);
    const f = foot(evs);
    if (plan.note) text.push(plan.note);
    text.push(...f);
    text.push(`Computed ${evs[0].computed_at.slice(0, 19).replace('T', ' ')} UTC. ${evs[0].trust_scope}`);
    return { answer: text.join('\n\n'), mode: 'computed', tools: evs.map(summary), evidence: evs, notice };
  } catch (e) { return failure(e); }
}
