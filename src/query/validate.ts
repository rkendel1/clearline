// Structural validation of analytical SQL against a role's permitted catalog.
//
// The SQL is parsed by PostgreSQL's own parser (libpg-query, the parser compiled
// from the PostgreSQL source), and the resulting tree is checked against an
// ALLOWLIST: any node type, clause, function, operator or type cast not handled
// below is rejected. Nothing is matched with regular expressions.
//
// What is accepted: one SELECT statement over the logical tables in the catalog,
// with joins (ON conditions), subqueries in FROM / WHERE / select list, non-recursive
// CTEs, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET, DISTINCT, CASE, casts to
// plain types, a small set of aggregate and scalar functions.
//
// Field access (src/policy/fields.ts) is enforced on the tree, by tracking which
// base columns every expression derives from:
//   hidden    the column does not resolve: the error is identical to a nonexistent column
//   discover  any reference is rejected
//   filter    allowed only as `a = b` between related key columns, in IS [NOT] NULL,
//             in `x IN (SELECT y ...)` between related keys, and passed through
//             subqueries unchanged; never in the final result
//   masked    as filter, and returned in the final result only as the bare column,
//             which is rewritten to core.mask_value(col, style) so the database
//             returns the redacted form
//   full      anything
// Comparisons with literals, LIKE, functions, CASE, casts, GROUP BY, ORDER BY,
// DISTINCT and aggregates over restricted columns are therefore rejected, which
// closes value inference through counts, sorting and conditional expressions.
//
// The validated tree is rewritten (logical tables -> q_<tenant> views, masking,
// row cap) and deparsed; the deparsed SQL is parsed again and re-checked so the
// executed text is exactly what was validated.

import { createHash } from 'node:crypto';
import { parse, deparse } from 'pgsql-parser';
import type { Catalog, CatalogColumn, CatalogTable } from './catalog.js';
import type { AccessLevel } from '../policy/fields.js';

export interface ValidationIssue { code: string; message: string }

export interface ColumnUse { table: string; column: string; access: AccessLevel; usages: string[] }

export interface OutputColumn { name: string; table: string | null; column: string | null; masked: string | null }

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  tables: string[];
  columns: ColumnUse[];
  joins: { type: string; tables: string[] }[];
  output: OutputColumn[];
  summary: string[];
  /** Server-rewritten SQL with the configured row cap; the text that will run. */
  validated_sql: string | null;
  validated_sql_sha256: string | null;
  /** Deparse the rewritten tree with a different row cap (preview / truncation probe). */
  withLimit?: (n: number) => Promise<string>;
}

export interface ValidateOptions { maxRows: number; maxLength?: number }

class Reject extends Error { constructor(readonly code: string, message: string) { super(message); } }

const LIMITS = { length: 20_000, depth: 60, fromItems: 12, subqueries: 16 };

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);
/** Scalar functions: name -> [min args, max args]. */
const SCALARS: Record<string, [number, number]> = {
  round: [1, 2], abs: [1, 1], ceil: [1, 1], ceiling: [1, 1], floor: [1, 1], lower: [1, 1], upper: [1, 1], length: [1, 1], btrim: [1, 2],
  date_trunc: [2, 2], date_part: [2, 2], extract: [2, 2], to_char: [2, 2], now: [0, 0], age: [1, 2], make_date: [3, 3],
};
const OPERATORS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '||']);
const CAST_TYPES = new Set(['int2', 'int4', 'int8', 'int', 'integer', 'smallint', 'bigint', 'numeric', 'decimal', 'float4', 'float8', 'real',
  'text', 'varchar', 'bool', 'boolean', 'date', 'timestamp', 'timestamptz', 'interval']);
const TIME_VALUE_FUNCTIONS = new Set(['SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIME', 'SVFOP_CURRENT_TIME_N', 'SVFOP_CURRENT_TIMESTAMP', 'SVFOP_CURRENT_TIMESTAMP_N',
  'SVFOP_LOCALTIME', 'SVFOP_LOCALTIME_N', 'SVFOP_LOCALTIMESTAMP', 'SVFOP_LOCALTIMESTAMP_N']);

type Node = Record<string, any>;
const kind = (n: Node): string => Object.keys(n)[0];
const str = (n: Node | undefined): string | undefined => n?.String?.sval;

interface BaseRef { table: string; col: CatalogColumn }
interface ColInfo { name: string; lineage: BaseRef[]; bare: BaseRef | null; usable: boolean }
interface Info { lineage: BaseRef[]; bare: BaseRef | null; agg: boolean }
interface Rel { alias: string; table: string | null; columns: Map<string, ColInfo> }

