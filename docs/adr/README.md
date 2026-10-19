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
