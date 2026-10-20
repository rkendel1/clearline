// Deterministic provider: maps a fixed set of analytical intents onto the
// permitted catalog by column and table names. No network, no model, the same
// SQL for the same question and catalog. It is the default provider, so the
// demo and every test run without inference. Because it only ever sees the
// permitted catalog, it cannot propose a column the role may not discover.

import type { ProviderRequest, ProviderResult, SqlProvider } from './types.js';

type Cat = ProviderRequest['catalog'];
type Table = Cat['tables'][number];

const cols = (t: Table, pred: (c: Table['columns'][number]) => boolean) => t.columns.filter(pred).map((c) => c.name);
const full = (t: Table) => cols(t, (c) => c.access === 'full' && !c.name.startsWith('_'));
const table = (cat: Cat, pred: (t: Table) => boolean) => cat.tables.find(pred);
/** First fully visible decimal column matching the earliest preference (catalog order is not meaningful: contracts are stored as jsonb). */
const amountCol = (t: Table, prefer: RegExp[]) => {
  const dec = t.columns.filter((c) => c.access === 'full' && c.type === 'decimal').map((c) => c.name).sort();
  for (const re of prefer) { const hit = dec.find((n) => re.test(n)); if (hit) return hit; }
  return dec[0];
};
const dateCol = (t: Table) => {
  const d = t.columns.filter((c) => c.access === 'full' && c.type === 'date').map((c) => c.name).sort();
  return d.find((n) => /service/.test(n)) ?? d.find((n) => /fill/.test(n)) ?? d[0];
};
const claimTable = (cat: Cat) => table(cat, (t) => t.kind === 'entity' && /claim/.test(t.name) && t.columns.some((c) => c.type === 'decimal' && c.access === 'full'));

const cannot = (why: string): ProviderResult => ({ kind: 'cannot_answer', explanation: why });
const NOT_MAPPED = 'I could not map this request onto the data available to your role. Try naming a table or column from the catalog, or write the SQL yourself.';

export class DeterministicProvider implements SqlProvider {
  readonly id = 'deterministic';
  readonly model = 'rules@1';

