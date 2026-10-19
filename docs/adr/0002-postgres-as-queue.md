# 0002: PostgreSQL as the durable work queue

**Context.** Batches must survive crashes, be claimed by exactly one worker at a time, be recoverable when a worker dies, and their queue state must never disagree with their processing state.

**Decision.** `core.batches` is the queue. Workers claim with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` and set a lease. The processing transaction holds the batch row lock until commit. Lease recovery uses `SKIP LOCKED`, so it only touches batches whose processing transaction no longer exists.

**Alternatives.** SQS/RabbitMQ (a second source of truth requiring an outbox, dead-letter reconciliation and more infrastructure); Redis streams (weaker durability).

**Consequences.** Queue state and batch state are the same row, so they cannot diverge. Throughput is bounded by the database, which is acceptable at measured volumes (`benchmark.md`). Triggers for a dedicated queue are listed in `scale-out.md`.
