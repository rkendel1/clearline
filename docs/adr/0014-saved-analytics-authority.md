# 0014: Saving, scheduling and delivering a query grants nothing

**Context.** Saved queries outlive the moment they were validated. Policies change, tokens are revoked, people change roles, and a schedule keeps running when its author is not there. A saved query that carried the permissions it was saved with would become a standing grant: a way to keep reading a field after it was restricted.

**Decision.** A saved query, a schedule and a destination are configuration, never authority. Every run executes through the same path as the query workspace (`runSql`): the stored SQL is re-validated under the **current** field policy for the run's role, costed, and executed by the privilege-less query login under `SET LOCAL ROLE`. Each schedule has an explicit execution identity — an active token and a role that the creator's role may delegate (never higher than the creator's own) — which is re-checked before every run. Before anything derived from data is delivered, the delivery is re-authorized again: identity, re-validation, and the redaction of every output column compared with the snapshot. Viewing a run re-masks its stored result for the viewer's current role.

**Reasons.** One authority (the validator and the field-policy resolver) means one place to reason about access, and a policy change takes effect on the next run without migrating saved assets. An explicit, delegable identity makes it visible who a schedule acts for, and prevents an administrator's click from silently elevating a reporter's schedule.

**Costs.** A saved query can stop working when policy tightens (the run fails as `authorization` or `validation`, and the schedule asks for attention) — intended, but it means alerts on schedules that need attention. Results already computed are not delivered when access changed between the query and the delivery, so a delivery can be blocked for a run that succeeded. Editing a schedule re-binds it to the editor's identity.

**Revisit when** service identities that are not tied to a person's token are needed (for example a dedicated "reporting robot" with its own lifecycle and approvals).
