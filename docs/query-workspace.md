# Query workspace and field-level policy

Clearline lets an authenticated user ask for operational data in plain English, inspect the SQL that is proposed, edit it, and run it only by explicit action. Every proposal is validated by the server against what that user's role may discover and use, and every result is returned only in the form the role may see. Fields can be marked sensitive and redacted everywhere they appear.

> Model-generated SQL is an untrusted proposal. It is never an authorization decision and never an executable command by itself.

## Lifecycle

```mermaid
sequenceDiagram
  participant U as User (native client)
  participant A as API (src/query/service.ts)
  participant P as Provider (deterministic | Claude)
  participant V as Validator (libpg-query AST)
  participant D as PostgreSQL (q_<tenant>, query role)
  U->>A: POST /queries/proposals {question}
  A->>A: identity, tenant, role from the token; permitted catalog (metadata only)
  A->>P: scrubbed question + permitted catalog
  P-->>A: SQL + explanation (untrusted)
  A->>V: parse with PostgreSQL's parser, allowlist walk, rewrite, deparse, re-parse
  V-->>A: decision, referenced tables/columns/joins, output columns, validated SQL
  A->>D: EXPLAIN (estimate only; nothing executes)
  A-->>U: proposal: SQL, model explanation, server summary, validation, estimate
  Note over U: Preview / Run is a separate, explicit request
  U->>A: POST /queries/proposals/:id/execute {mode, execution_id}
  A->>V: re-validate the stored SQL under the CURRENT policy
  A->>D: READ ONLY txn, statement_timeout, SET LOCAL ROLE clearline_q_<tenant>_<role>
  D-->>A: rows (masked columns already redacted by core.mask_value)
  A-->>U: rows, columns (+redaction), row count, truncation, duration
```

1. **Request.** `POST /api/v1/tenants/:tenant/queries/proposals` with `{question}` (or `{sql, parent_id?}` for hand-written or edited SQL). Requires `query:propose`. The tenant and role come from the token; nothing in the body can change them.
2. **Permitted catalog.** `src/query/catalog.ts` builds the tables and columns the role may *discover*, with each column's access level, relationships, and metric definitions whose fields are fully visible. This is the only schema the validator resolves names against and the only schema a provider is given.
3. **Generation.** The configured provider (below) receives the question with obvious identifiers scrubbed (`src/quality/sensitive.ts`) and the permitted catalog. No row values are ever sent.
4. **Validation** (`src/query/validate.ts`, below). The SQL is parsed by PostgreSQL's own parser and checked against an allowlist; restricted fields are tracked through every expression.
5. **Estimate.** `EXPLAIN (FORMAT JSON)` of the validated SQL, run under the query role in a read-only transaction. A plan above `QUERY_MAX_COST` is refused. Nothing executes.
6. **Display.** The client shows the proposed SQL, the provider's explanation (labelled unverified), the server's own structural summary (authoritative), referenced tables and columns with the role's access and how each is used, joins, output columns and which are redacted, issues, and the estimate.
7. **Edit.** Edited SQL becomes a new proposal (`source: edited`, `parent_id`) and is validated from scratch. The client refuses to run text that differs from the last validated proposal.
8. **Execute.** `POST …/proposals/:id/execute {mode: preview|run, execution_id?}` (`query:run`). The server re-validates the stored SQL under the *current* policy, checks the plan cost and concurrency limits, then runs the rewritten SQL. `execution_id` lets the client cancel the run (`POST …/executions/:id/cancel`).
9. **Results.** Only permitted columns, redacted where the policy says so — computed in the database, so original values never leave PostgreSQL for those viewers. Rows are returned to the caller and **never stored**.
10. **Evidence.** The proposal (question, proposed SQL, validation, validated SQL and its SHA-256, policy epoch), each execution (executed SQL and SHA-256, status, row count, truncation, duration, which columns were redacted) and every step in the audit trail.

Exports (`POST …/export`, `query:export`) and copied rows go through the same path and contain the same redacted values.

## Provider interface

`src/query/providers/` — a provider implements `generate({question, catalog, dialect, today}) → {sql, explanation, assumptions} | {cannot_answer}`. Selection is explicit configuration; there is no silent fallback.