  async generate(req: ProviderRequest): Promise<ProviderResult> {
    const q = req.question.toLowerCase();
    const cat = req.catalog;

    // "Show the total paid amount by tenant for the last month."
    if (/total/.test(q) && /paid/.test(q) && /(last|previous) month/.test(q)) {
      const t = claimTable(cat);
      const amt = t && amountCol(t, [/^paid/, /paid/]);
      const d = t && dateCol(t);
      if (!t || !amt || !d) return cannot(NOT_MAPPED);
      return {
        kind: 'proposal',
        sql: `SELECT '${cat.tenant}' AS tenant, count(*) AS claims, sum(c.${amt}) AS total_paid\nFROM ${t.name} c\nWHERE c.${d} >= date_trunc('month', current_date) - interval '1 month'\n  AND c.${d} < date_trunc('month', current_date)\n  AND c._trust_status = 'trusted'`,
        explanation: `Sums ${t.name}.${amt} for ${t.name} records whose ${d} falls in the previous calendar month, counting only records from trusted batches (as the reported metrics do).`,
        assumptions: [`"Last month" means the previous calendar month relative to ${req.today}.`, `Queries are scoped to your tenant (${cat.tenant}); one row is returned for it.`, `"Paid amount" is ${t.name}.${amt}.`],
      };
    }

    // "Compare paid amounts across the last three reporting periods."
    if (/paid/.test(q) && /(last|past) (three|3) (reporting )?(periods|months)/.test(q)) {
      const t = claimTable(cat);
      const amt = t && amountCol(t, [/^paid/, /paid/]);
      const d = t && dateCol(t);
      if (!t || !amt || !d) return cannot(NOT_MAPPED);
      return {
        kind: 'proposal',
        sql: `SELECT to_char(date_trunc('month', c.${d}), 'YYYY-MM') AS period, count(*) AS claims, sum(c.${amt}) AS total_paid\nFROM ${t.name} c\nWHERE c.${d} >= date_trunc('month', current_date) - interval '3 months'\n  AND c.${d} < date_trunc('month', current_date)\n  AND c._trust_status = 'trusted'\nGROUP BY 1\nORDER BY 1`,
        explanation: `Totals ${t.name}.${amt} per calendar month of ${d} for the three complete months before the current one, trusted data only.`,
        assumptions: ['A reporting period is a calendar month.', `The current, incomplete month is excluded (today is ${req.today}).`],
      };
    }

    // "Find claims that reference members who have not arrived."
    if (/(not|never) (arrived|been received|received)|missing member|orphan/.test(q)) {
      for (const rel of cat.relationships) {
        const from = table(cat, (t) => t.name === rel.from.table);
        if (!from || from.kind !== 'entity' || rel.to.table === 'batches') continue;
        const wanted = /claim/.test(q) ? /claim/.test(from.name) : true;
        if (!wanted || !q.includes(rel.to.table.replace(/_/g, ' ').replace(/s?$/, ''))) continue;
        const key = from.key[0] ?? full(from)[0];
        const ref = from.columns.find((c) => c.name === rel.from.column)!;
        const show = [key, ref.access === 'full' || ref.access === 'masked' ? rel.from.column : null, '_batch_id'].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
        return {
          kind: 'proposal',
          sql: `SELECT ${show.map((c) => `x.${c}`).join(', ')}\nFROM ${from.name} x\nWHERE x.${rel.from.column} IS NOT NULL\n  AND NOT EXISTS (SELECT 1 FROM ${rel.to.table} t WHERE t.${rel.to.column} = x.${rel.from.column})\nORDER BY x.${key}`,
          explanation: `Lists ${from.name} records whose ${rel.from.column} does not match any ${rel.to.table}.${rel.to.column} received so far.`,
          assumptions: [`"Have not arrived" means no current ${rel.to.table} record with that key exists in Clearline yet.`],
        };
      }
      return cannot(NOT_MAPPED);
    }

    // "Show me batches with reconciliation failures."
    if (/batch/.test(q) && /reconcil/.test(q) && /(fail|failure|failing|mismatch)/.test(q)) {
      if (!table(cat, (t) => t.name === 'batches') || !table(cat, (t) => t.name === 'reconciliation_results')) return cannot(NOT_MAPPED);
      return {
        kind: 'proposal',
        sql: `SELECT b.id, b.source_id, b.status, b.trust_status, b.arrival_at, count(*) AS failed_checks\nFROM batches b\nJOIN reconciliation_results r ON r.batch_id = b.id\nWHERE r.status = 'failed' AND r.scope = 'batch'\nGROUP BY b.id, b.source_id, b.status, b.trust_status, b.arrival_at\nORDER BY b.arrival_at DESC`,
        explanation: 'Lists batches with at least one failed batch-level reconciliation check, with the number of failed checks.',
        assumptions: ['Only batch-scoped checks are counted; dataset-level checks are not tied to one batch.'],
      };
    }

    // "List claims with amounts above $5,000, excluding sensitive member information."
    const above = /(above|over|more than|greater than|exceeding)\s*\$?\s*([\d,]+(?:\.\d+)?)/.exec(q);
    if (above && /claim/.test(q)) {
      const t = claimTable(cat);
      const amt = t && amountCol(t, [/billed/, /total/, /amount/, /cost/]);
      if (!t || !amt) return cannot(NOT_MAPPED);
      const n = above[2].replace(/,/g, '');
      const excludeSensitive = /sensitive|without (member|personal)|exclud/.test(q);
      const show = t.columns.filter((c) => !c.name.startsWith('_') && (c.access === 'full' || (!excludeSensitive && c.access === 'masked')) && !(excludeSensitive && c.sensitive)).map((c) => c.name);
      return {
        kind: 'proposal',
        sql: `SELECT ${show.join(', ')}\nFROM ${t.name}\nWHERE ${amt} > ${n}\nORDER BY ${amt} DESC`,
        explanation: `Lists ${t.name} records with ${amt} above ${n}${excludeSensitive ? ', returning only columns that are not classified sensitive and that your role may see in full' : ''}. No member table is joined.`,
        assumptions: [`"Amount" is ${t.name}.${amt}.`],
      };
    }

    // "List members with their ssn and last name": columns named in the question, resolved against the
    // permitted catalog only. A name the role cannot discover is indistinguishable from a nonexistent one.
    const withCols = /\b(?:list|show)\s+(?:all\s+|the\s+)?([a-z_ ]+?)\s+with\s+(?:their\s+|the\s+)?(.+?)[.?!]*$/.exec(q);
    if (withCols) {
      const t = cat.tables.find((x) => new RegExp(`^${x.name.replace(/_/g, ' ')}s?$`).test(withCols[1].trim()));
      if (!t) return cannot(NOT_MAPPED);
      const wanted = withCols[2].split(/,|\band\b/).map((w) => w.trim().replace(/^(their|the)\s+/, '')).filter(Boolean);
      const names: string[] = [];
      for (const w of wanted) {
        const col = t.columns.find((c) => c.name === w.replace(/\s+/g, '_') || c.name.replace(/_/g, ' ') === w);
        if (!col) return cannot(NOT_MAPPED);
        names.push(col.name);
      }
      const key = t.key[0] ?? full(t)[0];
      const cols = [...new Set([key, ...names])];
      return { kind: 'proposal', sql: `SELECT ${cols.join(', ')}\nFROM ${t.name}\nORDER BY ${key}\nLIMIT 100`,
        explanation: `Lists up to 100 ${t.name} records with ${names.join(', ')}.`, assumptions: [] };
    }

    // Generic: "count <table>" / "list|show <table>".
    for (const t of cat.tables) {
      const name = t.name.replace(/_/g, ' ');
      if (!new RegExp(`\\b${name}s?\\b`).test(q)) continue;
      if (/how many|count|number of/.test(q)) {
        return { kind: 'proposal', sql: `SELECT count(*) AS ${t.name}_count FROM ${t.name}`, explanation: `Counts current ${t.name} records.`, assumptions: [] };
      }
      if (/\b(list|show)\b/.test(q)) {
        const show = full(t).slice(0, 12);
        if (!show.length) return cannot(NOT_MAPPED);
        return { kind: 'proposal', sql: `SELECT ${show.join(', ')}\nFROM ${t.name}\nORDER BY ${show[0]}\nLIMIT 100`, explanation: `Lists up to 100 ${t.name} records (columns your role may see in full).`, assumptions: [] };
      }
    }
    return cannot(NOT_MAPPED);
  }
}
