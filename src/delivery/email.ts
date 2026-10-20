// Email delivery providers, chosen by EMAIL_PROVIDER:
//   none  (default) email destinations fail permanently with email_not_configured
//   smtp  submit to the relay in SMTP_URL (src/delivery/smtp.ts)
//   file  write each message as an .eml file under EMAIL_OUTBOX_DIR (local demos, offline)
//   test  keep messages in memory (tests)
// EMAIL_ALLOWED_DOMAINS (comma-separated) restricts recipients; destinations naming other domains
// are refused when they are configured and again at send time.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../platform/config.js';
import { buildMessage, sendSmtp, validAddress, type Mail, type SmtpResult } from './smtp.js';

export const testOutbox: (Mail & { raw: string })[] = [];

type Sender = (m: Mail) => Promise<SmtpResult>;
let override: Sender | undefined;
/** Tests can simulate relay behaviour (e.g. transient refusals). */
export function setEmailSenderForTests(s: Sender | undefined) { override = s; }

export function recipientIssue(addr: string): string | null {
  if (!validAddress(addr)) return `${JSON.stringify(addr)} is not a valid email address.`;
  const allowed = loadConfig().emailAllowedDomains;
  const domain = addr.split('@')[1].toLowerCase();
  if (allowed.length && !allowed.some((d) => domain === d || domain.endsWith(`.${d}`))) return `${addr}: the domain ${domain} is not in EMAIL_ALLOWED_DOMAINS.`;
  return null;
}

export async function sendEmail(m: Mail): Promise<SmtpResult> {
  const cfg = loadConfig();
  for (const a of m.to) { const why = recipientIssue(a); if (why) return { ok: false, transient: false, code: 'recipient_not_allowed', message: why, reply: null }; }
  if (override) return override(m);
  switch (cfg.emailProvider) {
    case 'none': return { ok: false, transient: false, code: 'email_not_configured', message: 'Email delivery is not configured (EMAIL_PROVIDER=none).', reply: null };
    case 'test': testOutbox.push({ ...m, raw: buildMessage(m) }); return { ok: true, transient: false, code: null, message: null, reply: 250 };
    case 'file': {
      try {
        mkdirSync(cfg.emailOutboxDir, { recursive: true });
        writeFileSync(path.join(cfg.emailOutboxDir, `${m.messageId.replace(/[^A-Za-z0-9._-]/g, '_')}.eml`), buildMessage(m));
        return { ok: true, transient: false, code: null, message: null, reply: 250 };
      } catch (err) {
        return { ok: false, transient: true, code: 'outbox_write_failed', message: `Could not write to the email outbox (${(err as NodeJS.ErrnoException).code}).`, reply: null };
      }
    }
    case 'smtp': return sendSmtp(cfg.smtpUrl, m, { timeoutMs: cfg.deliveryTimeoutMs, production: cfg.env === 'production' });
  }
}
