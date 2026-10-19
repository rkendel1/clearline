// Helpers for the query workspace scenarios (K-O): thin wrappers over the HTTP API.

import assert from 'node:assert/strict';
import type { Res } from './harness.js';

type Client = { get: (u: string) => Promise<Res>; post: (u: string, b?: unknown) => Promise<Res> };

export function queries(c: Client, tenant: string) {
  const base = `/api/v1/tenants/${tenant}/queries`;
  const seen: string[] = [];
  const keep = (r: Res) => { seen.push(r.text); return r; };
  return {
    /** Every response body this helper received, for "no value leaked anywhere" checks. */
    seen,
    catalog: async () => keep(await c.get(`${base}/catalog`)),
    ask: async (question: string) => keep(await c.post(`${base}/proposals`, { question })),
    sql: async (sql: string, parent_id?: string) => keep(await c.post(`${base}/proposals`, { sql, parent_id })),
    run: async (id: string, mode: 'preview' | 'run' = 'run') => keep(await c.post(`${base}/proposals/${id}/execute`, { mode })),
    exportCsv: async (id: string) => keep(await c.post(`${base}/proposals/${id}/export`, {})),
    history: async (all = false) => keep(await c.get(`${base}/history${all ? '?all=true' : ''}`)),
    /** Propose SQL, assert it validates, run it, assert success; returns rows as objects. */
    async rows(sql: string): Promise<{ proposal: any; result: any; objects: Record<string, unknown>[] }> {
      const p = await this.sql(sql);
      assert.equal(p.status, 201);
      assert.ok(p.body.validation.ok, `expected valid: ${sql}\n${JSON.stringify(p.body.validation.issues)}`);
      const r = await this.run(p.body.id, 'run');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.status, 'succeeded', JSON.stringify(r.body.error));
      return { proposal: p.body, result: r.body, objects: r.body.rows.map((row: unknown[]) => Object.fromEntries(r.body.columns.map((col: { name: string }, i: number) => [col.name, row[i]]))) };
    },
  };
}
