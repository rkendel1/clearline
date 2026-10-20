// Display formatting only. Exact numbers arrive as strings (PostgreSQL NUMERIC) and are shown as sent.

export function when(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

export function count(v: unknown): string { const n = num(v); return n === null ? cell(v) || '—' : n.toLocaleString(); }
export function pct(v: unknown, digits = 1): string { const n = num(v); return n === null ? '—' : `${(n * 100).toFixed(digits)}%`; }
export function ms(v: unknown): string { const n = num(v); return n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`; }
export function short(id: string | null | undefined): string { return id ? id.slice(0, 8) : '—'; }
export function words(s: string | null | undefined): string { return (s ?? '').replace(/[_.]/g, ' '); }

export type Tone = 'good' | 'warn' | 'bad' | 'idle' | 'info';

const TONES: Record<string, Tone> = {
  ok: 'good', healthy: 'good', succeeded: 'good', success: 'good', committed: 'good', trusted: 'good', active: 'good', applied: 'good', delivered: 'good', fresh: 'good', passed: 'good', pass: 'good', allowed: 'good', resolved: 'good', full: 'good', sent: 'good', enabled: 'good',
  warning: 'warn', warn: 'warn', stale: 'warn', late: 'warn', pending: 'warn', pending_approval: 'warn', retrying: 'warn', paused: 'warn', untrusted: 'warn', needs_attention: 'warn', insufficient_data: 'warn', stale_schema: 'warn', open: 'warn', partial: 'warn', masked: 'warn', medium: 'warn', unsupported_input: 'warn', degraded: 'warn',
  none: 'idle', queued: 'idle', low: 'idle', disabled: 'idle', archived: 'idle', cancelled: 'idle', rolled_back: 'idle',
  running: 'info', processing: 'info', delivering: 'info', sending: 'info',
  failed: 'bad', failing: 'bad', fail: 'bad', error: 'bad', denied: 'bad', blocked: 'bad', critical: 'bad', invalid_configuration: 'bad', algorithm_failure: 'bad', unhealthy: 'bad', high: 'bad', rejected: 'bad',
};
export const tone = (s: string | null | undefined): Tone => TONES[(s ?? '').toLowerCase()] ?? 'idle';
