# Architecture decision records

| # | Decision | Status |
|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith on one PostgreSQL | Accepted |
| [0002](0002-postgres-as-queue.md) | PostgreSQL as the durable work queue | Accepted |
| [0003](0003-one-transaction-per-batch.md) | One database transaction per batch attempt; at-least-once with idempotent effects | Accepted |
| [0004](0004-contracts-generate-storage.md) | Contracts generate typed per-tenant tables, not a generic key-value store | Accepted |
| [0005](0005-declarative-transforms-only.md) | Declarative, whitelisted transforms; no tenant code | Accepted |
| [0006](0006-pipeline-status-vs-trust-status.md) | Separate pipeline status from trust status | Accepted |
| [0007](0007-versioned-records.md) | Versioned canonical records; corrections and migrations never update in place | Accepted |
| [0008](0008-defence-in-depth-isolation.md) | Tenant isolation in the application *and* the database | Accepted, with known gap |
| [0009](0009-typescript-only.md) | TypeScript for processing too (no Python service) | Accepted |
| [0010](0010-separation-of-duties.md) | Separation of duties: approver role, bootstrap-only platform admin | Accepted (after independent review) |
| [0011](0011-governed-natural-language-sql.md) | Natural-language SQL as an untrusted proposal behind a structural validator and a database boundary | Accepted |
| [0012](0012-field-policy-model.md) | Field access and sensitivity are separate policy dimensions, enforced by one server-side resolver | Accepted |
| [0013](0013-native-client.md) | A native Rust/GPUI client replaces the React dashboard | Accepted |
| [0014](0014-saved-analytics-authority.md) | Saving, scheduling and delivering a query grants nothing | Accepted |
| [0015](0015-durable-scheduler.md) | Durable scheduling in PostgreSQL, executed by the worker | Accepted |
| [0016](0016-deterministic-analysis.md) | Deterministic, explainable analysis first; models may only narrate | Accepted |