class Scope {
  rels: Rel[] = [];
  constructor(readonly parent: Scope | null, readonly ctes: Map<string, ColInfo[]>) {}
  cte(name: string): ColInfo[] | undefined { return this.ctes.get(name) ?? this.parent?.cte(name); }
}

const restricted = (i: { lineage: BaseRef[] }) => i.lineage.filter((b) => b.col.level !== 'full');
const fq = (b: BaseRef) => `${b.table}.${b.col.name}`;
const LEVEL_TEXT: Record<string, string> = {
  masked: 'it is redacted for your role, so it can only be returned as-is, joined to its related key, or tested with IS NULL',
  filter: 'your role may use it only to join to its related key or to test IS NULL; it cannot be returned',
  discover: 'your role may see that it exists but cannot use it in queries',
};

export class Validator {
  private uses = new Map<string, ColumnUse>();
  private tables = new Set<string>();
  private joins: { type: string; tables: string[] }[] = [];
  private summary: string[] = [];
  private subqueries = 0;

  constructor(private cat: Catalog) {}

  /** Validate and rewrite (in place) one parsed SELECT tree. */
  run(stmt: Node): { outputs: ColInfo[] } {
    const outputs = this.select(stmt, null, 0, true);
    return { outputs };
  }

  private use(b: BaseRef, usage: string) {
    const k = fq(b);
    const u = this.uses.get(k) ?? { table: b.table, column: b.col.name, access: b.col.level, usages: [] };
    if (!u.usages.includes(usage)) u.usages.push(usage);
    this.uses.set(k, u);
  }

  report() { return { tables: [...this.tables], columns: [...this.uses.values()], joins: this.joins, summary: this.summary }; }

  private deny(info: { lineage: BaseRef[] }, where: string) {
    const r = restricted(info);
    if (!r.length) return;
    const b = r[0];
    throw new Reject('restricted_field', `Field ${fq(b)} cannot be used in ${where}: ${LEVEL_TEXT[b.col.level] ?? 'it is not available to your role'}.`);
  }

  /**
   * Restricted columns may be compared only along a declared relationship: a foreign key with
   * the key it references, two foreign keys referencing the same key, or a table's own key with
   * itself. Comparing a restricted column with itself elsewhere (a self-join on ssn) would reveal
   * which records share a value, so it is not "related".
   */
  private related(a: BaseRef, b: BaseRef): boolean {
    const target = (x: BaseRef) => this.cat.relationships.find((rel) => rel.from.table === x.table && rel.from.column === x.col.name)?.to;
    const isKey = (x: BaseRef) => this.cat.tables.get(x.table)?.key.length === 1 && this.cat.tables.get(x.table)?.key[0] === x.col.name;
    const domain = (x: BaseRef) => { const t = target(x); return t ? `${t.table}.${t.column}` : isKey(x) ? fq(x) : null; };
    const da = domain(a), db = domain(b);
    return da !== null && da === db;
  }

  // ------------------------------------------------------------------ statements

