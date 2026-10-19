// Thin API client. The dashboard renders what the API returns; it does not
// compute metrics, statuses or reconciliation itself (see docs/architecture.md).

const KEY = 'clearline.token';

export function getToken(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable: token lives for this page only */ }
  memoryToken = t;
}
let memoryToken: string | null = getToken();

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public correlationId?: string) { super(message); }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(memoryToken ? { authorization: `Bearer ${memoryToken}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
  if (!res.ok) {
    const e = (body as { error?: { code: string; message: string }; correlation_id?: string }) ?? {};
    throw new ApiError(res.status, e.error?.code ?? 'http_error', e.error?.message ?? `HTTP ${res.status}`, e.correlation_id);
  }
  return body as T;
}

export async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {} });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new ApiError(res.status, e.error?.code ?? 'http_error', e.error?.message ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return { rows: res.headers.get('x-clearline-row-count'), sha256: res.headers.get('x-clearline-sha256') };
}

export interface Me { actor: string; tenant_id: string | null; role: 'platform_admin' | 'admin' | 'operator' | 'reporter' }
