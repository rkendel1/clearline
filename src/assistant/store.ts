// pgvector retrieval index in the same PostgreSQL as everything else (schema `assistant`). It is a
// retrieval index only: it holds approved public content and never business data or secrets.
// The index records which embedding model built it; vectors from different models are never mixed.

import type pg from 'pg';
import { getPool } from '../platform/db.js';
import { log } from '../platform/logger.js';
import { buildCorpus, type Access, type Chunk, type Dest } from './corpus.js';
import type { Embedder } from './embed.js';

export interface IndexMeta { embedder: string; model: string; dim: number; corpus_version: string; indexed_at: string; chunk_count: number }
export interface Hit { id: string; source: string; source_type: string; title: string; heading: string; text: string; access: Access; dest: Dest; refs: string[]; score: number }

export class IndexUnavailable extends Error {
  constructor(readonly reason: 'no_extension' | 'not_built' | 'model_mismatch' | 'database', message: string) { super(message); }
}

const vec = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;

async function hasExtension(c: pg.PoolClient | pg.Pool): Promise<boolean> {
  return ((await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0) > 0;
}

export async function indexMeta(c: pg.Pool | pg.PoolClient = getPool()): Promise<IndexMeta | null> {
  const t = await c.query(`SELECT to_regclass('assistant.index_meta') AS r`);
  if (!t.rows[0].r) return null;
  const r = await c.query(`SELECT embedder, model, dim, corpus_version, indexed_at, chunk_count FROM assistant.index_meta WHERE id = 1`);
  return r.rows[0] ? { ...r.rows[0], indexed_at: new Date(r.rows[0].indexed_at).toISOString() } : null;
}

export interface IndexResult { added: number; updated: number; unchanged: number; removed: number; total: number; corpus_version: string; embedder: string; model: string }

/** Build or refresh the index. Unchanged chunks are not re-embedded; removed sources are deleted. `rebuild` drops everything (required to change embedding model). */
export async function indexCorpus(embedder: Embedder, opts: { rebuild?: boolean } = {}): Promise<IndexResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    if (!(await hasExtension(client))) throw new IndexUnavailable('no_extension', 'The pgvector extension is not installed in this PostgreSQL (use the db image in db/Dockerfile).');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE SCHEMA IF NOT EXISTS assistant');
    const meta = await indexMeta(client);
    if (meta && (meta.embedder !== embedder.id || meta.model !== embedder.model || meta.dim !== embedder.dim)) {
      if (!opts.rebuild) throw new IndexUnavailable('model_mismatch', `The index was built with ${meta.embedder}/${meta.model} (${meta.dim}d); the configured embedder is ${embedder.id}/${embedder.model} (${embedder.dim}d). Run a rebuild (npm run assistant:index -- --rebuild); vectors are never mixed.`);
    }
    if (opts.rebuild) await client.query('DROP TABLE IF EXISTS assistant.chunks; DROP TABLE IF EXISTS assistant.index_meta');
    await client.query(`CREATE TABLE IF NOT EXISTS assistant.index_meta (id int PRIMARY KEY CHECK (id = 1), embedder text NOT NULL, model text NOT NULL, dim int NOT NULL, corpus_version text NOT NULL, indexed_at timestamptz NOT NULL, chunk_count int NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS assistant.chunks (id text PRIMARY KEY, source text NOT NULL, source_type text NOT NULL, title text NOT NULL, heading text NOT NULL, content text NOT NULL,
      content_hash text NOT NULL, access text NOT NULL, dest jsonb NOT NULL, refs jsonb NOT NULL, embedding vector(${embedder.dim}) NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON assistant.chunks USING hnsw (embedding vector_cosine_ops)`);

    const { chunks, version } = buildCorpus();
    const existing = new Map<string, string>((await client.query(`SELECT id, content_hash FROM assistant.chunks`)).rows.map((r) => [r.id, r.content_hash]));
    const todo = chunks.filter((c) => existing.get(c.id) !== c.hash);
    const vectors: number[][] = todo.length ? await embedder.embed(todo.map((c) => `${c.title}\n${c.heading}\n${c.text}`)) : [];
    await client.query('BEGIN');
    try {
      let added = 0, updated = 0;
      for (const [i, c] of todo.entries()) {
        if (existing.has(c.id)) updated++; else added++;
        await client.query(`INSERT INTO assistant.chunks (id, source, source_type, title, heading, content, content_hash, access, dest, refs, embedding, indexed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector, now())
          ON CONFLICT (id) DO UPDATE SET source=$2, source_type=$3, title=$4, heading=$5, content=$6, content_hash=$7, access=$8, dest=$9, refs=$10, embedding=$11::vector, indexed_at=now()`,
          [c.id, c.source, c.source_type, c.title, c.heading, c.text, c.hash, c.access, JSON.stringify(c.dest), JSON.stringify(c.refs), vec(vectors[i])]);
      }
      const keep = chunks.map((c) => c.id);
      const del = await client.query(`DELETE FROM assistant.chunks WHERE NOT (id = ANY($1::text[]))`, [keep]);
      await client.query(`INSERT INTO assistant.index_meta (id, embedder, model, dim, corpus_version, indexed_at, chunk_count) VALUES (1,$1,$2,$3,$4, now(), $5)
        ON CONFLICT (id) DO UPDATE SET embedder=$1, model=$2, dim=$3, corpus_version=$4, indexed_at=now(), chunk_count=$5`, [embedder.id, embedder.model, embedder.dim, version, chunks.length]);
      await client.query('COMMIT');
      const res = { added, updated, unchanged: chunks.length - todo.length, removed: del.rowCount ?? 0, total: chunks.length, corpus_version: version, embedder: embedder.id, model: embedder.model };
      log.info('assistant index updated', res);
      return res;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  } finally { client.release(); }
}

/** Nearest chunks to a query vector. The access filter is applied in SQL, before any text reaches an answer. */
export async function search(embedder: Embedder, queryVec: number[], opts: { access: Access[]; k: number }): Promise<Hit[]> {
  const pool = getPool();
  let meta: IndexMeta | null;
  try { meta = await indexMeta(pool); } catch (e) { throw new IndexUnavailable('database', (e as Error).message); }
  if (!meta) throw new IndexUnavailable('not_built', 'The assistant index has not been built. Run: npm run assistant:index');
  if (meta.embedder !== embedder.id || meta.model !== embedder.model) throw new IndexUnavailable('model_mismatch', 'The index was built with a different embedding model; rebuild it.');
  const r = await pool.query(`SELECT id, source, source_type, title, heading, content AS text, access, dest, refs, 1 - (embedding <=> $1::vector) AS score
    FROM assistant.chunks WHERE access = ANY($2::text[]) ORDER BY embedding <=> $1::vector LIMIT $3`, [vec(queryVec), opts.access, opts.k]);
  return r.rows.map((x) => ({ ...x, score: Number(x.score) }));
}
