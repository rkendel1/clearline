// In-memory sliding-window rate limiter for the public assistant. Per client key plus a global ceiling.
// Process-local (like the query workspace's concurrency limits): with several API replicas each enforces
// its own window. Behind a proxy every client shares the proxy's address unless the proxy is trusted.

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perKey: number, private global: number, private windowMs = 60_000) {}
  check(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number; scope: 'client' | 'global' } {
    const cut = now - this.windowMs;
    const mine = (this.hits.get(key) ?? []).filter((t) => t > cut);
    const all = this.hits.get('*') ?? [];
    const allRecent = all.filter((t) => t > cut);
    if (allRecent.length >= this.global) return { ok: false, retryAfterS: Math.max(1, Math.ceil((allRecent[0] + this.windowMs - now) / 1000)), scope: 'global' };
    if (mine.length >= this.perKey) return { ok: false, retryAfterS: Math.max(1, Math.ceil((mine[0] + this.windowMs - now) / 1000)), scope: 'client' };
    mine.push(now); allRecent.push(now);
    this.hits.set(key, mine); this.hits.set('*', allRecent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => t > cut)) this.hits.delete(k);
    return { ok: true };
  }
}
