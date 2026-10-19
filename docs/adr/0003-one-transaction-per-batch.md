# 0003: One transaction per batch attempt; at-least-once with idempotent effects

**Context.** Partially processed batches must never look complete; retries must not duplicate business effects; the specification forbids claiming exactly-once.

**Decision.** Transformation, canonical writes, quarantine, quality results, lineage links, reconciliation and the final status are committed in a single transaction per attempt. A crash, timeout or shutdown rolls everything back. Intake idempotency is keyed on (tenant, source, SHA-256 of payload); record idempotency on (key, canonical hash).

**Consequences.** "Completed" always means "everything committed". Retries are safe by construction (Scenarios C, F). The cost is long transactions for very large batches (WAL bursts, held locks), mitigated by `MAX_ROWS_PER_BATCH` and a planned sub-batching design.