| `NL_SQL_PROVIDER` | Behaviour |
|---|---|
| `deterministic` (default) | Rule-based intents over the permitted catalog (`deterministic.ts`): totals for a period, period comparisons, references to records that have not arrived, batches with reconciliation failures, threshold listings, "list `<table>` with `<columns>`", counts and listings. No network, no model; the demo and every test use it. |
| `anthropic` | Claude through the official SDK (`anthropic.ts`). `ANTHROPIC_API_KEY` (server-side only), `NL_SQL_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_WORKSPACE_ID` for keys not scoped to a workspace, `NL_SQL_TIMEOUT_MS`. Output is constrained to a JSON schema; refusals become "cannot answer"; server-side refusal fallback is enabled. |
| `none` | Generation disabled; users write SQL. |

An unavailable provider returns `503 provider_unavailable` with `retryable` and a hint; the workspace stays usable for hand-written SQL. The provider's own error text is logged server-side only. Validation, authorization and execution are identical whichever provider (or person) wrote the SQL.

## Authorization model

Two independent dimensions decide what a role receives for a field (`src/policy/fields.ts`):

**Role access** — what the role may do with the field. Set per field, and per table with field `*` (a field gets the lower of the two):

| Level | Catalog | In queries | In results |
|---|---|---|---|
| `hidden` | absent | the name does not resolve; the error is **identical** to a nonexistent column | never |
| `discover` | listed | any use rejected | never |
| `filter` | listed | only `a = b` with its related key (declared relationship), `IS [NOT] NULL`, `x IN (SELECT y …)` between related keys, and unchanged pass-through in subqueries | never |
| `full` | listed | anything | original value |

**Sensitivity** — a sensitive field is returned in its redacted form (*masked*) to every role not listed in its `unmask_roles`. A masked field may be used like a `filter` field and may additionally be *returned as the bare column*; the validator rewrites that output to `core.mask_value(col::text, style)`, so the database returns the redacted text.

Effective access = role access, then sensitivity. **Sensitivity can only lower what a role receives**: marking a field sensitive never grants anything (`test/unit/query-validate.test.ts` "marking a field sensitive never widens access"). Approvers and the platform administrator have no data access whatever the policy says.

Defaults reproduce the platform's existing rule: contract-classified `pii`/`phi` fields are sensitive, fully redacted, and unmasked for roles with `record:read_sensitive` (admins); every other field is `full` for every data role.

### Roles and permissions

