# 0006: Separate pipeline status from trust status

**Context.** A pipeline can run perfectly and still produce data that must not be relied on (control totals disagree, too many rejects, data later changed out of band). A single "success" status conflates these.

**Decision.** Every batch has a pipeline status (did it run and commit?) and a trust status (did it reconcile and stay under its reject threshold, and does it still match?). Trusted metrics and default extracts include only trusted batches; reports also show the value including untrusted data and how many records were held back. Re-verification can revoke trust (drift) and restore it only when drift was the sole reason.

**Consequences.** A failed reconciliation can never produce a green number (Scenarios I, J). Consumers must understand two statuses; the dashboard shows them side by side on every batch.
