
### Scenario A — Normal ingestion
_2026-10-19T21:20:25.328Z_

- Submitted 3 plans, 200 members, 1000 claims (CSV, control totals record_count=1000, paid=498911.75, billed=1305555.94).
- Claims batch dd05cad5-8b62-4896-a150-b212e2133bec: status=completed, trust=trusted, quality=passed, reconciliation=passed; 9 reconciliation checks all passed.
- Business metric total_paid=498911.75 (generator truth 498911.75), claims_total=1000.
- Extract claims: 1000 rows, sha256 0d2cf2b4ce19f9a6…, diagnosis_code redacted; billed sum matches truth.
- Lineage for C000000005: source row 5 -> record 5 -> metric total_paid (included) -> export c204c6c3-9cea-4de0-bb2d-12486ead5a24.

### Scenario B — Tenant customization
_2026-10-19T21:20:28.011Z_

- northwind tables: claim(claim_id,member_id,provider_npi,service_date,received_date,diagnosis_code,procedure_code,billed_amount,allowed_amount,paid_amount,status,adjudication_seq); member(member_id,ssn,first_name,last_name,date_of_birth,gender,zip,plan_code,coverage_start,coverage_end,status,updated_at); pharmacy_fill(fill_id,member_id,ndc,fill_date,days_supply,quantity,ingredient_cost,dispensing_fee,plan_paid,member_paid,status,pharmacy_npi,updated_at); plan(plan_code,plan_name,plan_type,deductible,oop_max,effective_date,termination_date,updated_at)
- bluefin tables: benefit_plan(plan_id,plan_label,tier_count,effective_on,revision); enrollee(enrollee_id,subscriber_id,dependent_seq,relationship,full_name,birth_date,email,plan_id,coverage_tier,effective_on,terminated_on,record_version); rx_claim(claim_number,enrollee_id,ndc,fill_date,days_supply,ingredient_cost,dispense_fee,total_cost,copay,plan_cost,claim_state,adjudicated_at,pharmacy_id)
- bluefin implied-cents/YYYYMMDD/concatenated-key semantics verified on BX00000001.
- Third tenant "coral" created via POST /tenants, token issued, contract published (with an extra 30-day rule) and data processed at runtime: 37 of 150 claims quarantined by the tenant-only rule (expected 37).
- grep of src/ for tenant names: 0 files.

### Scenario C — Duplicate delivery
_2026-10-19T21:20:29.817Z_

- Resubmitting identical bytes returned HTTP 200 with duplicate=true and the original batch id 585f0087-1cdf-4dd3-86ad-aeac7225b73c; recorded as a 'duplicate' submission.
- 5 concurrent identical submissions produced exactly 1 batch (7c32cc76-9a2c-4a10-88cf-a879a75bc8b2).
- Redelivery file (100 already-loaded + 10 new rows): accepted=10, duplicate=100, quarantined=0, still trusted; each duplicate row links to the version it duplicated.
- claim rows: 400 -> 460 (+60 genuinely new); keys with >1 current version: 0; claims_total 400 -> 460.

### Scenario D — Bad data
_2026-10-19T21:20:31.344Z_

- Batch of 202 rows with 9 single-defect rows, 1 SSN in an unmapped column, 1 malformed row, 1 orphaned member reference.
- Result: pipeline=completed_with_exceptions, quality=failed, trust=untrusted (reject rate 5.45% exceeds threshold 5.00%), reconciliation=passed.
- accepted=191, quarantined=11 (structural 6, business/privacy 5), warnings=1.
- Every defect attributed to its exact rule with source row number, e.g. row 191: "service_date: not a valid calendar date (YYYY-MM-DD) (got "2026-02-30")".
- SSN absent from 3 captured log lines and scrubbed from the retained raw payload.
- total_paid trusted=0.00; including untrusted=80605.91 = sum of valid rows only (80605.91).

### Scenario E — Late data and corrections
_2026-10-19T21:20:33.101Z_

- Member NW0000001: v1 ACTIVE (updated 09-10) -> correction TERMINATED (updated 09-20) superseded it; late file (reported 09-15, after the 09-20 file) carried PENDING (updated 09-15) -> stored as history with is_late=true, current unchanged.
- Conflicting version (same updated_at 09-20, different content) quarantined as 'conflict' and listed in the exception report.
- as_of=2026-10-19T21:20:32.706Z extract returns status ACTIVE and 2 members; current extract returns TERMINATED and 3 members.
- Claim C000000001: seq1 paid 100.00 superseded by seq2 paid 80.00; re-sending seq1 counted as duplicate with no effect.

### Scenario F1 — Crash and restart (SIGKILL)
_2026-10-19T21:20:39.895Z_