| Permission | admin | steward | operator | reporter |
|---|:-:|:-:|:-:|:-:|
| `query:discover` / `query:propose` / `query:run` / `query:history` | ✓ | ✓ | ✓ | ✓ |
| `query:export` | ✓ | ✓ | ✓ | ✓ |
| `query:history_all` (everyone's history, re-validated for the viewer) | ✓ | ✓ | | |
| `policy:read` | ✓ | ✓ | ✓ | |
| `policy:manage` (mark sensitive, choose stricter redaction, remove unmask roles, lower role access) | ✓ | ✓ | | |
| `policy:grant` (anything that widens access) | ✓ | | | |
| `audit:read` | ✓ | ✓ | | |

The **steward** role is new: it classifies data but sees original sensitive values only where a policy lists it in `unmask_roles`. A change is classified by `classifyChange`; if any part widens access (unmarking, a more revealing redaction style, adding an unmask role, raising a role's access) it needs `policy:grant`. A refused change is audited.

### What is permitted for restricted fields — the explicit boundary

Permitted (documented disclosure): presence (`IS NULL`), equality with the related key in joins and `IN (subquery)`, and — for masked fields — the redacted form. Everything else is rejected before execution: comparison with literals or other columns, `LIKE`, `BETWEEN`, `IN (list)`, functions, casts, `CASE`, `COALESCE`, arithmetic and concatenation, `ORDER BY` (also by position or alias), `GROUP BY`, `DISTINCT`, every aggregate including `count(DISTINCT …)`, aggregate `FILTER`, `HAVING`, scalar subqueries returning the field, self-joins on a non-key restricted column, and returning a filter-only field through any subquery or CTE. Scenario N exercises 24 such attacks. Small-cell suppression of aggregates over *unrestricted* fields is not implemented (see the threat model).

## SQL validation

The SQL is parsed by `libpg-query` — PostgreSQL's parser compiled to WebAssembly — and the tree is walked against an **allowlist**; any node type, clause, function, operator or cast not explicitly handled is rejected. Regular expressions are not used for security decisions.

| Accepted | Rejected (fail closed) |
|---|---|
| Exactly one `SELECT`; `JOIN … ON` (inner, left, right, full, cross); subqueries in `FROM`, `WHERE` (`EXISTS`, `IN`) and the select list; non-recursive `WITH`; `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`/`OFFSET` constants, `DISTINCT` | multiple statements; `INSERT`/`UPDATE`/`DELETE`/`MERGE`, DDL, `COPY`, `GRANT`, transaction control, `SET`, `DO`, `CALL`, `EXPLAIN`, `VACUUM`, `LISTEN`; data-modifying CTEs; `SELECT INTO`; `FOR UPDATE/SHARE`; `UNION`/`INTERSECT`/`EXCEPT`; window functions; `LATERAL`; `NATURAL`/`USING`; recursive CTEs; `DISTINCT ON`; `ROLLUP`/`CUBE`/grouping sets; `VALUES`; table functions (`generate_series`), `TABLESAMPLE`; arrays, rows, `ANY(array)`, `SIMILAR TO`, regular-expression operators, `COLLATE`; parameters |
| Functions: `count sum avg min max round abs ceil floor lower upper length btrim date_trunc date_part extract to_char now age make_date`; `CASE`, `COALESCE`, `NULLIF`, `GREATEST`/`LEAST`; `CURRENT_DATE`/`CURRENT_TIMESTAMP`… | every other function, including `pg_read_file`, `pg_sleep`, `set_config`, `current_setting`, `dblink`, `lo_import`, `query_to_xml`, `version()`, schema-qualified calls; `CURRENT_USER`/`SESSION_USER` |
| Casts to `int`, `bigint`, `numeric`, `float`, `text`, `varchar`, `boolean`, `date`, `timestamp(tz)`, `interval` | casts to any other type (`regclass`, …), arrays |
| Unqualified logical table names from the catalog; CTE names | any schema- or catalog-qualified name (`pg_catalog.*`, `information_schema.*`, `core.*`, `t_*`, `q_*`, `reporting.*`, `public.*`), unknown names — all with the same "is not available" message |

Limits: 20,000 characters, nesting depth 60, 16 subqueries, 12 `FROM` items. Ambiguous unqualified columns are rejected.

**Rewrite.** Logical tables become `q_<tenant>.<table>` (keeping their names as qualifiers), masked outputs become `core.mask_value(…)`, and the row cap is applied (`LIMIT min(user limit, cap)`; a preview uses `QUERY_PREVIEW_ROWS + 1`, a run `QUERY_MAX_ROWS + 1` to detect truncation). The tree is deparsed, **parsed again**, and re-checked: exactly one `SELECT`, every relation inside `q_<tenant>` or a CTE of the statement, no schema-qualified function but `core.mask_value`. The executed text is recorded exactly.

## Execution and database enforcement

`src/query/surface.ts` maintains, per tenant, in the same transaction as every contract or policy change:

- schema **`q_<tenant>`** — one view per contract entity (current versions + `_batch_id`, `_trust_status`, `_loaded_at`) and per platform table (`batches`, `reconciliation_results`, `quality_results`, `quarantine` without keys or values), each pinned to the tenant;
- roles **`clearline_q_<tenant>_<role>`** (NOLOGIN), mapped to the tenant in `core.reporting_roles`, so the existing row-level-security predicate resolves them to that tenant and nothing else, whatever `app.tenant_id` says;
- **column grants** that mirror the policy: `SELECT` only on columns the role may at least filter by — hidden and discover-only columns are not granted at all.

Queries run on a separate connection pool as the login **`clearline_query`**, which owns no privileges and may only `SET ROLE` to query roles (`withQueryRole`, `src/platform/db.ts`): `BEGIN READ ONLY`, `statement_timeout = QUERY_TIMEOUT_MS`, `search_path = pg_catalog`, `SET LOCAL ROLE`, and a check that `current_user`, `session_user` and `transaction_read_only` are as expected (fail closed). All settings are transaction-local, so pooled connections return unchanged. Even `RESET ROLE` would leave a session that can read nothing (Scenario N2 tests this with the validator bypassed).

| Limit | Setting | Default |
|---|---|---|
| Statement timeout | `QUERY_TIMEOUT_MS` | 10,000 ms |
| Rows per run / preview | `QUERY_MAX_ROWS` / `QUERY_PREVIEW_ROWS` | 5,000 / 20 |
| Serialized result size | `QUERY_MAX_RESULT_BYTES` | 8 MiB (whole rows; `truncated: true`) |
| Planner cost | `QUERY_MAX_COST` | 5,000,000 |
| Concurrent executions | `QUERY_MAX_CONCURRENT_PER_TENANT` / `QUERY_MAX_CONCURRENT` | 2 / 4 per API process (`429`) |
| Cancellation | `POST …/executions/:id/cancel` (owner or `query:history_all`) | `pg_cancel_backend` on the query login |

Database errors are classified: data errors (class 22) pass their message (they can only concern values the role may see), invalid queries (42) pass a message about the user's own SQL, privilege errors become "not available to your role" and are logged as a defence-in-depth trip, timeouts and cancellations are reported as such, anything else is generic with an execution id.

## Sensitivity and redaction

Field policies are managed in the native client (Field policies) or through `GET /fields/policies`, `POST /fields/:entity/:field/policy`, `GET /fields/policies/history`. Each change is versioned in `core.field_policy_versions` (append-only, with before/after and whether it narrowed or widened access), audited as `policy.field.update`, and — in the same transaction — regenerates the query views and grants and the BI reporting views (which drop sensitive and reporter-restricted fields).

| Redaction | Result | Valid for |
|---|---|---|
| `full` | `[redacted]` (`REDACTED` in CSV extracts) | every type |
| `last4` | `***-**-6789`, `******7890` | strings |
| `first_initial` | `A***` | strings, enums |
| `year_only` | `1980-**-**` | dates, timestamps |

The same masking function exists in SQL (`core.mask_value`, used for query results) and TypeScript (`src/policy/mask.ts`, used for the other surfaces); Scenario M checks they agree. One resolver (`FieldViewer`) applies the policy on every read surface: query results and previews, query exports, records, lineage (canonical values *and* raw source columns), exception report (keys, missing references, finding messages), batch findings (offending values stripped from messages), CSV extracts and their schemas, contract document and metric definitions (hidden fields removed), business metrics (withheld when computed over a field the role may not see in full), BI views. Fields a role may not see are omitted, not blanked.

**Policy changes and cached results.** Result rows are never persisted. Query history keeps SQL and metadata only, is re-validated for the viewer on every read, withholds other users' SQL that the viewer may not use, and flags entries run under an older policy epoch. The native client clears displayed results when it changes a policy and re-reads the catalog when a response reports a newer epoch.

## Audit events

| Action | Outcome | Details (never values) |
|---|---|---|
| `query.request` | succeeded | SHA-256 and length of the question, identifier kinds scrubbed, provider, model |
| `query.proposal.generated` | succeeded / failed | provider, model, SHA-256 of proposed SQL, cannot-answer or provider-unavailable |
| `query.validation` | succeeded / failed / denied | source, parent, issue codes, tables, columns, masked outputs, validated SQL SHA-256, estimate, policy epoch, stage (propose or execute) |
| `authz.query:*` / `authz.policy:*` | denied | from the route layer |
| `query.execution.requested` | allowed | mode, policy epoch |
| `query.execution` | succeeded / failed | execution id, status (incl. `timed_out`, `cancelled`), error code, rows, truncated, duration, proposed and executed SQL SHA-256, columns, redaction applied, policy epoch |
| `query.execution.cancel` | succeeded | |
| `policy.field.update` | succeeded / denied | version, policy epoch, change kind, loosening/tightening parts, before/after policy |

## Configuration summary

`NL_SQL_PROVIDER`, `NL_SQL_MODEL`, `NL_SQL_TIMEOUT_MS`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `QUERY_TIMEOUT_MS`, `QUERY_MAX_ROWS`, `QUERY_PREVIEW_ROWS`, `QUERY_MAX_RESULT_BYTES`, `QUERY_MAX_COST`, `QUERY_MAX_CONCURRENT_PER_TENANT`, `QUERY_MAX_CONCURRENT`, and the query login: `QUERY_DATABASE_URL` (production: a login you create, see [deployment.md](deployment.md)) or `QUERY_DB_PASSWORD` (the application then provisions `clearline_query`).