  private select(n: Node, parent: Scope | null, depth: number, top: boolean): ColInfo[] {
    if (depth > LIMITS.depth) throw new Reject('too_complex', 'The query is nested too deeply.');
    if (!top && ++this.subqueries > LIMITS.subqueries) throw new Reject('too_complex', `At most ${LIMITS.subqueries} subqueries are supported.`);
    const s = n.SelectStmt as Node | undefined;
    if (!s) throw new Reject('not_select', 'Only SELECT queries are supported.');
    if (s.op && s.op !== 'SETOP_NONE') throw new Reject('unsupported', 'UNION, INTERSECT and EXCEPT are not supported; run the parts separately.');
    if (s.intoClause) throw new Reject('not_read_only', 'SELECT INTO creates a table and is not allowed.');
    if (s.lockingClause) throw new Reject('not_read_only', 'Row locking (FOR UPDATE / FOR SHARE) is not allowed.');
    if (s.valuesLists) throw new Reject('unsupported', 'VALUES lists are not supported.');
    if (s.windowClause) throw new Reject('unsupported', 'Window functions are not supported.');
    if (s.groupDistinct) throw new Reject('unsupported', 'GROUP BY DISTINCT is not supported.');
    if (s.limitOption === 'LIMIT_OPTION_WITH_TIES') throw new Reject('unsupported', 'FETCH ... WITH TIES is not supported.');
    const distinct = Array.isArray(s.distinctClause);
    if (distinct && s.distinctClause.some((d: Node) => d && Object.keys(d).length)) throw new Reject('unsupported', 'DISTINCT ON is not supported.');

    const ctes = new Map<string, ColInfo[]>();
    const scope = new Scope(parent, ctes);
    if (s.withClause) {
      if (s.withClause.recursive) throw new Reject('unsupported', 'Recursive CTEs are not supported.');
      for (const c of s.withClause.ctes ?? []) {
        const cte = c.CommonTableExpr;
        if (!cte) throw new Reject('unsupported', 'Unsupported WITH clause.');
        if (cte.aliascolnames) throw new Reject('unsupported', 'Column lists on CTE names are not supported; alias the columns inside the CTE.');
        if (cte.search_clause || cte.cycle_clause) throw new Reject('unsupported', 'SEARCH / CYCLE clauses are not supported.');
        if (!cte.ctequery?.SelectStmt) throw new Reject('not_read_only', `WITH ${cte.ctename} must be a SELECT; data-modifying statements are not allowed.`);
        const outs = this.select(cte.ctequery, scope, depth + 1, false);
        ctes.set(cte.ctename, outs);
      }
    }

    const from = s.fromClause ?? [];
    if (from.length > LIMITS.fromItems) throw new Reject('too_complex', `At most ${LIMITS.fromItems} FROM items are supported.`);
    for (const f of from) this.fromItem(f, scope, depth);

    // Select list (with * expanded to the columns the role may see).
    const targets: Node[] = [];
    for (const t of s.targetList ?? []) {
      const rt = t.ResTarget;
      if (!rt) throw new Reject('unsupported', 'Unsupported select-list item.');
      const fields = rt.val?.ColumnRef?.fields as Node[] | undefined;
      if (fields && kind(fields[fields.length - 1]) === 'A_Star') targets.push(...this.expandStar(fields, scope));
      else targets.push(t);
    }
    if (!targets.length) throw new Reject('unsupported', 'The query must return at least one column.');
    s.targetList = targets;
    const outputs: ColInfo[] = [];
    for (const t of targets) {
      const rt = t.ResTarget;
      const info = this.expr(rt.val, scope, { clause: 'select', depth: depth + 1, aggOk: true });
      // Restricted columns may pass through a select list only unchanged (rewritten or rejected at the top level).
      if (restricted(info).length && !info.bare) this.deny(info, 'a calculated result column');
      const name = rt.name ?? (rt.val?.ColumnRef ? str(rt.val.ColumnRef.fields.at(-1)) : rt.val?.FuncCall ? str(rt.val.FuncCall.funcname.at(-1)) : '?column?') ?? '?column?';
      outputs.push({ name, lineage: info.lineage, bare: info.bare, usable: true });
    }
    if (distinct) for (const o of outputs) this.deny(o, 'SELECT DISTINCT');

    if (s.whereClause) { const w = this.expr(s.whereClause, scope, { clause: 'filter', depth: depth + 1, aggOk: false }); this.deny(w, 'a condition'); }
    for (const g of s.groupClause ?? []) {
      if (g.GroupingSet) throw new Reject('unsupported', 'GROUPING SETS / ROLLUP / CUBE are not supported.');
      const o = this.outputRef(g, outputs);
      const info = o ?? this.expr(g, scope, { clause: 'group', depth: depth + 1, aggOk: false });
      this.deny(info, 'GROUP BY');
      for (const b of info.lineage) this.use(b, 'group');
    }
    if (s.havingClause) { const h = this.expr(s.havingClause, scope, { clause: 'filter', depth: depth + 1, aggOk: true }); this.deny(h, 'HAVING'); }
    for (const so of s.sortClause ?? []) {
      const sb = so.SortBy;
      if (!sb) throw new Reject('unsupported', 'Unsupported ORDER BY item.');
      if (sb.useOp) throw new Reject('unsupported', 'ORDER BY ... USING is not supported.');
      const info = this.outputRef(sb.node, outputs) ?? this.expr(sb.node, scope, { clause: 'order', depth: depth + 1, aggOk: true });
      this.deny(info, 'ORDER BY');
      for (const b of info.lineage) this.use(b, 'order');
    }
    for (const k of ['limitCount', 'limitOffset'] as const) {
      const v = s[k];
      if (v === undefined) continue;
      if (v.A_Const?.isnull && k === 'limitCount') { delete s.limitCount; continue; } // LIMIT ALL
      if (!(v.A_Const && Number.isInteger(v.A_Const.ival?.ival ?? 0) && !v.A_Const.sval && !v.A_Const.fval && !v.A_Const.boolval)) {
        throw new Reject('unsupported', `${k === 'limitCount' ? 'LIMIT' : 'OFFSET'} must be a non-negative integer constant.`);
      }
    }

    if (top) {
      for (const [i, o] of outputs.entries()) {
        const r = restricted(o);
        if (!r.length) continue;
        const b = o.bare!;
        if (b.col.level !== 'masked') throw new Reject('restricted_field', `Field ${fq(b)} cannot be returned: ${LEVEL_TEXT[b.col.level] ?? 'it is not available to your role'}.`);
        // Return the redacted form, computed by the database.
        const rt = targets[i].ResTarget;
        rt.name = o.name;
        rt.val = { FuncCall: { funcname: [{ String: { sval: 'core' } }, { String: { sval: 'mask_value' } }],
          args: [{ TypeCast: { arg: rt.val, typeName: { names: [{ String: { sval: 'text' } }], typemod: -1 } } }, { A_Const: { sval: { sval: b.col.redaction } } }],
          funcformat: 'COERCE_EXPLICIT_CALL' } };
      }
      this.describe(s, outputs);
    }
    return outputs;
  }

