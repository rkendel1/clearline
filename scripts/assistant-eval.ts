// Retrieval evaluation. For each question with known supporting sources, did retrieval return one of them in
// the top k (recall@k), and at what rank (reciprocal rank)? Questions with no supporting source must fall below
// the evidence threshold (the assistant declines). Retrieval is evaluated separately from answer generation.
//   npm run assistant:eval            (prints results)
//   npm run assistant:eval -- --write (also rewrites docs/assistant-evaluation.md)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool } from '../src/platform/db.js';
import { getEmbedder } from '../src/assistant/embed.js';
import { indexMeta, search } from '../src/assistant/store.js';
import { limits } from '../src/assistant/answer.js';
import { getPool } from '../src/platform/db.js';
import { contentDir, repoRoot } from '../src/assistant/content.js';

interface Q { id: string; kind: string; question: string; expect: string[]; note: string }
const set = JSON.parse(readFileSync(join(contentDir(), 'eval', 'retrieval-eval.json'), 'utf8')) as { k: number; questions: Q[] };
const emb = getEmbedder();
const meta = await indexMeta(getPool());
if (!meta) { console.error('No index. Run: npm run assistant:index'); process.exit(2); }
const lim = limits();
const rows: { q: Q; rank: number | null; best: number; top: string[]; pass: boolean }[] = [];
for (const q of set.questions) {
  const [v] = await emb.embed([q.question]);
  const hits = await search(emb, v, { access: ['public'], k: set.k });
  const best = hits[0]?.score ?? 0;
  if (q.expect.length === 0) { rows.push({ q, rank: null, best, top: hits.slice(0, 2).map((h) => h.id), pass: best < lim.minScore }); continue; }
  const idx = hits.findIndex((h) => q.expect.some((e) => h.id.startsWith(e)));
  rows.push({ q, rank: idx < 0 ? null : idx + 1, best, top: hits.slice(0, 3).map((h) => h.id), pass: idx >= 0 });
}
const answerable = rows.filter((r) => r.q.expect.length);
const recall = answerable.filter((r) => r.rank !== null).length / answerable.length;
const mrr = answerable.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / answerable.length;
const declined = rows.filter((r) => !r.q.expect.length);
const declinedOk = declined.filter((r) => r.pass).length;
const byKind = [...new Set(answerable.map((r) => r.q.kind))].map((k) => { const s = answerable.filter((r) => r.q.kind === k); return `${k}: ${s.filter((r) => r.rank).length}/${s.length}`; });
const md = `# Assistant retrieval evaluation

Measured, not claimed. Produced by \`npm run assistant:eval\` (add \`-- --write\` to refresh this file) against the index described below.

| | |
|---|---|
| Embedding provider / model | ${meta.embedder} / ${meta.model} (${meta.dim} dimensions) |
| Corpus version | \`${meta.corpus_version}\` (${meta.chunk_count} chunks) |
| Retrieval depth (k) | ${set.k} |
| Evidence threshold | ${lim.minScore} cosine similarity |
| Questions with known sources | ${answerable.length} |
| **Recall@${set.k}** (at least one expected source in the top ${set.k}) | **${(recall * 100).toFixed(0)}%** (${answerable.filter((r) => r.rank).length}/${answerable.length}) |
| Mean reciprocal rank | ${mrr.toFixed(2)} |
| Unsupported questions correctly declined (best score below threshold) | ${declinedOk}/${declined.length} |
| By kind | ${byKind.join('; ')} |

The set is small and was written by the authors of the corpus, so it measures regression and coarse quality, not general accuracy. Retrieval is evaluated separately from answer grounding: grounding and citation checks are in \`test/unit/assistant.test.ts\` and \`test/integration/assistant.test.ts\`.

## Per question

| Id | Kind | Question | Rank of first expected source | Best score | Result |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.q.id} | ${r.q.kind} | ${r.q.question} | ${r.q.expect.length ? (r.rank ?? 'not in top ' + set.k) : 'n/a'} | ${r.best.toFixed(2)} | ${r.pass ? 'pass' : '**miss**'} |`).join('\n')}

## Known limits of this evaluation

- Expected sources are chosen by the question's author; other chunks may also be relevant.
- A small local embedding model has lower recall than a large hosted one; the evidence threshold was set by inspection of this set and may reject some answerable questions.
- It does not measure the quality of the written answer, only whether the right evidence is retrieved.
`;
console.log(md);
if (process.argv.includes('--write')) writeFileSync(join(repoRoot(), 'docs', 'assistant-evaluation.md'), md);
await closePool();
