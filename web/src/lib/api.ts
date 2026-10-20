// Typed access to the Clearline HTTP API (docs/api.md). The bearer token lives in module memory only:
// never in storage, cookies or the URL, so closing the tab signs out (same as the native client).
// The client adds no business rules; the server authorizes every request.

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly correlationId?: string) { super(message); }
}

export interface Me { actor: string; tenant_id: string | null; role: string; permissions: string[] }

let token: string | null = null;
let me: Me | null = null;
let onUnauthorized: (() => void) | null = null;

export const session = {
  get token() { return token; },
  get me() { return me; },
  get tenant(): string { if (!me?.tenant_id) throw new ApiError(0, 'no_tenant', 'This token is not bound to a tenant.'); return me.tenant_id; },
  can: (perm: string) => !!me?.permissions.includes(perm),
  onUnauthorized: (fn: (() => void) | null) => { onUnauthorized = fn; },
  async signIn(t: string): Promise<Me> {
    const previous = token;
    token = t.trim();
    try { me = await request<Me>('GET', '/api/v1/me', undefined, { quietAuth: true }); return me; }
    catch (e) { token = previous; throw e; }
  },
  signOut() { token = null; me = null; },
};

interface Opts { okStatuses?: number[]; quietAuth?: boolean; signal?: AbortSignal; headers?: Record<string, string> }

async function raw(method: string, path: string, body: unknown, o: Opts): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof body === 'string') payload = body; else { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  let res: Response;
  try { res = await fetch(path, { method, headers, body: payload, signal: o.signal, cache: 'no-store', credentials: 'omit' }); }
  catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new ApiError(0, 'network', 'Cannot reach the Clearline API. Check that it is running.'); }
  if (!res.ok && !o.okStatuses?.includes(res.status)) {
    let j: { error?: { code?: string; message?: string; details?: unknown }; correlation_id?: string } = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    const err = new ApiError(res.status, j.error?.code ?? `http_${res.status}`, j.error?.message ?? res.statusText, j.error?.details, j.correlation_id ?? res.headers.get('x-correlation-id') ?? undefined);
    if (res.status === 401 && !o.quietAuth) onUnauthorized?.();
    throw err;
  }
  return res;
}

export async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, o: Opts = {}): Promise<T> {
  const res = await raw(method, path, body, o);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Like request, but also returns the status (publishing a contract is 201 applied / 202 awaiting approval). */
export async function requestWithStatus<T>(method: 'GET' | 'POST', path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
  const res = await raw(method, path, body, { okStatuses });
  return { status: res.status, data: (await res.json()) as T };
}

export async function download(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ blob: Blob; filename: string; headers: Headers }> {
  const res = await raw(method, path, body, {});
  const cd = res.headers.get('content-disposition') ?? '';
  return { blob: await res.blob(), filename: /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'clearline.csv', headers: res.headers };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const t = (p = '') => `/api/v1/tenants/${encodeURIComponent(session.tenant)}${p}`;
export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
export const enc = encodeURIComponent;