  private describe(s: Node, outputs: ColInfo[]) {
    const t = [...this.tables];
    this.summary.push(`Reads ${t.length ? t.join(', ') : 'no tables'} (current record versions; your tenant only).`);
    for (const j of this.joins) this.summary.push(`${j.type} join of ${j.tables.join(' and ')}.`);
    if (s.whereClause) this.summary.push('Keeps only rows matching the WHERE conditions.');
    if (s.groupClause?.length) this.summary.push(`Groups rows (${s.groupClause.length} grouping expression${s.groupClause.length > 1 ? 's' : ''}) and aggregates each group.`);
    if (s.havingClause) this.summary.push('Keeps only groups matching the HAVING condition.');
    if (s.sortClause?.length) this.summary.push('Sorts the result.');
    const masked = outputs.filter((o) => restricted(o).length);
    this.summary.push(`Returns ${outputs.length} column${outputs.length > 1 ? 's' : ''}: ${outputs.map((o) => o.name).join(', ')}.`);
    if (masked.length) this.summary.push(`Redacted for your role: ${masked.map((o) => `${o.name} (${o.bare!.col.redaction})`).join(', ')}.`);
  }

  /** ORDER BY / GROUP BY may name an output column by position or alias. */
  private outputRef(n: Node, outputs: ColInfo[]): ColInfo | null {
    if (n.A_Const && n.A_Const.ival !== undefined) {
      const i = n.A_Const.ival.ival ?? 0;
      if (i < 1 || i > outputs.length) throw new Reject('invalid_reference', `Position ${i} is not in the select list.`);
      return outputs[i - 1];
    }
    if (n.A_Const) return { name: '', lineage: [], bare: null, usable: true };
    const f = n.ColumnRef?.fields as Node[] | undefined;
    if (f?.length === 1) { const o = outputs.find((x) => x.name === str(f[0])); if (o) return o; }
    return null;
  }

  private expandStar(fields: Node[], scope: Scope): Node[] {
    const rels = fields.length === 1 ? scope.rels : scope.rels.filter((r) => r.alias === str(fields[0]));
    if (fields.length > 2 || (fields.length === 2 && !rels.length)) throw new Reject('unknown_table', `Table reference "${str(fields[0])}" is not available.`);
    const out: Node[] = [];
    for (const r of rels) {
      for (const c of r.columns.values()) {
        if (!c.usable) continue;
        if (c.lineage.some((b) => b.col.level !== 'full' && b.col.level !== 'masked')) continue;
        out.push({ ResTarget: { val: { ColumnRef: { fields: [{ String: { sval: r.alias } }, { String: { sval: c.name } }] } } } });
      }
    }
    if (!out.length) throw new Reject('unsupported', 'SELECT * matched no columns your role may see.');
    return out;
  }

  // ------------------------------------------------------------------ FROM