- Worker process launched with fault injection crash_after_rows=1000 on a 6000-row batch; it wrote canonical rows inside its transaction, then died by SIGKILL.
- After the crash: status=processing (not success), trust=pending, canonical rows for the batch=0, quality/reconciliation rows=0.
- A fresh worker process recovered the expired lease (audited batch.recover), re-processed from scratch and committed: attempts=[1 interrupted, 2 succeeded], accepted=6000, duplicate keys=0, trust=trusted.

### Scenario F2 — Graceful shutdown (SIGTERM)
_2026-10-19T21:20:45.007Z_

- SIGTERM delivered while a 25,000-row batch was processing (grace 0 ms): worker aborted the transaction, re-queued the batch and exited with code 0.
- State after shutdown: status=queued, canonical rows=0, attempts=[1 interrupted]. Next worker completed it: attempt 2, 25000 accepted.

### Scenario G — Privacy violation
_2026-10-19T21:20:46.676Z_

- bluefin reporter/admin tokens against 4 northwind endpoints (report, extract, lineage, submit): all HTTP 403 cross_tenant_denied; platform admin denied tenant data; invalid token 401.
- northwind reporter and operator requesting include_sensitive=true: HTTP 403 sensitive_export_denied, audited as extract.run/denied.
- Default eligibility extract: first_name/last_name/date_of_birth/gender = REDACTED in all 30 rows; no generated name or SSN appears in the payload.
- Audit: denials recorded in the targeted tenant and attempts in the caller tenant; UPDATE/DELETE on audit_events rejected by trigger.
- SQL: BI login in clearline_rpt_bluefin sees only bluefin rows in reporting views (even after setting app.tenant_id=northwind), is denied t_northwind views, base tables and raw records, and reporting views omit pii/phi columns.

### Scenario H — Contract evolution
_2026-10-19T21:22:54.765Z_

- Baseline: 300 claims under 1.0.0 (47 PENDED). v2-unsafe dry-run classification=rejected: 2 reasons incl. "paid_amount: decimal -> integer" and "PENDED removed without a mapping"; publish returned 422 and stored nothing.
- A contract declaring a non-whitelisted transform ({op:"javascript"}) failed schema validation (422 invalid_contract).
- v2 publish returned 202 pending_approval, migration 3: breaking changes [enum_values_remapped:status, field_added_required:line_of_business, field_removed:procedure_code]; 1 DDL statement(s), none destructive; data ops backfill line_of_business=COMMERCIAL and PENDED->PENDING; impact 347 of 300 current rows. Full plan: test-results/scenario-h-migration-plan.json.
- While pending: 1.0.0 remained active, no column added, a new claims batch processed under 1.0.0, a further publish got 409 migration_pending.
- Approval: operator 403, requester self-approval 403 requester_cannot_approve (audited), wrong confirm_version 422. Second admin approved -> applied; lifecycles 1.0.0:superseded, 2.0.0:active.
- After apply: 305 current claims all carry line_of_business=COMMERCIAL and 0 PENDED; 305 prior versions retained unchanged under 1.0.0 (lineage for C000000020: 1.0.0:PENDED -> 2.0.0:PENDING). total_paid unchanged (137110.09); re-verification found no drift.
- Rollback restored 305 versions and 1.0.0. Roll-forward 2.0.1 approved; 40 v2-shaped claims trusted (medicare_claims=20); v1-shaped file rejected (missing LOB); rollback then refused 409 rollback_window_closed.

### Scenario I — Reconciliation failure
_2026-10-19T21:23:44.883Z_

