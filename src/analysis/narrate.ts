// Optional model-assisted interpretation of a computed insight. Off by default
// (ANALYSIS_NARRATOR=none). When enabled, the provider receives ONLY the insight's computed
// evidence (numbers, window, method), never result rows. Its text is accepted only if it is
// grounded: every number it states must appear in the evidence, and it may not assert causes,
// fraud or certainty. Rejected text is recorded with the reason; the template body is always
// the authoritative statement and is never replaced.

import Anthropic from '@anthropic-ai/sdk';
import type { InsightDraft } from './insights.js';

export interface Narrator { id: string; model: string | null; narrate(insight: InsightDraft): Promise<string> }

export interface Narrative { provider: string; model: string | null; text: string | null; accepted: boolean; reason: string | null }

const FORBIDDEN = /\b(fraud\w*|misconduct|abuse|caus(e|es|ed|ing)|because|due to|led to|result(s|ed)? of|proves?|definitely|certain(ly)?|guarantee\w*)\b/i;

function evidenceNumbers(x: unknown, out: number[] = []): number[] {
  if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
  else if (typeof x === 'string') for (const m of x.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  else if (Array.isArray(x)) x.forEach((v) => evidenceNumbers(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => evidenceNumbers(v, out));
  return out;
}

/** Every number in `text` must match an evidence number to the precision it is written with. */
export function groundingCheck(text: string, evidence: Record<string, unknown>): { ok: boolean; reason: string | null } {
  if (FORBIDDEN.test(text)) return { ok: false, reason: `asserts a cause, misconduct or certainty ("${FORBIDDEN.exec(text)![0]}")` };
  const known = evidenceNumbers(evidence);
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, '');
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    const tol = 0.5 * 10 ** -decimals + 1e-9;
    // Years, dates and small counts written in the evidence as strings are matched the same way.
    if (!known.some((k) => Math.abs(k - v) <= tol || Math.abs(Math.abs(k) - Math.abs(v)) <= tol)) return { ok: false, reason: `states ${m[0]}, which is not in the computed evidence` };
  }
  return { ok: true, reason: null };
}

export async function narrateInsight(n: Narrator | null, insight: InsightDraft): Promise<Narrative | null> {
  if (!n) return null;
  try {
    const text = (await n.narrate(insight)).trim().slice(0, 1200);
    const g = groundingCheck(text, insight.evidence);
    return { provider: n.id, model: n.model, text: g.ok ? text : null, accepted: g.ok, reason: g.reason };
  } catch (err) {
    return { provider: n.id, model: n.model, text: null, accepted: false, reason: `provider unavailable: ${(err as Error).message.slice(0, 200)}` };
  }
}

class AnthropicNarrator implements Narrator {
  readonly id = 'anthropic';
  private client: Anthropic;
  constructor(readonly model: string, apiKey: string, timeoutMs: number, workspaceId?: string) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1, defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined });
  }
  async narrate(insight: InsightDraft): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model, max_tokens: 400,
      system: 'You restate computed analytics findings for business readers in two sentences. Use only numbers present in the JSON, copied exactly. '
        + 'Do not speculate about causes, do not mention fraud or misconduct, and do not express certainty beyond the stated method.',
      messages: [{ role: 'user', content: JSON.stringify({ title: insight.title, kind: insight.kind, evidence: insight.evidence }) }],
    });
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

let override: Narrator | null | undefined;
export function setNarratorForTests(n: Narrator | null | undefined) { override = n; }

export function getNarrator(): Narrator | null {
  if (override !== undefined) return override;
  if ((process.env.ANALYSIS_NARRATOR ?? 'none') !== 'anthropic') return null;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new AnthropicNarrator(process.env.ANALYSIS_NARRATOR_MODEL ?? process.env.NL_SQL_MODEL ?? 'claude-opus-5-5', key, Number(process.env.NL_SQL_TIMEOUT_MS ?? 60_000), process.env.ANTHROPIC_WORKSPACE_ID || undefined);
}