  private fromItem(n: Node, scope: Scope, depth: number): string[] {
    switch (kind(n)) {
      case 'RangeVar': {
        const rv = n.RangeVar;
        const display = [rv.catalogname, rv.schemaname, rv.relname].filter(Boolean).join('.');
        if (rv.schemaname || rv.catalogname) throw new Reject('unknown_table', `Table "${display}" is not available.`);
        if (rv.alias?.colnames) throw new Reject('unsupported', 'Column aliases on tables are not supported.');
        const alias: string = rv.alias?.aliasname ?? rv.relname;
        if (scope.rels.some((r) => r.alias === alias)) throw new Reject('invalid_reference', `Table name "${alias}" is specified more than once.`);
        const cte = scope.cte(rv.relname);
        if (cte) {
          scope.rels.push({ alias, table: null, columns: new Map(cte.map((c) => [c.name, c])) });
          return [rv.relname];
        }
        const t: CatalogTable | undefined = this.cat.tables.get(rv.relname);
        if (!t) throw new Reject('unknown_table', `Table "${display}" is not available.`);
        this.tables.add(t.name);
        const columns = new Map<string, ColInfo>();
        for (const c of t.columns.values()) {
          const b = { table: t.name, col: c };
          columns.set(c.name, { name: c.name, lineage: [b], bare: b, usable: c.level !== 'discover' });
        }
        scope.rels.push({ alias, table: t.name, columns });
        // Rewrite: logical table -> the tenant's query view, keeping the name usable as a qualifier.
        rv.schemaname = this.cat.querySchema;
        rv.alias = { aliasname: alias };
        return [t.name];
      }
      case 'JoinExpr': {
        const j = n.JoinExpr;
        if (j.isNatural) throw new Reject('unsupported', 'NATURAL JOIN is not supported; use JOIN ... ON.');
        if (j.usingClause) throw new Reject('unsupported', 'JOIN ... USING is not supported; use JOIN ... ON.');
        if (j.alias || j.join_using_alias) throw new Reject('unsupported', 'Aliases on joins are not supported.');
        const l = this.fromItem(j.larg, scope, depth), r = this.fromItem(j.rarg, scope, depth);
        const type = ({ JOIN_INNER: j.quals ? 'Inner' : 'Cross', JOIN_LEFT: 'Left', JOIN_RIGHT: 'Right', JOIN_FULL: 'Full' } as Record<string, string>)[j.jointype];
        if (!type) throw new Reject('unsupported', 'Unsupported join type.');
        this.joins.push({ type, tables: [...l, ...r] });
        if (j.quals) { const q = this.expr(j.quals, scope, { clause: 'join', depth: depth + 1, aggOk: false }); this.deny(q, 'a join condition'); }
        return [...l, ...r];
      }
      case 'RangeSubselect': {
        const rs = n.RangeSubselect;
        if (rs.lateral) throw new Reject('unsupported', 'LATERAL subqueries are not supported.');
        if (!rs.alias?.aliasname) throw new Reject('invalid_reference', 'A subquery in FROM needs an alias.');
        if (rs.alias.colnames) throw new Reject('unsupported', 'Column aliases on subqueries are not supported.');
        const outs = this.select(rs.subquery, new Scope(scope.parent, scope.ctes), depth + 1, false); // CTEs visible, sibling FROM items not
        if (scope.rels.some((r) => r.alias === rs.alias.aliasname)) throw new Reject('invalid_reference', `Table name "${rs.alias.aliasname}" is specified more than once.`);
        scope.rels.push({ alias: rs.alias.aliasname, table: null, columns: new Map(outs.map((c) => [c.name, c])) });
        return [rs.alias.aliasname];
      }
      default:
        throw new Reject('unsupported', `${kind(n)} is not supported in FROM; only tables, joins and subqueries are.`);
    }
  }

  // ------------------------------------------------------------------ expressions

  private column(fields: Node[], scope: Scope): ColInfo {
    if (fields.some((f) => !f.String)) throw new Reject('unsupported', '* is only supported as SELECT * or count(*).');
    const names = fields.map((f) => str(f)!);
    const display = names.join('.');
    if (names.length === 1) {
      for (let s: Scope | null = scope; s; s = s.parent) {
        const hits = s.rels.filter((r) => r.columns.has(names[0]));
        if (hits.length > 1) throw new Reject('ambiguous_column', `Column "${display}" is ambiguous; qualify it with a table alias.`);
        if (hits.length === 1) return this.checked(hits[0].columns.get(names[0])!, display);
      }
      throw new Reject('unknown_column', `Column "${display}" is not available.`);
    }
    if (names.length === 2) {
      for (let s: Scope | null = scope; s; s = s.parent) {
        const rel = s.rels.find((r) => r.alias === names[0]);
        if (!rel) continue;
        const c = rel.columns.get(names[1]);
        if (!c) throw new Reject('unknown_column', `Column "${display}" is not available.`);
        return this.checked(c, display);
      }
      throw new Reject('unknown_table', `Table reference "${names[0]}" is not available.`);
    }
    throw new Reject('unknown_column', `Column "${display}" is not available.`);
  }