- In transit: sender declared 250 rows / paid 129308.02; 247 arrived. Batch 63124c3b-fda6-4f34-a6c1-f5534c0b386f: pipeline=completed, quality=passed, reconciliation=failed, trust=untrusted.
- Explanation: "Sender declared 250 rows but 247 arrived: 3 row(s) missing in transit or omitted from the file. Request a corrected file from the source." and paid difference -1209.83 (= the 3 lost rows' paid total, from the generator).
- Trusted outputs held it back: claims_total 200 (447 including untrusted, 247 excluded, metric flagged trusted=false); default extract 200 rows, include_untrusted extract 447; operations report succeeded=4 vs untrusted=1.
- Drift: 2 rows deleted and 1 paid_amount edited (+1000.00) directly in SQL. Re-verification: rows -2, paid difference 332.13 (expected 332.13); batch f15c5beb-61d8-4920-b7a6-aa744f700983 became untrusted, batch.drift_detected audited.
- Missing references: 12 claims for 5 undelivered members admitted with warnings; dataset check orphans=12 failed with explanation and all 12 listed in the exception report; after the late eligibility file the check passed.

### Scenario J — Reporting correctness
_2026-10-19T21:25:43.797Z_

- 14 declared metrics across 2 tenants: API = hand-written SQL = generator truth for all 14.
- Operations report totals (8 fields) equal direct aggregates over core.batches: 6 batches, 6 succeeded, 5 trusted, 1 untrusted, 3 rows quarantined, 1 duplicate submission.
- Claims extract: 397 rows whose claim_ids equal the 397 ground-truth trusted claims; billed and paid sums equal truth; sha256 recomputed from bytes matches header and export_log.
- Filtered extract (status=PAID, service_date Jun–Aug) at fixed as_of returned 171 rows (hand SQL 171); two runs produced identical sha256.
- BI login with only clearline_rpt_northwind: rpt_claim trusted count/paid/billed = 397/189670.45/489755.37 (= truth); reporting.batch_overview shows 6 batches.
- claims_total 397 trusted vs 457 including the untrusted batch (difference 60 = rows of the non-reconciling batch).
- Per-metric table: test-results/scenario-j-metric-comparison.json.

### Scenario J — Reporting correctness (dashboard, Chromium)
_2026-10-19T21:39:06.562Z_

- northwind: 9 metric tiles display exactly the ground-truth values (e.g. active_members=99, members_total=150, claims_total=397).
- northwind: ran-vs-trusted tiles equal SQL over core.batches (6 batches, 6 ran, 5 trusted, 1 not trusted).
- bluefin: 5 metric tiles display exactly the ground-truth values (e.g. active_enrollees=105, approved_rx_claims=254, plan_cost_total=$109,950.70).
- bluefin: ran-vs-trusted tiles equal SQL over core.batches (3 batches, 3 ran, 3 trusted, 0 not trusted).
- Untrusted batch appears as "Ran" + "Not trusted"; its detail page shows the failed source_control_count check and explanation.
- bluefin reporter: no lineage navigation, only bluefin metrics rendered.

### Scenario J — Reporting correctness (dashboard, Chromium)
_2026-10-19T21:53:37.260Z_

- northwind: 9 metric tiles display exactly the ground-truth values (e.g. active_members=99, members_total=150, claims_total=397).
- northwind: ran-vs-trusted tiles equal SQL over core.batches (6 batches, 6 ran, 5 trusted, 1 not trusted).
- bluefin: 5 metric tiles display exactly the ground-truth values (e.g. active_enrollees=105, approved_rx_claims=254, plan_cost_total=$109,950.70).
- bluefin: ran-vs-trusted tiles equal SQL over core.batches (3 batches, 3 ran, 3 trusted, 0 not trusted).
- Untrusted batch appears as "Ran" + "Not trusted"; its detail page shows the failed source_control_count check and explanation.
- bluefin reporter: no lineage navigation, only bluefin metrics rendered.

### Scenario J — Reporting correctness (dashboard, Chromium)
_2026-10-19T21:53:50.856Z_

- northwind: 9 metric tiles display exactly the ground-truth values (e.g. active_members=99, members_total=150, claims_total=397).
- northwind: ran-vs-trusted tiles equal SQL over core.batches (6 batches, 6 ran, 5 trusted, 1 not trusted).
- bluefin: 5 metric tiles display exactly the ground-truth values (e.g. active_enrollees=105, approved_rx_claims=254, plan_cost_total=$109,950.70).
- bluefin: ran-vs-trusted tiles equal SQL over core.batches (3 batches, 3 ran, 3 trusted, 0 not trusted).
- Untrusted batch appears as "Ran" + "Not trusted"; its detail page shows the failed source_control_count check and explanation.
- bluefin reporter: no lineage navigation, only bluefin metrics rendered.

### Scenario I — Reconciliation failure
_2026-10-19T21:56:06.917Z_

- In transit: sender declared 250 rows / paid 129308.02; 247 arrived. Batch 1a7655ad-5d69-42ef-95c2-5880fdf25e33: pipeline=completed, quality=passed, reconciliation=failed, trust=untrusted.
- Explanation: "Sender declared 250 rows but 247 arrived: 3 row(s) missing in transit or omitted from the file. Request a corrected file from the source." and paid difference -1209.83 (= the 3 lost rows' paid total, from the generator).
- Trusted outputs held it back: claims_total 200 (447 including untrusted, 247 excluded, metric flagged trusted=false); default extract 200 rows, include_untrusted extract 447; operations report succeeded=4 vs untrusted=1.
- Drift: 2 rows deleted and 1 paid_amount edited (+1000.00) directly in SQL. Re-verification: rows -2, paid difference 332.13 (expected 332.13); batch 8d061b04-3467-446b-968b-21b248c035c9 became untrusted, batch.drift_detected audited. After restoring the rows from a backup copy, re-verification passed and trust was restored (batch.trust_restored audited); claims_total back to 200, total_paid back to truth. The in-transit batch stayed untrusted.
- Missing references: 12 claims for 5 undelivered members admitted with warnings; dataset check orphans=12 failed with explanation and all 12 listed in the exception report; after the late eligibility file the check passed.
