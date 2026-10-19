# 0001: Modular monolith on one PostgreSQL

**Context.** The platform must ingest, transform, reconcile and serve data with strong consistency between those steps, be runnable on a laptop, and be operable by a small team. The specification forbids distributed infrastructure without a demonstrated need.

**Decision.** One TypeScript codebase with enforced module boundaries (`docs/architecture.md`), two process types (API, worker) from one image, one PostgreSQL database for queue, storage, lineage, audit and reporting.

**Consequences.** Cross-step invariants (reconciliation decides trust; quarantine and canonical writes agree) are enforced by ordinary transactions instead of distributed coordination. One system to back up, secure and monitor. Scaling is vertical plus more workers until the triggers in `scale-out.md` are met. Module boundaries are a code-review discipline, not a network boundary, so a careless import could couple them; the dependency table in the architecture doc is the reference.
