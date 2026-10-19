# 0009: TypeScript for processing too (no Python service)

**Context.** The suggested stack allowed Python for transformation and validation "where useful".

**Decision.** Keep processing in TypeScript, in the same process model as the API.

**Reasons.** A second runtime would mean either duplicating validation and coercion logic (forbidden: business logic must not be duplicated) or adding an RPC boundary inside the monolith. The workload is I/O- and database-bound rather than numerically heavy (measured about 8k rows/s per worker, with database writes dominating), and exact decimal arithmetic is handled with BigInt-scaled strings plus PostgreSQL `numeric`.

**Revisit when** a workload genuinely needs the Python data ecosystem (e.g. statistical profiling, ML-based anomaly detection on loaded data). It would then run downstream of trusted outputs, not inside the contract engine.
