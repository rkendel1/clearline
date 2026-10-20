// Embedding providers for the assistant's retrieval index.
//
//  - local (default): a small open sentence-embedding model run in-process (@huggingface/transformers, ONNX).
//    No network at query time, no key, nothing leaves the machine. The model files are downloaded once
//    (baked into the Docker image at build time) into EMBEDDING_CACHE_DIR.
//  - hash: a deterministic feature-hashing bag-of-words embedder with no model. Meant for tests and for
//    environments where the model cannot be fetched. It is lexical, not semantic; the index records which
//    provider built it, and the two are never mixed.
//
// Only approved public content and the visitor's question are ever embedded.

import { createHash } from 'node:crypto';

export interface Embedder {
  readonly id: string;        // provider id, e.g. "local" or "hash"
  readonly model: string;     // model identity recorded with the index
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

class LocalEmbedder implements Embedder {
  readonly id = 'local';
  readonly model = LOCAL_MODEL;
  readonly dim = 384;
  private extractor: Promise<(t: string[], o: object) => Promise<{ tolist(): number[][] }>> | undefined;

  async embed(texts: string[]): Promise<number[][]> {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      if (process.env.EMBEDDING_CACHE_DIR) env.cacheDir = process.env.EMBEDDING_CACHE_DIR;
      // Runtime downloads are allowed only when explicitly enabled; the image ships the model.
      env.allowRemoteModels = process.env.EMBEDDING_ALLOW_DOWNLOAD !== 'false';
      return (await pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'fp32' })) as never;
    })();
    const ex = await this.extractor;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const t = await ex(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
      out.push(...t.tolist());
    }
    return out;
  }
}

const STOP = new Set('a an and are as at be by for from has have how in is it its of on or that the this to was what when where which who why with does do can i we you your'.split(' '));
export const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

class HashEmbedder implements Embedder {
  readonly id = 'hash';
  readonly model = 'feature-hash-bow-v1';
  readonly dim = 384;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      const words = tokenize(t);
      const grams = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
      for (const g of grams) {
        const h = createHash('md5').update(g).digest();
        v[h.readUInt16BE(0) % this.dim] += h[2] & 1 ? 1 : -1;
      }
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
  }
}

let cached: Embedder | undefined;
export function getEmbedder(): Embedder {
  if (cached) return cached;
  const which = process.env.EMBEDDING_PROVIDER ?? 'local';
  if (which === 'hash') cached = new HashEmbedder();
  else if (which === 'local') cached = new LocalEmbedder();
  else throw new Error(`EMBEDDING_PROVIDER must be local or hash, got ${which}`);
  return cached;
}
export const resetEmbedder = () => { cached = undefined; };
