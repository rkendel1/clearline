// Minimal SMTP submission client (RFC 5321 / 3207 / 4954) for email delivery, written here
// rather than depending on a mail library: it only needs to submit one message to one
// configured relay. SMTP_URL selects the relay:
//   smtps://user:pass@host:465        implicit TLS
//   smtp://user:pass@host:587         STARTTLS required (refused if the server does not offer it)
//   smtp://host:2525?tls=none         plain text: development and tests only (refused in production)
// Header values are single-line (CR/LF rejected), addresses are validated, the body is
// dot-stuffed, and replies are classified: 4xx transient, 5xx permanent.

import net from 'node:net';
import tls from 'node:tls';

export interface Mail {
  from: string; to: string[]; subject: string; text: string; messageId: string; headers?: Record<string, string>;
  attachment?: { filename: string; contentType: string; content: string };
}

export interface SmtpResult { ok: boolean; transient: boolean; code: string | null; message: string | null; reply: number | null }

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const validAddress = (a: string) => a.length <= 254 && ADDRESS.test(a);
const header = (v: string) => { if (/[\r\n]/.test(v)) throw new Error('header values must be a single line'); return v; };

/** RFC 2047 encoded-word for non-ASCII subjects. */
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(header(v)) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);

export function buildMessage(m: Mail, date = new Date()): string {
  const lines = [
    `From: ${header(m.from)}`, `To: ${m.to.map(header).join(', ')}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${header(m.messageId)}>`, 'MIME-Version: 1.0', ...Object.entries(m.headers ?? {}).map(([k, v]) => `${header(k)}: ${header(v)}`),
  ];
  const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  if (!m.attachment) {
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(m.text));
  } else {
    const boundary = `clearline-${m.messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(m.text),
      `--${boundary}`, `Content-Type: ${header(m.attachment.contentType)}; name="${header(m.attachment.filename)}"`, `Content-Disposition: attachment; filename="${header(m.attachment.filename)}"`,
      'Content-Transfer-Encoding: base64', '', b64(m.attachment.content), `--${boundary}--`);
  }
  return lines.join('\r\n');
}

/** Dot-stuffing and line normalisation for the DATA phase. */
export const dataPayload = (msg: string) => msg.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n') + '\r\n.\r\n';

class Conn {
  private buf = '';
  private waiters: ((line: { code: number; text: string }) => void)[] = [];
  private lines: { code: number; text: string }[] = [];
  constructor(public sock: net.Socket | tls.TLSSocket) { this.attach(); }
  attach() {
    // A closed or timed-out connection answers every pending read with code 0 (a transient failure).
    this.sock.on('close', () => { for (const w of this.waiters.splice(0)) w({ code: 0, text: 'connection closed' }); this.closed = true; });
    this.sock.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
        // Multi-line replies: "250-..." continues, "250 ..." ends.
        this.pending.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: this.pending.map((l) => l.slice(4)).join('\n') };
          this.pending = [];
          const w = this.waiters.shift();
          if (w) w(reply); else this.lines.push(reply);
        }
      }
    });
  }
  private pending: string[] = [];
  private closed = false;
  read(): Promise<{ code: number; text: string }> {
    const l = this.lines.shift();
    if (l) return Promise.resolve(l);
    if (this.closed) return Promise.resolve({ code: 0, text: 'connection closed' });
    return new Promise((r) => this.waiters.push(r));
  }
  async cmd(c: string) { this.sock.write(c + '\r\n'); return this.read(); }
}

export async function sendSmtp(smtpUrl: string, mail: Mail, opts: { timeoutMs: number; production: boolean; helo?: string }): Promise<SmtpResult> {
  const url = new URL(smtpUrl);
  const implicit = url.protocol === 'smtps:';
  const tlsMode = implicit ? 'implicit' : url.searchParams.get('tls') === 'none' ? 'none' : 'starttls';
  if (tlsMode === 'none' && opts.production) return { ok: false, transient: false, code: 'insecure_smtp', message: 'Plain-text SMTP is not allowed in production.', reply: null };
  for (const a of [mail.from, ...mail.to]) if (!validAddress(a)) return { ok: false, transient: false, code: 'invalid_address', message: `Invalid email address ${JSON.stringify(a)}.`, reply: null };
  const host = url.hostname;
  const port = Number(url.port || (implicit ? 465 : 587));
  const fail = (transient: boolean, code: string, message: string, reply: number | null = null): SmtpResult => ({ ok: false, transient, code, message, reply });
  let sock: net.Socket | tls.TLSSocket;
  try {
    sock = await new Promise((resolve, reject) => {
      const s = implicit ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      s.once(implicit ? 'secureConnect' : 'connect', () => resolve(s));
      s.once('error', reject);
      s.setTimeout(opts.timeoutMs, () => { s.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    });
  } catch (err) {
    return fail(true, 'connection_failed', `Could not connect to the mail relay (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  sock.setTimeout(0);
  // One deadline for the whole conversation.
  const deadline = setTimeout(() => sock.destroy(), opts.timeoutMs);
  const conn = new Conn(sock);
  const expect = async (p: Promise<{ code: number; text: string }>, ok: number[], step: string) => {
    const r = await p;
    if (!ok.includes(r.code)) throw Object.assign(new Error(`${step}: ${r.code}`), { reply: r.code || null, transient: r.code === 0 || (r.code >= 400 && r.code < 500) });
    return r;
  };
  const helo = opts.helo ?? 'clearline.local';
  try {
    await expect(conn.read(), [220], 'greeting');
    let ehlo = await expect(conn.cmd(`EHLO ${helo}`), [250], 'EHLO');
    if (tlsMode === 'starttls') {
      if (!/^STARTTLS$/im.test(ehlo.text)) throw Object.assign(new Error('the relay does not offer STARTTLS'), { reply: null, transient: false, code: 'starttls_unavailable' });
      await expect(conn.cmd('STARTTLS'), [220], 'STARTTLS');
      sock.removeAllListeners('data');
      sock = await new Promise<tls.TLSSocket>((resolve, reject) => { const t = tls.connect({ socket: sock, servername: host }, () => resolve(t)); t.once('error', reject); });
      conn.sock = sock; conn.attach();
      ehlo = await expect(conn.cmd(`EHLO ${helo}`), [250], 'EHLO');
    }
    if (url.username) {
      const auth = Buffer.from(`\u0000${decodeURIComponent(url.username)}\u0000${decodeURIComponent(url.password)}`).toString('base64');
      await expect(conn.cmd(`AUTH PLAIN ${auth}`), [235], 'AUTH');
    }
    await expect(conn.cmd(`MAIL FROM:<${mail.from}>`), [250], 'MAIL FROM');
    for (const to of mail.to) await expect(conn.cmd(`RCPT TO:<${to}>`), [250, 251], 'RCPT TO');
    await expect(conn.cmd('DATA'), [354], 'DATA');
    sock.write(dataPayload(buildMessage(mail)));
    await expect(conn.read(), [250], 'message');
    conn.cmd('QUIT').catch(() => {});
    sock.end();
    clearTimeout(deadline);
    return { ok: true, transient: false, code: null, message: null, reply: 250 };
  } catch (err) {
    clearTimeout(deadline);
    sock.destroy();
    const e = err as Error & { reply?: number | null; transient?: boolean; code?: string };
    return fail(e.transient ?? true, e.code && typeof e.code === 'string' && !e.code.startsWith('E') ? e.code : e.reply ? (e.transient ? 'relay_deferred' : 'relay_rejected') : 'relay_error',
      `The mail relay refused the message at ${e.message.split(':')[0]}${e.reply ? ` (${e.reply})` : ''}.`, e.reply ?? null);
  }
}
