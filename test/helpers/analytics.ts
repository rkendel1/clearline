// Helpers for the saved-analytics scenarios (P-T): API wrappers, a local webhook receiver
// that verifies signatures and can be told to fail, and a minimal SMTP receiver.

import http from 'node:http';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import type { Res } from './harness.js';

type Client = { get: (u: string) => Promise<Res>; post: (u: string, b?: unknown) => Promise<Res> };

export const DAILY_SQL = `SELECT service_date AS day, sum(paid_amount) AS paid, count(*) AS claims
FROM claim
WHERE service_date >= :start AND service_date <= :end AND _trust_status = 'trusted'
GROUP BY service_date
ORDER BY service_date`;

export const DAILY_PARAMS = [
  { name: 'start', type: 'date', label: 'From', default: '2026-04-04' },
  { name: 'end', type: 'date', label: 'To', default: '2026-09-30' },
];

export const DAILY_ANOMALY = { type: 'anomaly', key: 'daily-paid', label: 'Daily paid anomalies', algorithm: 'anomaly.rolling_mad', time_column: 'day', metrics: ['paid', 'claims'], grain: 'day', period: 7 };

export function analytics(c: Client, tenant: string) {
  const SQ = `/api/v1/tenants/${tenant}/saved-queries`;
  const AN = `/api/v1/tenants/${tenant}/analytics`;
  return {
    list: (qs = '') => c.get(`${SQ}${qs}`),
    create: (b: unknown) => c.post(SQ, b),
    get: (id: string) => c.get(`${SQ}/${id}`),
    meta: (id: string, b: unknown) => c.post(`${SQ}/${id}`, b),
    version: (id: string, b: unknown) => c.post(`${SQ}/${id}/versions`, b),
    getVersion: (id: string, v: number) => c.get(`${SQ}/${id}/versions/${v}`),
    duplicate: (id: string, b: unknown = {}) => c.post(`${SQ}/${id}/duplicate`, b),
    status: (id: string, status: string) => c.post(`${SQ}/${id}/status`, { status }),
    favorite: (id: string, favorite: boolean) => c.post(`${SQ}/${id}/favorite`, { favorite }),
    execute: (id: string, b: unknown) => c.post(`${SQ}/${id}/execute`, b),
    runNow: (id: string, b: unknown = {}) => c.post(`${SQ}/${id}/runs`, b),
    validateAnalysis: (id: string, config: unknown) => c.post(`${SQ}/${id}/analyses/validate`, { config }),
    schedule: (b: unknown) => c.post(`${AN}/schedules`, b),
    getSchedule: (id: string) => c.get(`${AN}/schedules/${id}`),
    updateSchedule: (id: string, b: unknown) => c.post(`${AN}/schedules/${id}`, b),
    scheduleAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'run') => c.post(`${AN}/schedules/${id}/${action}`, {}),
    preview: (b: unknown) => c.post(`${AN}/schedules/preview`, b),
    runs: (qs = '') => c.get(`${AN}/runs${qs}`),
    run: (id: string) => c.get(`${AN}/runs/${id}`),
    result: (id: string, qs = '') => c.get(`${AN}/runs/${id}/result${qs}`),
    retry: (id: string, ids?: string[]) => c.post(`${AN}/runs/${id}/retry-deliveries`, ids ? { delivery_ids: ids } : {}),
    rerun: (id: string) => c.post(`${AN}/runs/${id}/rerun`, {}),
    review: (id: string, names: Record<string, string>) => c.post(`${AN}/analyses/${id}/review`, { cluster_names: names }),
    destination: (b: unknown) => c.post(`${AN}/destinations`, b),
    destinations: () => c.get(`${AN}/destinations`),
    updateDestination: (id: string, b: unknown) => c.post(`${AN}/destinations/${id}`, b),
    testDestination: (id: string) => c.post(`${AN}/destinations/${id}/test`, {}),
    download: (id: string) => c.get(`${AN}/exports/${id}/download`),
    notifications: (qs = '') => c.get(`/api/v1/tenants/${tenant}/notifications${qs}`),
    read: (id: string) => c.post(`/api/v1/tenants/${tenant}/notifications/${id}/read`, {}),
  };
}

export const expectStatus = (r: Res, code: number) => { if (r.status !== code) throw new Error(`expected HTTP ${code}, got ${r.status}: ${r.text.slice(0, 600)}`); return r.body; };

export interface Received { headers: http.IncomingHttpHeaders; body: string; json: any; signatureValid: boolean }

/** Local webhook receiver. `plan` decides each response: a status code, or 'hang' (never answer). */
export async function webhookReceiver(secret: string) {
  const received: Received[] = [];
  const plan: (number | 'hang')[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const sig = String(req.headers['clearline-signature'] ?? '');
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
      const valid = !!m && createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex') === m[2];
      received.push({ headers: req.headers, body, json: JSON.parse(body), signatureValid: valid });
      const next = plan.length ? plan.shift()! : 200;
      if (next === 'hang') return;
      res.writeHead(next, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/hooks/clearline`, received, plan, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Minimal SMTP receiver (plain text) capturing messages, optionally answering 451 for the first N. */
export async function smtpReceiver(opts: { deferFirst?: number } = {}) {
  const messages: { from: string; to: string[]; data: string }[] = [];
  let defer = opts.deferFirst ?? 0;
  const server = net.createServer((sock) => {
    let buf = ''; let mode: 'cmd' | 'data' = 'cmd'; let from = ''; let to: string[] = []; let data = '';
    sock.write('220 test-smtp ready\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data = buf.slice(0, end); buf = buf.slice(end + 5); mode = 'cmd';
          if (defer > 0) { defer--; sock.write('451 4.3.0 try again later\r\n'); continue; }
          messages.push({ from, to, data: data.replace(/\r\n\.\./g, '\r\n.') });
          sock.write('250 2.0.0 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-test-smtp\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { from = /<([^>]*)>/.exec(line)?.[1] ?? ''; to = []; sock.write('250 ok\r\n'); }
        else if (cmd === 'RCPT') { to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { mode = 'data'; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
        else sock.write('502 not implemented\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `smtp://127.0.0.1:${port}?tls=none`, messages, deferNext: (n: number) => { defer = n; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Decode the base64 text part of a captured message. */
export function mailText(raw: string): string {
  const parts = raw.split(/\r\n\r\n/);
  for (let i = 1; i < parts.length; i++) {
    const header = parts[i - 1];
    if (/Content-Type: text\/plain/i.test(header)) return Buffer.from(parts[i].split(/\r\n--/)[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
  }
  return '';
}