  private checked(c: ColInfo, display: string): ColInfo {
    if (!c.usable) throw new Reject('restricted_field', `Field ${display} cannot be used: ${LEVEL_TEXT.discover}.`);
    return c;
  }

  private expr(n: Node, scope: Scope, ctx: { clause: string; depth: number; aggOk: boolean; inAgg?: boolean }): Info {
    if (ctx.depth > LIMITS.depth) throw new Reject('too_complex', 'The expression is nested too deeply.');
    const sub = (x: Node, c = ctx) => this.expr(x, scope, { ...c, depth: ctx.depth + 1 });
    const merge = (infos: Info[]): Info => ({ lineage: infos.flatMap((i) => i.lineage), bare: null, agg: infos.some((i) => i.agg) });
    const full = (infos: Info[], where: string) => { for (const i of infos) this.deny(i, where); return merge(infos); };
    const k = kind(n);
    const v = n[k];
    switch (k) {
      case 'ColumnRef': {
        const c = this.column(v.fields, scope);
        for (const b of c.lineage) this.use(b, ctx.inAgg ? 'aggregate' : ctx.clause);
        return { lineage: c.lineage, bare: c.bare, agg: false };
      }
      case 'A_Const':
        return { lineage: [], bare: null, agg: false };
      case 'TypeCast': {
        const names = (v.typeName?.names ?? []).map((x: Node) => str(x));
        const tn = names.at(-1);
        if (v.typeName?.arrayBounds || v.typeName?.setof || (names.length === 2 && names[0] !== 'pg_catalog') || names.length > 2 || !CAST_TYPES.has(tn)) {
          throw new Reject('unsupported', `Casting to ${names.join('.') || 'that type'} is not supported.`);
        }
        return full([sub(v.arg)], 'a type cast');
      }
      case 'A_Expr': {
        const op = (v.name ?? []).map((x: Node) => str(x));
        if (op.length !== 1) throw new Reject('unsupported', 'Schema-qualified operators are not supported.');
        switch (v.kind) {
          case 'AEXPR_OP': {
            if (!OPERATORS.has(op[0])) throw new Reject('unsupported', `Operator ${op[0]} is not supported.`);
            const l = v.lexpr ? sub(v.lexpr) : null, r = sub(v.rexpr);
            if (op[0] === '=' && l && (restricted(l).length || restricted(r).length)) {
              // Restricted keys may be compared only with their related key column (a relationship join).
              if (l.bare && r.bare && v.lexpr.ColumnRef && v.rexpr.ColumnRef && this.related(l.bare, r.bare)) {
                for (const b of [l.bare, r.bare]) this.use(b, 'join');
                return { lineage: [], bare: null, agg: false };
              }
            }
            return full(l ? [l, r] : [r], `an expression with ${op[0]}`);
          }
          case 'AEXPR_IN': {
            const items = (v.rexpr?.List?.items ?? []) as Node[];
            if (!items.length) throw new Reject('unsupported', 'IN needs a list of values.');
            return full([sub(v.lexpr), ...items.map((x) => sub(x))], 'an IN list');
          }
          case 'AEXPR_LIKE': case 'AEXPR_ILIKE':
            if (!['~~', '!~~', '~~*', '!~~*'].includes(op[0])) throw new Reject('unsupported', 'Unsupported pattern operator.');
            return full([sub(v.lexpr), sub(v.rexpr)], 'a LIKE pattern');
          case 'AEXPR_BETWEEN': case 'AEXPR_NOT_BETWEEN':
            return full([sub(v.lexpr), ...(v.rexpr.List.items as Node[]).map((x) => sub(x))], 'BETWEEN');
          case 'AEXPR_DISTINCT': case 'AEXPR_NOT_DISTINCT': case 'AEXPR_NULLIF':
            return full([sub(v.lexpr), sub(v.rexpr)], 'a comparison');
          default:
            throw new Reject('unsupported', 'That kind of expression (for example = ANY(array), SIMILAR TO or regular expressions) is not supported.');
        }
      }
      case 'BoolExpr':
        return full((v.args as Node[]).map((x) => sub(x)), 'a boolean expression');
      case 'NullTest': {
        const a = sub(v.arg);
        if (restricted(a).length && !a.bare) this.deny(a, 'IS NULL on a calculated value');
        return { lineage: restricted(a).length ? [] : a.lineage, bare: null, agg: a.agg };
      }
      case 'BooleanTest':
        return full([sub(v.arg)], 'IS TRUE / IS FALSE');
      case 'CaseExpr': {
        const parts: Info[] = [];
        if (v.arg) parts.push(sub(v.arg));
        for (const w of v.args ?? []) { parts.push(sub(w.CaseWhen.expr), sub(w.CaseWhen.result)); }
        if (v.defresult) parts.push(sub(v.defresult));
        return full(parts, 'a CASE expression');
      }
      case 'CoalesceExpr':
        return full((v.args as Node[]).map((x) => sub(x)), 'COALESCE');
      case 'MinMaxExpr':
        return full((v.args as Node[]).map((x) => sub(x)), 'GREATEST / LEAST');
      case 'SQLValueFunction':
        if (!TIME_VALUE_FUNCTIONS.has(v.op)) throw new Reject('unsupported', 'Only date and time value functions (CURRENT_DATE, CURRENT_TIMESTAMP, ...) are supported.');
        return { lineage: [], bare: null, agg: false };
      case 'FuncCall': {
        const names = (v.funcname as Node[]).map((x) => str(x));
        if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) throw new Reject('unknown_function', `Function ${names.join('.')} is not available.`);
        const fn = names.at(-1)!.toLowerCase();
        if (v.over) throw new Reject('unsupported', 'Window functions (OVER) are not supported.');
        if (v.agg_order || v.agg_within_group || v.func_variadic) throw new Reject('unsupported', `That form of ${fn}() is not supported.`);
        const args = (v.args ?? []) as Node[];
        if (AGGREGATES.has(fn)) {
          if (!ctx.aggOk) throw new Reject('invalid_aggregate', `Aggregate ${fn}() is not allowed in ${ctx.clause === 'filter' ? 'WHERE' : ctx.clause === 'group' ? 'GROUP BY' : 'a join condition'}.`);
          if (ctx.inAgg) throw new Reject('invalid_aggregate', 'Aggregates cannot be nested.');
          if (v.agg_star && fn !== 'count') throw new Reject('unsupported', `${fn}(*) is not valid.`);
          if (!v.agg_star && args.length !== 1) throw new Reject('unsupported', `${fn}() takes exactly one argument.`);
          const parts = args.map((a) => sub(a, { ...ctx, inAgg: true }));
          if (v.agg_filter) parts.push(this.expr(v.agg_filter, scope, { clause: 'filter', depth: ctx.depth + 1, aggOk: false }));
          const r = full(parts, `${fn}()`);
          return { ...r, agg: true };
        }
        const arity = SCALARS[fn];
        if (!arity) throw new Reject('unknown_function', `Function ${fn}() is not available.`);
        if (v.agg_star || v.agg_distinct || v.agg_filter) throw new Reject('unsupported', `${fn}() is not an aggregate.`);
        if (args.length < arity[0] || args.length > arity[1]) throw new Reject('unsupported', `${fn}() takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]}-${arity[1]}`} argument(s).`);
        return full(args.map((a) => sub(a)), `${fn}()`);
      }
      case 'SubLink': {
        const outs = this.select(v.subselect, scope, ctx.depth + 1, false);
        switch (v.subLinkType) {
          case 'EXISTS_SUBLINK':
            return { lineage: [], bare: null, agg: false };
          case 'EXPR_SUBLINK': {
            if (outs.length !== 1) throw new Reject('invalid_reference', 'A scalar subquery must return exactly one column.');
            this.deny(outs[0], 'a scalar subquery result');
            return { lineage: outs[0].lineage, bare: null, agg: false };
          }
          case 'ANY_SUBLINK': {
            const op = (v.operName ?? []).map((x: Node) => str(x));
            if (op.length > 1 || (op.length === 1 && op[0] !== '=')) throw new Reject('unsupported', 'Only IN (subquery) is supported.');
            if (outs.length !== 1) throw new Reject('invalid_reference', 'IN (subquery) must return exactly one column.');
            const t = sub(v.testexpr);
            if (restricted(t).length || restricted(outs[0]).length) {
              if (t.bare && outs[0].bare && v.testexpr.ColumnRef && this.related(t.bare, outs[0].bare)) return { lineage: [], bare: null, agg: false };
              this.deny(restricted(t).length ? t : outs[0], 'IN (subquery)');
            }
            return { lineage: [...t.lineage, ...outs[0].lineage], bare: null, agg: t.agg };
          }
          default:
            throw new Reject('unsupported', 'Only EXISTS, IN and scalar subqueries are supported.');
        }
      }
      default:
        throw new Reject('unsupported', `${k.replace(/_/g, ' ')} is not supported in queries.`);
    }
  }
}

/** Every relation in the executed SQL must be one of the tenant's query views or a CTE of the same statement. */
function postCheck(tree: unknown, schema: string, cteNames: Set<string>) {
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    const o = x as Node;
    if (o.RangeVar && !(o.RangeVar.schemaname === schema || (!o.RangeVar.schemaname && cteNames.has(o.RangeVar.relname)))) throw new Error('post-check: relation outside query schema');
    if (o.CommonTableExpr) cteNames.add(o.CommonTableExpr.ctename);
    if (o.FuncCall) {
      const n = (o.FuncCall.funcname as Node[]).map((f) => str(f));
      if (n.length === 2 && n[0] !== 'pg_catalog' && !(n[0] === 'core' && n[1] === 'mask_value')) throw new Error('post-check: unexpected function');
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(tree);
}

function collectCtes(tree: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(tree)) tree.forEach((t) => collectCtes(t, out));
  else if (tree && typeof tree === 'object') {
    const o = tree as Node;
    if (o.CommonTableExpr) out.add(o.CommonTableExpr.ctename);
    for (const v of Object.values(o)) collectCtes(v, out);
  }
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function validateSql(sql: string, cat: Catalog, opts: ValidateOptions): Promise<ValidationResult> {
  const empty = { tables: [], columns: [], joins: [], output: [], summary: [], validated_sql: null, validated_sql_sha256: null };
  const fail = (code: string, message: string, v?: Validator): ValidationResult => ({ ok: false, issues: [{ code, message }], ...empty, ...(v ? v.report() : {}), output: [], summary: [] });
  if (typeof sql !== 'string' || !sql.trim()) return fail('empty', 'There is no SQL to validate.');
  if (sql.length > (opts.maxLength ?? LIMITS.length)) return fail('too_long', `SQL is limited to ${opts.maxLength ?? LIMITS.length} characters.`);
  let tree: Node;
  try { tree = await parse(sql); } catch (err) { return fail('syntax_error', `SQL syntax error: ${(err as Error).message}`); }
  const stmts = (tree.stmts ?? []) as Node[];
  if (stmts.length !== 1) return fail('multiple_statements', stmts.length ? 'Exactly one statement is allowed; remove the extra statements.' : 'There is no statement.');
  const stmt = stmts[0].stmt as Node;
  if (!stmt.SelectStmt) return fail('not_read_only', `Only read-only SELECT queries are allowed (got ${kind(stmt).replace(/Stmt$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()}).`);

  const v = new Validator(cat);
  let outputs: ColInfo[];
  try { outputs = v.run(stmt).outputs; }
  catch (err) {
    if (err instanceof Reject) return fail(err.code, err.message, v);
    if (err instanceof RangeError) return fail('too_complex', 'The query is too complex to validate.');
    throw err;
  }
  // Row cap: keep a smaller user LIMIT, otherwise cap at the configured maximum.
  const render = async (cap: number) => {
    const copy = structuredClone(tree);
    const s = copy.stmts[0].stmt.SelectStmt;
    const user = s.limitCount?.A_Const?.ival?.ival ?? (s.limitCount ? 0 : undefined);
    if (user === undefined || user > cap) { s.limitCount = { A_Const: { ival: { ival: cap } } }; s.limitOption = 'LIMIT_OPTION_COUNT'; }
    const text = await deparse(copy);
    // Round trip: the text that will run must parse to a tree that stays inside the query schema.
    const again = await parse(text);
    if ((again.stmts ?? []).length !== 1 || !again.stmts[0].stmt.SelectStmt) throw new Error('post-check: deparsed SQL is not a single SELECT');
    postCheck(again, cat.querySchema, collectCtes(again));
    return text;
  };
  const validated = await render(opts.maxRows);
  const report = v.report();
  return {
    ok: true, issues: [], ...report,
    output: outputs.map((o) => ({ name: o.name, table: o.bare?.table ?? null, column: o.bare?.col.name ?? null, masked: restricted(o).length ? o.bare!.col.redaction : null })),
    validated_sql: validated, validated_sql_sha256: sha(validated), withLimit: render,
  };
}
