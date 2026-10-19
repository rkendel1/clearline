// Structured JSON logger. Logs carry correlation and processing-run IDs and
// must never contain raw record payloads. `safeFields` strips any key that
// looks like payload content before writing.

import { loadConfig } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const FORBIDDEN_KEYS = new Set(['payload', 'row', 'rows', 'record', 'records', 'body', 'values', 'raw', 'token', 'authorization', 'password']);

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) { out[k] = '[omitted]'; continue; }
    if (v instanceof Error) { out[k] = { name: v.name, message: v.message, code: (v as { code?: string }).code }; continue; }
    out[k] = v;
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    const min = LEVELS[loadConfig().logLevel] ?? 20;
    if (LEVELS[level] < min) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...bindings, ...safeFields(fields) });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => createLogger({ ...bindings, ...safeFields(b) }),
  };
}

export const log = createLogger({ service: 'clearline' });
