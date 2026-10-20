
### Scenario A — Normal ingestion
_2026-10-20T02:25:08.116Z_

- Submitted 3 plans, 200 members, 1000 claims (CSV, control totals record_count=1000, paid=498911.75, billed=1305555.94).
- Claims batch 12640d1c-1455-4622-946e-d74e7a4b3e85: status=completed, trust=trusted, quality=passed, reconciliation=passed; 9 reconciliation checks all passed.
- Business metric total_paid=498911.75 (generator truth 498911.75), claims_total=1000.
- Extract claims: 1000 rows, sha256 f69b66dcd2943dcd…, diagnosis_code redacted; billed sum matches truth.
- Lineage for C000000005: source row 5 -> record 5 -> metric total_paid (included) -> export 7cd264af-994e-42cd-bdb4-921e1e7d5115.

### Scenario B — Tenant customization
_2026-10-20T02:25:16.595Z_

- northwind tables: claim(claim_id,member_id,provider_npi,service_date,received_date,diagnosis_code,procedure_code,billed_amount,allowed_amount,paid_amount,status,adjudication_seq); member(member_id,ssn,first_name,last_name,date_of_birth,gender,zip,plan_code,coverage_start,coverage_end,status,updated_at); pharmacy_fill(fill_id,member_id,ndc,fill_date,days_supply,quantity,ingredient_cost,dispensing_fee,plan_paid,member_paid,status,pharmacy_npi,updated_at); plan(plan_code,plan_name,plan_type,deductible,oop_max,effective_date,termination_date,updated_at)
- bluefin tables: benefit_plan(plan_id,plan_label,tier_count,effective_on,revision); enrollee(enrollee_id,subscriber_id,dependent_seq,relationship,full_name,birth_date,email,plan_id,coverage_tier,effective_on,terminated_on,record_version); rx_claim(claim_number,enrollee_id,ndc,fill_date,days_supply,ingredient_cost,dispense_fee,total_cost,copay,plan_cost,claim_state,adjudicated_at,pharmacy_id)
- bluefin implied-cents/YYYYMMDD/concatenated-key semantics verified on BX00000001.
- Third tenant "coral" created via POST /tenants, token issued, contract published (with an extra 30-day rule) and data processed at runtime: 37 of 150 claims quarantined by the tenant-only rule (expected 37).
- grep of src/ for tenant names: 0 files.

### Scenario C — Duplicate delivery
_2026-10-20T02:25:19.918Z_

- Resubmitting identical bytes returned HTTP 200 with duplicate=true and the original batch id 98946011-10d5-4490-94d0-fc8e0e91cb09; recorded as a 'duplicate' submission.
- 5 concurrent identical submissions produced exactly 1 batch (f432691f-dd61-4dd7-b00a-ec00555a3459).
- Redelivery file (100 already-loaded + 10 new rows): accepted=10, duplicate=100, quarantined=0, still trusted; each duplicate row links to the version it duplicated.
- claim rows: 400 -> 460 (+60 genuinely new); keys with >1 current version: 0; claims_total 400 -> 460.

### Scenario D — Bad data
_2026-10-20T02:25:22.509Z_

- Batch of 202 rows with 9 single-defect rows, 1 SSN in an unmapped column, 1 malformed row, 1 orphaned member reference.
- Result: pipeline=completed_with_exceptions, quality=failed, trust=untrusted (reject rate 5.45% exceeds threshold 5.00%), reconciliation=passed.
- accepted=191, quarantined=11 (structural 6, business/privacy 5), warnings=1.
- Every defect attributed to its exact rule with source row number, e.g. row 191: "service_date: not a valid calendar date (YYYY-MM-DD) (got "2026-02-30")".
- SSN absent from 3 captured log lines and scrubbed from the retained raw payload.
- total_paid trusted=0.00; including untrusted=80605.91 = sum of valid rows only (80605.91).

### Scenario E — Late data and corrections
_2026-10-20T02:25:25.887Z_

