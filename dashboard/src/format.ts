// Presentation-only formatting. Values arrive from the API as exact strings;
// we add grouping separators but never round or re-derive them.

export function groupDigits(s: string): string {
  const neg = s.startsWith('-');
  const [i, f] = s.replace(/^-/, '').split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${grouped}${f !== undefined ? '.' + f : ''}`;
}

export function formatValue(v: string | number | null | undefined, unit?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  if (unit === 'usd') return `$${groupDigits(s)}`;
  if (unit === 'ratio') return `${(Number(s) * 100).toFixed(2)}%`;
  return /^-?\d+(\.\d+)?$/.test(s) ? groupDigits(s) : s;
}

export function when(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const shortId = (id: string) => id.slice(0, 8);
export const seconds = (s: number | string | null) => (s === null || s === undefined ? '—' : `${Number(s).toFixed(Number(s) < 10 ? 2 : 0)} s`);
