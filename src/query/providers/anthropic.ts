// Claude provider (opt-in: NL_SQL_PROVIDER=anthropic). The API key stays in the
// server environment (ANTHROPIC_API_KEY); the request carries the question,
// with obvious identifiers scrubbed, and the role's permitted catalog. No row
// values are ever sent. The answer is constrained to a JSON schema and is
// still only an untrusted proposal.

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../../platform/logger.js';
import { ProviderUnavailable, type ProviderRequest, type ProviderResult, type SqlProvider } from './types.js';

const SYSTEM = `You translate analytical questions into a single read-only PostgreSQL SELECT statement for the Clearline data platform.
Rules:
- Use ONLY the tables and columns in the catalog you are given, by their exact names, without schema prefixes. Anything else does not exist.
- Columns with access "full" may be used anywhere. Columns with access "masked" may be returned only as the bare column (they come back redacted), joined to their related key, or tested with IS NULL. Columns with access "filter" may only be joined to their related key or tested with IS NULL and must never be returned. Columns with access "discover" must not be used at all.
- Supported: one SELECT, JOIN ... ON, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, non-recursive WITH, subqueries, CASE, COALESCE, casts to plain types, count/sum/avg/min/max, round, abs, lower, upper, length, date_trunc, extract, to_char, now(), current_date. Not supported: UNION, window functions, LATERAL, NATURAL JOIN, USING, regular expressions, any data modification.
- Every query is automatically scoped to the user's own tenant; never try to filter by or reach another tenant.
- Reported business metrics count only records from trusted batches: add _trust_status = 'trusted' when the user asks for reported totals.
- If the question cannot be answered with the catalog, set answerable to false and explain what is missing without guessing names.
Return the JSON object only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    sql: { type: 'string', description: 'the SELECT statement, or empty when not answerable' },
    explanation: { type: 'string', description: 'plain-language description of what the query returns' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['answerable', 'sql', 'explanation', 'assumptions'],
  additionalProperties: false,
} as const;

export class AnthropicProvider implements SqlProvider {
  readonly id = 'anthropic';
  private client: Anthropic;

  constructor(readonly model: string, opts: { apiKey: string; timeoutMs: number; workspaceId?: string }) {
    // Keys not scoped to a workspace must name one (ANTHROPIC_WORKSPACE_ID).
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 1,
      defaultHeaders: opts.workspaceId ? { 'anthropic-workspace-id': opts.workspaceId } : undefined });
  }

  async generate(req: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Today is ${req.today}. Dialect: ${req.dialect}.\n\nCatalog (JSON):\n${JSON.stringify(req.catalog)}\n\nQuestion: ${req.question}` }],
      }, { signal });
    } catch (err) {
      // The provider's own message helps operators (it never contains the key); users get a generic one.
      if (err instanceof Anthropic.APIError) log.warn('model provider error', { provider: this.id, status: err.status, message: String(err.message).slice(0, 300) });
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new ProviderUnavailable(this.id, 'The model provider rejected the configured credentials.', false);
      if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) throw new ProviderUnavailable(this.id, `The model provider rejected the request (${err.status}); check NL_SQL_MODEL, ANTHROPIC_WORKSPACE_ID and the server log.`, false);
      if (err instanceof Anthropic.RateLimitError) throw new ProviderUnavailable(this.id, 'The model provider is rate limiting requests; try again shortly.', true);
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderUnavailable(this.id, 'The model provider did not answer in time.', true);
      if (err instanceof Anthropic.APIConnectionError) throw new ProviderUnavailable(this.id, 'The model provider could not be reached.', true);
      if (err instanceof Anthropic.APIError) throw new ProviderUnavailable(this.id, `The model provider failed (${err.status ?? 'error'}).`, true);
      throw err;
    }
    if (res.stop_reason === 'refusal') return { kind: 'cannot_answer', explanation: 'The model declined to answer this request.' };
    if (res.stop_reason === 'max_tokens') throw new ProviderUnavailable(this.id, 'The model response was cut off.', true);
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    let out: { answerable: boolean; sql: string; explanation: string; assumptions: string[] };
    try { out = JSON.parse(text); } catch { throw new ProviderUnavailable(this.id, 'The model returned an unreadable answer.', true); }
    if (typeof out?.answerable !== 'boolean' || typeof out.sql !== 'string' || typeof out.explanation !== 'string') throw new ProviderUnavailable(this.id, 'The model returned an unreadable answer.', true);
    if (!out.answerable || !out.sql.trim()) return { kind: 'cannot_answer', explanation: out.explanation.slice(0, 2000) };
    return { kind: 'proposal', sql: out.sql.slice(0, 20_000), explanation: out.explanation.slice(0, 4000), assumptions: (out.assumptions ?? []).map(String).slice(0, 10) };
  }
}