- Member NW0000001: v1 ACTIVE (updated 09-10) -> correction TERMINATED (updated 09-20) superseded it; late file (reported 09-15, after the 09-20 file) carried PENDING (updated 09-15) -> stored as history with is_late=true, current unchanged.
- Conflicting version (same updated_at 09-20, different content) quarantined as 'conflict' and listed in the exception report.
- as_of=2026-10-20T02:25:25.389Z extract returns status ACTIVE and 2 members; current extract returns TERMINATED and 3 members.
- Claim C000000001: seq1 paid 100.00 superseded by seq2 paid 80.00; re-sending seq1 counted as duplicate with no effect.

### Scenario F1 — Crash and restart (SIGKILL)
_2026-10-20T02:25:36.028Z_

- Worker process launched with fault injection crash_after_rows=1000 on a 6000-row batch; it wrote canonical rows inside its transaction, then died by SIGKILL.
- After the crash: status=processing (not success), trust=pending, canonical rows for the batch=0, quality/reconciliation rows=0.
- A fresh worker process recovered the expired lease (audited batch.recover), re-processed from scratch and committed: attempts=[1 interrupted, 2 succeeded], accepted=6000, duplicate keys=0, trust=trusted.

### Scenario F2 — Graceful shutdown (SIGTERM)
_2026-10-20T02:25:42.065Z_

- SIGTERM delivered while a 25,000-row batch was processing (grace 0 ms): worker aborted the transaction, re-queued the batch and exited with code 0.
- State after shutdown: status=queued, canonical rows=0, attempts=[1 interrupted]. Next worker completed it: attempt 2, 25000 accepted.

### Scenario G — Privacy violation
_2026-10-20T02:25:44.822Z_

- bluefin reporter/admin tokens against 4 northwind endpoints (report, extract, lineage, submit): all HTTP 403 cross_tenant_denied; platform admin denied tenant data; invalid token 401.
- northwind reporter and operator requesting include_sensitive=true: HTTP 403 sensitive_export_denied, audited as extract.run/denied.
- Default eligibility extract: first_name/last_name/date_of_birth/gender = REDACTED in all 30 rows; no generated name or SSN appears in the payload.
- Audit: denials recorded in the targeted tenant and attempts in the caller tenant; UPDATE/DELETE on audit_events rejected by trigger.
- SQL: BI login in clearline_rpt_bluefin sees only bluefin rows in reporting views (even after setting app.tenant_id=northwind), is denied t_northwind views, base tables and raw records, and reporting views omit pii/phi columns.

### Scenario H — Contract evolution
_2026-10-20T02:25:49.147Z_

- Baseline: 300 claims under 1.0.0 (47 PENDED). v2-unsafe dry-run classification=rejected: 2 reasons incl. "paid_amount: decimal -> integer" and "PENDED removed without a mapping"; publish returned 422 and stored nothing.
- A contract declaring a non-whitelisted transform ({op:"javascript"}) failed schema validation (422 invalid_contract).
- v2 publish returned 202 pending_approval, migration 3: breaking changes [enum_values_remapped:status, field_added_required:line_of_business, field_removed:procedure_code]; 1 DDL statement(s), none destructive; data ops backfill line_of_business=COMMERCIAL and PENDED->PENDING; impact 300 of 300 current rows (distinct). Full plan: test-results/scenario-h-migration-plan.json.
- While pending: 1.0.0 remained active, no column added, a new claims batch processed under 1.0.0, a further publish got 409 migration_pending.
- Approval: operator 403, requesting admin 403 (approval is a separate approver role with no data access, issued only by the platform admin), wrong confirm_version 422. Approver approved -> applied; lifecycles 1.0.0:superseded, 2.0.0:active.
- After apply: 305 current claims all carry line_of_business=COMMERCIAL and 0 PENDED; 305 prior versions retained unchanged under 1.0.0 (lineage for C000000020: 1.0.0:PENDED -> 2.0.0:PENDING). total_paid unchanged (137110.09); re-verification found no drift.
- Separation of duties: the requesting admin's approval attempt got 403 (audited); a tenant admin minting an approver token got 403 approver_issued_by_platform_only; the approver role read no tenant data (403).
- Compatible widening 2.1.0 (paid_amount precision 12->14, days_supply integer->decimal) applied (201) with real ALTER COLUMN TYPE behind regenerated views; a batch queued under 2.0.1 was re-pinned to 2.1.0 (audited batch.repinned).
- Breaking 3.0.0 (new error rule) approved while a batch was queued under 2.1.0: that batch failed ContractSupersededError with no effects; replay re-pinned it to 3.0.0 and it completed, validated by the new rule.
- After the backfill migration, editing a migration-created current row (+500.00 paid) was caught by reverify:migration_sum:paid_amount and the batch became untrusted; reverting the edit restored trust.
- Rollback restored 305 versions and 1.0.0. Roll-forward 2.0.1 approved; 40 v2-shaped claims trusted (medicare_claims=20); v1-shaped file rejected (missing LOB); rollback then refused 409 rollback_window_closed.

