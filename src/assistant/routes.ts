// Public endpoints: the content model, assistant status, approved sources and the assistant itself.
// They need no account. An Authorization header, when present, must be valid; it widens retrieval to the
// documents classified for signed-in users and does nothing else (the assistant has no data tools yet).

import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../control/auth.js';
import { badRequest, AppError, notFound } from '../platform/errors.js';
import { metrics } from '../platform/metrics.js';
import { ask, DEMO_VIEWS, generatorInfo, limits, type AskInput } from './answer.js';
import { loadContent, validateContent } from './content.js';
import { isApprovedSource, readApprovedSource } from './corpus.js';
import { getEmbedder } from './embed.js';
import { RateLimiter } from './limiter.js';
import { indexMeta } from './store.js';
import { getPool } from '../platform/db.js';

const rate = () => ({ client: Number(process.env.ASSISTANT_RATE_PER_MIN ?? 12), authed: Number(process.env.ASSISTANT_RATE_PER_MIN_AUTH ?? 40), global: Number(process.env.ASSISTANT_RATE_GLOBAL_PER_MIN ?? 300) });
let publicLimiter: RateLimiter | undefined;
let authedLimiter: RateLimiter | undefined;
export const resetLimiters = () => { publicLimiter = undefined; authedLimiter = undefined; };

let validated = false;
export function publicContent() {
  const c = loadContent();
  if (!validated) { const p = validateContent(c, undefined, { checkFiles: false }); if (p.length) throw new AppError(500, 'content_invalid', 'The content model is inconsistent'); validated = true; }
  return c;
}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string') throw badRequest('invalid_parameter', `${what} must be a string`);
  if (v.length > max) throw badRequest('invalid_parameter', `${what} is longer than ${max} characters`);
  return v;
};

export function parseAsk(body: unknown): Omit<AskInput, 'audience'> {
  const b = (body ?? {}) as Record<string, unknown>;
  const message = str(b.message, limits().maxMessage, 'message').trim();
  if (!message) throw badRequest('invalid_parameter', 'message is required');
  const hist = b.history === undefined ? [] : b.history;
  if (!Array.isArray(hist) || hist.length > 12) throw badRequest('invalid_parameter', 'history must be an array of at most 12 turns');
  const history = hist.map((h) => {
    const t = (h ?? {}) as Record<string, unknown>;
    if (t.role !== 'user' && t.role !== 'assistant') throw badRequest('invalid_parameter', 'history roles must be user or assistant');
    return { role: t.role as 'user' | 'assistant', text: str(t.text, 2000, 'history text') };
  });
  const c = loadContent();
  const x = (b.context ?? {}) as Record<string, unknown>;
  const pick = (k: string, ok: (v: string) => boolean) => (x[k] === undefined || x[k] === null || x[k] === '' ? undefined : ok(str(x[k], 80, `context.${k}`)) ? (x[k] as string) : undefined);   // unknown ids are ignored, never echoed
  return {
    message, history,
    context: {
      page: pick('page', (v) => /^[a-z-]{1,40}$/.test(v)),
      component: pick('component', (v) => c.components.some((k) => k.id === v)),
      capability: pick('capability', (v) => c.capabilities.some((k) => k.id === v)),
      decision: pick('decision', (v) => c.decisions.some((k) => k.id === v)),
      view: pick('view', (v) => (DEMO_VIEWS as readonly string[]).includes(v)),
    },
  };
}

async function audience(req: FastifyRequest): Promise<'public' | 'authenticated'> {
  const h = req.headers.authorization;
  if (!h) return 'public';
  await authenticate(h, req.correlationId);       // an invalid or revoked token is a 401, not a silent downgrade
  return 'authenticated';
}

export const assistantHandlers = {
  content: async () => publicContent(),
  status: async () => {
    let retrieval: Record<string, unknown>;
    try {
      const m = await indexMeta(getPool());
      retrieval = m ? { available: true, embedder: m.embedder, model: m.model, chunk_count: m.chunk_count, corpus_version: m.corpus_version, indexed_at: m.indexed_at } : { available: false, reason: 'not_built' };
    } catch { retrieval = { available: false, reason: 'database' }; }
    const g = generatorInfo();
    const l = limits();
    return { retrieval, embedder: { configured: getEmbedder().id, model: getEmbedder().model }, generator: g, limits: { max_message_chars: l.maxMessage, retrieval_k: l.k, context_chars: l.contextChars, rate_per_minute: rate().client } };
  },
  source: async (req: FastifyRequest) => {
    const path = str((req.query as Record<string, string>).path, 200, 'path');
    const hit = isApprovedSource(path);
    if (!hit) throw notFound('source');
    if (hit.access === 'authenticated' && (await audience(req)) !== 'authenticated') throw new AppError(401, 'sign_in_required', 'This document is available to signed-in users.');
    return { path, access: hit.access, text: readApprovedSource(path) };
  },
  ask: async (req: FastifyRequest, rep: FastifyReply) => {
    const aud = await audience(req);
    const r = rate();
    publicLimiter ??= new RateLimiter(r.client, r.global);
    authedLimiter ??= new RateLimiter(r.authed, r.global);
    const key = aud === 'authenticated' ? `t:${(req.headers.authorization ?? '').slice(-12)}` : `ip:${req.ip}`;
    const ok = (aud === 'authenticated' ? authedLimiter : publicLimiter).check(key);
    if (!ok.ok) {
      metrics.assistantRateLimited.inc({ scope: ok.scope });
      rep.header('retry-after', String(ok.retryAfterS));
      throw new AppError(429, 'rate_limited', `Too many assistant requests. Try again in ${ok.retryAfterS} seconds.`);
    }
    return ask({ ...parseAsk(req.body), audience: aud });
  },
};
