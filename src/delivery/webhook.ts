// Outbound webhook delivery. The request goes to the address resolveTarget() checked (DNS is
// not consulted again), redirects are not followed, the response body is read only up to 4 KiB
// and never stored, and every request is signed:
//   Clearline-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
//   Clearline-Delivery:  <delivery id>   (stable across retries: receivers deduplicate on it)
// The secret is read from the environment variable named by the destination's secret_ref
// (WEBHOOK_SECRET_<REF>); it is never stored in the database, logged or returned by the API.

import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { resolveTarget, DestinationError, type Resolver } from './ssrf.js';

export interface WebhookResult { ok: boolean; transient: boolean; status: number | null; code: string | null; message: string | null; duration_ms: number }

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function secretFor(ref: string | null | undefined, kind: 'SECRET' | 'AUTH'): string | null {
  if (!ref || !/^[A-Z0-9_]{1,64}$/.test(ref)) return null;
  const v = process.env[`WEBHOOK_${kind}_${ref}`];
  return v && v.length ? v : null;
}

export async function postWebhook(opts: {
  url: string; body: string; deliveryId: string; event: string; secret: string; authHeader?: string | null;
  timeoutMs: number; allowPrivate: boolean; resolver?: Resolver;
}): Promise<WebhookResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let target;
  try { target = await resolveTarget(opts.url, { allowPrivate: opts.allowPrivate, resolver: opts.resolver }); }
  catch (err) {
    const e = err as DestinationError;
    // DNS failures may be temporary; a private target or bad URL never becomes valid by retrying.
    return { ok: false, transient: e.code === 'dns_failure', status: null, code: e.code ?? 'invalid_destination', message: e.message, duration_ms: ms() };
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'user-agent': 'Clearline-Webhook/1', 'clearline-delivery': opts.deliveryId, 'clearline-event': opts.event,
    'clearline-signature': sign(opts.secret, opts.body), 'content-length': String(Buffer.byteLength(opts.body)),
  };
  if (opts.authHeader) headers.authorization = opts.authHeader;
  const lib = target.url.protocol === 'https:' ? https : http;
  return new Promise<WebhookResult>((resolve) => {
    let settled = false;
    const done = (r: Omit<WebhookResult, 'duration_ms'>) => { if (!settled) { settled = true; resolve({ ...r, duration_ms: ms() }); } };
    const req = lib.request(target.url, {
      method: 'POST', headers, timeout: opts.timeoutMs,
      // Pin the connection to the checked address; TLS still verifies the certificate for the host name.
      lookup: ((_h: string, o: { all?: boolean }, cb: (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void) =>
        (o?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family))) as never,
    }, (res) => {
      let read = 0;
      res.on('data', (c: Buffer) => { read += c.length; if (read > 4096) res.destroy(); });
      res.on('end', () => finish());
      res.on('close', () => finish());
      const finish = () => {
        const s = res.statusCode ?? 0;
        if (s >= 200 && s < 300) return done({ ok: true, transient: false, status: s, code: null, message: null });
        if (s >= 300 && s < 400) return done({ ok: false, transient: false, status: s, code: 'redirect_not_followed', message: `The endpoint answered ${s}; redirects are not followed.` });
        const transient = s >= 500 || s === 408 || s === 429;
        return done({ ok: false, transient, status: s, code: transient ? 'endpoint_unavailable' : 'endpoint_rejected', message: `The endpoint answered HTTP ${s}.` });
      };
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, transient: true, status: null, code: 'timeout', message: `No response within ${opts.timeoutMs} ms.` }); });
    req.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, transient: true, status: null, code: 'connection_failed', message: `Connection failed (${e.code ?? 'error'}).` }));
    req.end(opts.body);
  });
}