### Scenario I — Reconciliation failure
_2026-10-20T02:25:52.446Z_

- In transit: sender declared 250 rows / paid 129308.02; 247 arrived. Batch 51e76792-c132-45bd-bb2f-d1c0beafb04d: pipeline=completed, quality=passed, reconciliation=failed, trust=untrusted.
- Explanation: "Sender declared 250 rows but 247 arrived: 3 row(s) missing in transit or omitted from the file. Request a corrected file from the source." and paid difference -1209.83 (= the 3 lost rows' paid total, from the generator).
- Trusted outputs held it back: claims_total 200 (447 including untrusted, 247 excluded, metric flagged trusted=false); default extract 200 rows, include_untrusted extract 447; operations report succeeded=4 vs untrusted=1.
- Drift: 2 rows deleted and 1 paid_amount edited (+1000.00) directly in SQL. Re-verification: rows -2, paid difference 332.13 (expected 332.13); batch 402550d7-eb14-4713-97ee-fb88034a6f6f became untrusted, batch.drift_detected audited. After restoring the rows from a backup copy, re-verification passed and trust was restored (batch.trust_restored audited); claims_total back to 200, total_paid back to truth. The in-transit batch stayed untrusted.
- Missing references: 12 claims for 5 undelivered members admitted with warnings; dataset check orphans=12 failed with explanation and all 12 listed in the exception report. While it failed, every claim metric reported trusted=false with the failing check named, and the claims extract carried X-Clearline-Dataset-Checks-Failing; member metrics were unaffected. After the late eligibility file the check passed.
- Recovery from the in-transit loss: resending the complete 250-row file produced a trusted batch with 250 accepted and 0 duplicates (versions held only by the untrusted batch are re-established, not treated as duplicates); trusted claims_total became 462 and total_paid equals ground truth.
- A re-adjudication (paid 1.00) arriving in an untrusted batch left trusted total_paid and claims_total unchanged (trusted outputs use the latest trusted version); lineage reports trusted_record_id distinct from current_record_id.

### Scenario J — Reporting correctness
_2026-10-20T02:25:55.645Z_

- 14 declared metrics across 2 tenants: API = hand-written SQL = generator truth for all 14.
- Operations report totals (8 fields) equal direct aggregates over core.batches: 6 batches, 6 succeeded, 5 trusted, 1 untrusted, 3 rows quarantined, 1 duplicate submission.
- Claims extract: 397 rows whose claim_ids equal the 397 ground-truth trusted claims; billed and paid sums equal truth; sha256 recomputed from bytes matches header and export_log.
- Filtered extract (status=PAID, service_date Jun–Aug) at fixed as_of returned 171 rows (hand SQL 171); two runs produced identical sha256.
- BI login with only clearline_rpt_northwind: rpt_trusted_claim count/paid/billed = 397/189670.45/489755.37 (= truth); reporting.batch_overview shows 6 batches.
- claims_total 397 trusted vs 457 including the untrusted batch (difference 60 = rows of the non-reconciling batch).
- Per-metric table: test-results/scenario-j-metric-comparison.json.

### Scenario K — Natural-language SQL proposal
_2026-10-20T02:25:59.063Z_

- Question "Show the total paid amount by tenant for the last month." -> proposal f839ce25-23c9-4dd4-9024-45de4a1a7154 (provider deterministic), valid, estimated cost 19; 0 executions after generation
- Run: 41 claims, total paid 24753.72 = independent SQL (41, 24753.72); executed SQL sha256 bb3e7447d7c1
- "Compare paid amounts across the last three reporting periods." -> 2026-07: 36269.87, 2026-08: 36218.75, 2026-09: 24753.72 (= independent SQL)
- "Find claims that reference members who have not arrived." -> 0 claims (= independent SQL)
- "Show me batches with reconciliation failures." -> 1 batch(es) (= independent SQL)
- "List claims with amounts above $2,000, excluding sensitive member information." -> 86 claims, columns status, claim_id, member_id, paid_amount, provider_npi, service_date, billed_amount, received_date, allowed_amount, procedure_code, adjudication_seq
- Edited proposal f86fb4ec-1552-47dd-8545-81029c92a2e5 (parent f839ce25-23c9-4dd4-9024-45de4a1a7154) re-validated and run: 31 paid claims (= independent SQL); an edit appending DELETE was rejected (multiple_statements) and refused at execute (403)

### Scenario K — provider failure and hostile proposals
_2026-10-20T02:25:59.206Z_

- Provider unavailable -> HTTP 503 provider_unavailable (retryable, with a hint to write SQL); a hand-written query still ran
- 5 hostile model proposals (DROP, cross-tenant table, stacked UPDATE, token table, file read) -> all rejected by validation, refused at execute, 0 executions

### Scenario L — Role-restricted field
_2026-10-20T02:26:03.088Z_

- member.ssn policy: sensitive, last4, unmask=[admin]; reporter=hidden, operator=filter -> effective admin=full, steward=masked, operator=filter, reporter=hidden
- admin query returned 150 original SSNs (= generator); steward received ***-**-dddd computed in the database (core.mask_value)
- reporter: 14 access routes (direct, alias, join, expression, concatenation, FROM/scalar subquery, CTE, EXISTS probe, filter probe, sort, group, null test) -> all rejected with the same error as a nonexistent column, and refused at execution
- reporter: ssn absent from catalog, SELECT *, contract document and natural-language proposals
- operator: only IS [NOT] NULL permitted (count with SSN = 150); every other route rejected as restricted_field; records and lineage omit the field and the raw SSN column
- database: column grant on q_northwind.member.ssn exists only for the admin, operator and steward query roles (not reporter)
- audit: policy change and every rejected validation recorded; no SSN value in any audit payload

### Scenario M — Field sensitivity and redaction
_2026-10-20T02:26:07.215Z_

- steward marked claim.provider_npi sensitive (last4); version 1, policy epoch 1; effective: admin=full, others=masked
- query workspace: reporter now receives ******6728 (mask applied by core.mask_value); probing/sorting/grouping/derivation over the field rejected; the pre-change execution is flagged stale (no rows stored)
- records (457), lineage (values and raw RENDERING_NPI), claims extract (operator and reporter), query CSV export, exception report: masked, 0 original NPIs; BI views rpt_claim / rpt_trusted_claim dropped the column
- admin: original in queries and in extracts only with include_sensitive; steward removed admin from unmask_roles -> admin masked; steward widening attempts (3) -> 403 policy_widening_not_permitted; admin (policy:grant) restored admin
- durable: rebuilt server and new connection pool still return the masked value; history: 3 versions (tighten, tighten, loosen) with actors; audit: 3 succeeded + 3 denied policy changes, the reporter attempt denied at authorization, executions record which columns were redacted; no NPI value in audit

### Scenario N — Tenant isolation and inference attacks
_2026-10-20T02:26:14.498Z_

- N1: 11 cross-tenant/internal-schema SQL attempts and a hostile generated proposal -> rejected, refused at execute, 0 executions; another tenant's proposal id -> 404; bluefin sees its own 3 batches
- N2 (validator bypassed): the bluefin query role is denied q_northwind, t_* tables, core.*, reporting.* and schema_migrations; forged app.tenant_id / app.scope do not change RLS; RESET ROLE leaves the privilege-less query login; SET ROLE clearline denied; writes impossible
- N3: 24 inference attacks on a filter-only field (literal/range/prefix probes, grouping, sorting incl. by position, distinct/min/max, conditional and filtered aggregates, derived expressions, casts, unrelated joins, HAVING, IN-subquery, subquery/CTE passthrough, scalar subquery, return, star) -> all rejected before execution; permitted boundary: IS [NOT] NULL and relationship joins
- N4: reporter history holds only its own queries (all=true ignored, other ids 404); steward history_all lists the admin query but withholds its SQL/validated SQL/executed SQL (it filters on a value masked for the steward) and refuses to run it; steward CSV export masked; operator export of a restricted query 403; database errors classified (division by zero -> data_error)
- N5: 4-way cross join -> timed_out after the 1.5 s statement timeout; a second one cancelled by its owner (others get 404); 3 concurrent runs -> 2 ran, 1 refused with 429; 5000-row cap with truncated=true; pg_sleep, generate_series and recursive CTEs rejected. Execution statuses: cancelled=1, failed=1, succeeded=6, timed_out=3

### Scenario P — Saved queries
_2026-10-20T02:26:18.332Z_

- saved query v1 executed with bound parameters: 180 days, equal to independent SQL; 2026-08-31 paid 24684.05 = ground truth
- text parameter "99223' OR '1'='1" bound as a value: 0 rows (vs 130 for 99223); executed SQL binds CAST($1 AS text)
- v1 -> v2 (column added: analysis stays active) -> v3 (column renamed: analysis needs_revalidation, run records stale_schema); runs keep versions 1 and 3
- an admin's shared query filtering on member.ssn: the reporter sees its name only (SQL withheld) and execution is refused (403 query_not_permitted)
- audit: saved_query.archive:1, saved_query.create:6, saved_query.duplicate:1, saved_query.version:2

### Scenario Q1 — Due runs, exactly once
_2026-10-20T02:26:21.884Z_

- daily 06:00 America/New_York -> occurrences 2026-10-01T10:00Z and 2026-10-02T10:00Z; two racing schedulers created and executed each exactly once (unique (schedule, occurrence))
- run timings: queue 0 ms, identity 7 ms, query 39 ms, snapshot 6 ms, analysis 33 ms

### Scenario Q2 — Recovery and missed occurrences
_2026-10-20T02:26:22.138Z_

- claimed run abandoned by sched-dead -> lease expired -> recovered and completed by sched-alive (attempt 2, one query execution)
- scheduler down 12:00-16:00 UTC -> one run for 16:00, missed_occurrences = 4

### Scenario Q3 — Pause, resume, cancel, DST
_2026-10-20T02:26:22.290Z_

- paused across an occurrence: no run; resumed at the next future occurrence; run-now used the schedule identity (reporter); cancel cancelled the queued run and is final
- DST preview America/New_York: daily 02:30 -> 2027-03-13T07:30:00.000Z, 2027-03-14T07:30:00.000Z, 2027-03-15T06:30:00.000Z (gap shifts forward); daily 01:30 -> 2026-10-31T05:30:00.000Z, 2026-11-01T05:30:00.000Z, 2026-11-02T06:30:00.000Z (overlap runs once)

### Scenario Q4 — Authorization loss and failure reporting
_2026-10-20T02:26:22.950Z_

- admin schedule delegated to reporter: ran; after claim.status became hidden for reporters the next run was denied (authorization), no query executed, schedule flagged for attention
- token "scheduler-bot" revoked -> its schedule's next run denied: identity_revoked
- division by zero: run failed (query, data_error); delivery_status delivered refers to the failure notice; run status stays failed

### Scenario Q5 — Scheduler in the worker process
_2026-10-20T02:26:26.157Z_

- worker process (no API client, no GPUI) executed a queued run; SIGTERM -> exit 0
- run queued while no worker was running stayed queued, and the restarted worker completed it

### Scenario R1 — Delivery to every destination
_2026-10-20T02:26:29.670Z_

- one scheduled run -> in-app (2 recipients; operator got a status-only notice), email via SMTP with CSV, webhook delivered on attempt 3 after two 503s (same Clearline-Delivery id, valid HMAC signatures), expiring export (downloaded, then 410 after expiry; both audited)

### Scenario R2 — Failures, retries and duplicates
_2026-10-20T02:26:30.768Z_

- webhook answered 400 -> delivery failed after 1 attempt, run failed (failure_class delivery, query succeeded) -> manual retry delivered it; the query ran once
- no answer within 500 ms -> timeout (transient) -> retried and delivered; 503 twice with max_attempts 2 -> failed
- two schedulers racing on one due delivery: one webhook request

### Scenario R3 — Redaction and re-authorization at delivery
_2026-10-20T02:26:31.139Z_

- webhook rows for the reporter: diagnosis_code arrived as "[redacted]" in all 20 rows; raw code absent from the body
- run executed, then claim.paid_amount was marked sensitive before delivery -> delivery BLOCKED (access_changed), no request sent, run failed (delivery_blocked); run result page re-masked paid_amount; manual retry blocked again

### Scenario R4 — Test deliveries
_2026-10-20T02:26:31.172Z_

- webhook test delivered (event "test"); email test reported a 451 deferral, then succeeded; webhook with a missing secret reported secret_unavailable; invalid address refused at configuration

### Scenario R5 — Interrupted delivery recovered
_2026-10-20T02:26:31.299Z_

- delivery f17c5c81 claimed by a worker that died: left alone while its lease was valid, then recovered (delivery.recover), sent once (Clearline-Delivery f17c5c81), attempts 2; run succeeded/delivered; audit by correlation id: delivery.attempt, delivery.recover, run.finish, query.execution, query.execution.requested

### Scenario S1 — Anomaly detection
_2026-10-20T02:26:34.782Z_

- rolling_mad (period 7) and seasonal_decomposition both rank 2026-08-31 first: observed 24684.05 (= ground truth), expected 9544.085, range 6559.512..12528.658, robust z 17.755, +158.6%
- insight: "paid for 2026-08-31 is above its expected range (158.6% above the baseline)" (high)

### Scenario S2 — Forecast vs held-out weeks
_2026-10-20T02:26:34.902Z_

- forecast.naive chosen by backtest MAE among forecast.naive (1212.9562), forecast.drift (1328.5189), forecast.holt_linear (1533.932); 8 rolling origins
- held-out absolute % error by week: 2026-08-24 3.6% (inside interval), 2026-08-31 23.2%, 2026-09-07 1.8% (inside interval), 2026-09-14 0.3% (inside interval)

### Scenario S3 — Outliers and segments
_2026-10-20T02:26:35.308Z_

- robust_distance within procedure: top 3 = A000000077 (score 88.815, mostly billed_amount), A000000555 (score 53.418, mostly processing_days), A000000999 (score 39.688, mostly billed_amount) = the seeded outliers; 3 flagged of 1483
- k-means k=3 seed 7: sizes 911/440/132, silhouette 0.784, purity vs generator profiles 100%; second run identical; clusters named only after review

### Scenario S4 — Sensitive inputs and insufficient data
_2026-10-20T02:26:35.649Z_

- claim.billed_amount marked sensitive: admin save with it as a feature -> 422 (derived from a sensitive field); reporter run -> analysis invalid_configuration (column redacted), other analyses still run
- 4-week forecast on 3 weeks -> insufficient_data with an explicit status insight (no forecast fabricated)

### Scenario S5 — Model summaries
_2026-10-20T02:26:35.861Z_

- a provider claiming "tripled to 99999 because of fraud" was rejected (ungrounded number / causal claim) and not shown; the template statement was unchanged; a grounded restatement was accepted alongside it; the provider received computed evidence only

### Scenario T1 — End to end, then revocation
_2026-10-20T02:26:39.468Z_

- daily 07:00 America/Chicago -> run at 12:00Z: anomaly on 2026-08-31 (observed 24684.05 = ground truth) persisted as an insight and delivered to the analyst's inbox
- second run executed, then the analyst token was revoked: its pending delivery was BLOCKED (identity_revoked) and nothing reached the operator
- next occurrence (2026-10-02T12:00Z): denied (authorization, identity_revoked), no query executed, no result stored, schedule flagged for attention
- audit for run 708af5a5: schedule.occurrence -> query.execution.requested -> query.execution -> analysis.run -> run.finish -> delivery.attempt; no result values

### Scenario T2 — SSRF
_2026-10-20T02:26:39.495Z_

- refused at configuration: http://example.org/hook (https_required); https://127.0.0.1/hook (private_address); https://10.1.2.3/hook (private_address); https://[::1]/hook (private_address); https://169.254.169.254/latest/meta-data/ (private_address); https://[::ffff:192.168.1.10]/x (private_address); https://user:pw@example.org/hook (credentials_in_url); https://example.org:22/hook (port_not_allowed); https://localhost/hook (private_address). Send-time DNS checks and connection pinning: test/unit/delivery.test.ts

### Scenario T3 — Tenant isolation
_2026-10-20T02:26:39.544Z_

- bluefin admin: 403 on every northwind analytics route; northwind ids are 404 under bluefin; RLS hides northwind rows of all 10 analytics tables in a bluefin-scoped transaction

### Scenario J — Reporting correctness (native GPUI client)
_2026-10-20T02:42:11.222Z_

- northwind reporter: 9 metric tiles display exactly the ground-truth values; ran/trusted tiles equal SQL (6 batches, 5 trusted, 1 not trusted).
- bluefin reporter: 5 metric tiles display exactly the ground-truth values; ran/trusted tiles equal SQL (3 batches, 3 trusted, 0 not trusted).
- operator: the untrusted batch appears as Ran + Not trusted; its detail shows the failed source_control_count check and its explanation.
- approver: lands on Contracts, the only navigation item; no data views.

### Scenario O — Native GPUI end-to-end workflow
_2026-10-20T02:42:21.058Z_

- reporter: NL question -> generated proposal fd1be370 (0 executions); edited SQL blocked until re-validated, then edited proposal run: 31 paid claims, 24753.72 total = independent SQL
- reporter: last_name and ssn (contract PII) returned as [redacted] by the database; the copied row is redacted too; no SSN reached the client
- admin (native field-policy view): claim.provider_npi marked sensitive (last4) and member.ssn hidden from reporters; both versioned as tightening changes; admin still sees original NPIs
- reporter: ssn absent from the catalog and rejected as an unknown column; provider_npi returned as ******dddd (masked by the database), labelled redacted in the grid
- operator: records grid and lineage of C000000104 (values and raw RENDERING_NPI) show the masked NPI; the original appears nowhere
- steward: history of all users (6 entries); dark theme rendered

### Native client integration (Rust)
_2026-10-20T02:42:38.247Z_

- clearline-client contract test against the live backend: 4 data roles x 16 endpoints decode or are refused (403) exactly per the server permissions; query lifecycle with client-chosen execution id; steward tighten/widen; approver, platform admin and cross-tenant tokens refused
- analytics contract: 4 roles save a proposal, version it with a typed parameter, preview-execute with a bound value, validate an analysis, duplicate, favorite; list destinations (create only with delivery:manage); preview, create, run-now and pause schedules (weekly Berlin, monthly last-day); decode run detail, run list and notifications; a reporter cannot delegate to admin; approver and cross-tenant refused

### Native client measurements
_2026-10-20T02:43:08.970Z_

- startup (process start -> first frame): 6584.5 ms; spawn -> automation ready: 6925 ms
- 5,000-row result: request -> grid frame drawn 178.71 ms; scrolling through all rows: p50 63.99 ms, p95 64.05 ms per frame
- typing while a query runs: p50 79.65 ms, p95 95.77 ms per frame (idle: p50 79.68 ms)

### Scenario U — Native saved analytics workflow
_2026-10-20T02:43:17.010Z_

- admin: in-app destination created and test-delivered; webhook to https://10.1.2.3 refused (private_address)
- reporter: NL request saved (v1, with its proposal), v2 typed :start/:end window, v3 anomaly analysis; schedule daily 06:00 America/New_York (preview 10:00Z then 11:00Z across DST); run 0daedf7f: succeeded / delivered; insight "paid for 2026-08-31 is above its expected range (119% above the baseline)" (high) quotes 25248.23 = independent SQL
- reporter: the anomaly notification is in the inbox and opens the run; run history shows it with query, analysis and delivery outcomes
