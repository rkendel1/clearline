# Demonstration

Everything here is produced by the real API, worker, database and native client from a **fresh database**. Nothing is mocked or edited.

## Terminal demo (Docker Compose)

```sh
docker compose up -d && docker compose run --rm demo
```

The demo loads the reference dataset over HTTP, prints the platform's results next to the generator's ground truth, and then demonstrates the query workspace: the **same request under four roles**, an administrator's sensitivity change reaching every surface, a steward refused a widening, six bypass attempts, and a scan of the audit trail for SSNs. Finally it demonstrates **saved analytics** in eight steps: saving the natural-language-generated query, running it against independent SQL, a daily schedule in New York time (with the DST change visible), a new version with typed date parameters and anomaly detection plus forecasting, a run executed by the worker's scheduler with its insights, in-app and email delivery (email is written to files in the worker container by `EMAIL_PROVIDER=file`), the run's audit trail, and a revoked identity whose next run is denied. Everything runs offline. `--skip-query-demo` and `--skip-analytics-demo` leave those parts out; `--with-migration` also publishes Northwind 2.0.0 for approval. It exits non-zero on any mismatch.

Output from this repository's Compose stack (`deterministic` provider; abbreviated at the top):

```
northwind — business metrics (trusted data only) vs generator truth
  match    active_members         platform           99   truth           99
  match    members_total          platform          150   truth          150
  match    claims_total           platform          397   truth          397   (457 incl. untrusted)
  match    paid_claims            platform          279   truth          279   (317 incl. untrusted)
  match    denied_claims          platform           46   truth           46   (59 incl. untrusted)
  match    total_paid             platform    189670.45   truth    189670.45   (219121.70 incl. untrusted)
  match    total_billed           platform    489755.37   truth    489755.37   (571002.34 incl. untrusted)
  match    rx_fills               platform          120   truth          120
  match    rx_plan_paid           platform     31177.27   truth     31177.27

bluefin — business metrics (trusted data only) vs generator truth
  match    active_enrollees       platform          105   truth          105
  match    approved_rx_claims     platform          254   truth          254
  match    plan_cost_total        platform    109950.70   truth    109950.70
  match    avg_copay              platform      21.2509   truth      21.2509
  match    utilizing_enrollees    platform           95   truth           95

northwind — batches: ran vs trusted
  6151ff9c  nw_plans_csv           ran=completed                  trust=trusted   rows=3 accepted=3 quarantined=0
  f9f4e6d5  nw_eligibility_csv     ran=completed                  trust=trusted   rows=150 accepted=150 quarantined=0
  ecbb6859  nw_medical_claims_csv  ran=completed_with_exceptions  trust=trusted   rows=400 accepted=397 quarantined=3
  bebb7130  nw_medical_claims_csv  ran=completed                  trust=trusted   rows=25 accepted=25 quarantined=0
  75d8f71e  nw_medical_claims_csv  ran=completed                  trust=untrusted rows=60 accepted=60 quarantined=0
            why: reconciliation failed: source_control_count
  d6f3eec3  nw_pharmacy_api        ran=completed                  trust=trusted   rows=120 accepted=120 quarantined=0
  duplicate submissions ignored: 1

Why the untrusted batch is held back:
  source_control_count: Sender declared 61 rows but 60 arrived: 1 row(s) missing in transit or omitted from the file. Request a corrected file from the source.

Quarantined records (actionable reasons):
  row 8 of nw_medical_claims_csv: service_date: not a valid calendar date (YYYY-MM-DD) (got "2026-02-30")
  row 53 of nw_medical_claims_csv: Paid amount cannot exceed billed amount
  row 98 of nw_medical_claims_csv: Denied claims must have zero paid amount

Lineage of claim C000000104: record 101 (contract 1.0.0, source row 104, superseded) -> record 401 (contract 1.0.0, source row 4, current)

Privacy: bluefin admin reading northwind -> HTTP 403 cross_tenant_denied; northwind reporter exporting sensitive fields -> HTTP 403 sensitive_export_denied. Both audited.

=== Query workspace: natural-language SQL under role-aware field policy ===

1. Analyst (reporter) asks "How many claims are there?" -> proposal 355c7405, validated=true, executed=false
   SQL: SELECT count(*) AS claim_count FROM claim
   Edited to count trusted claims and run: 397 (ground truth 397) match; 4 ms; executed SQL sha256 a87ca336707b
   "Show the total paid amount by tenant for the last month." -> tenant, claims, total_paid = northwind, 41, 24753.72

2. Admin sets member.ssn: sensitive (last4), operator filter-only, reporter hidden -> HTTP 200, effective {"admin":"full","steward":"masked","operator":"filter","reporter":"hidden"}
   admin    "List members with their ssn" -> ran: first ssn value "936-95-8631"
   steward  "List members with their ssn" -> ran: first ssn value "***-**-8631" (redacted by the database: last4)
   operator "List members with their ssn" -> safe denial: Field member.ssn cannot be returned: your role may use it only to join to its related key or to test IS NULL; it cannot be returned.
   reporter "List members with their ssn" -> safe denial: I could not map this request onto the data available to your role. Try naming a table or column from the catalog, or write the SQL yourself.

3. Admin marks claim.provider_npi sensitive (last4) -> HTTP 200, tighten change, version 1
4. Reporter query: C000000001=******4083, C000000002=******4283, C000000003=******8425
   Operator record view: C000000001=******4083, C000000002=******4283 (redacted fields: {"provider_npi":"last4","diagnosis_code":"full"})
   Operator lineage of C000000104: provider_npi=******6728, raw source RENDERING_NPI=******6728
   Steward tries to remove the sensitivity (a widening) -> HTTP 403 policy_widening_not_permitted

5. Bypass attempts (as the reporter):
   SELECT member_id, ssn FROM member                          -> unknown_column; execute HTTP 403
   SELECT count(*) FROM member WHERE ssn LIKE '9%'            -> unknown_column; execute HTTP 403
   SELECT * FROM t_bluefin.rx_claim                           -> unknown_table; execute HTTP 403
   SELECT token_hash FROM core.api_tokens                     -> unknown_table; execute HTTP 403
   SELECT claim_id FROM claim; DELETE FROM claim              -> multiple_statements; execute HTTP 403
   SELECT count(*) FROM claim WHERE provider_npi = '1234567890' -> restricted_field; execute HTTP 403

6. Audit evidence (query and policy events):
   policy.field.update:denied               1
   policy.field.update:succeeded            2
   query.execution.requested:allowed        11
   query.execution:succeeded                5
   query.proposal.generated:failed          1
   query.proposal.generated:succeeded       5
   query.request:succeeded                  6
   query.validation:denied                  6
   query.validation:failed                  7
   query.validation:succeeded               6
   SSN values present in the audit trail: 0 of 150 (none: payloads carry ids, hashes, counts and column names only)


=== Saved analytics: saved queries, schedules, ML analyses and delivery ===
Loaded 1483 more claims over 2026-04-04..2026-09-30 (weekly pattern; one unusual day planted on 2026-08-31).

1. "Daily paid claim amounts, claim counts and average payment for the last 180 days."
   -> deterministic provider proposal 0fba7206 (validated=true), saved as "Daily paid claims" v1; output day:date, paid:decimal, claims:integer, avg_paid:decimal
2. Ran it: 161 days in 4 ms; 2026-08-31 paid 25248.23 vs independent SQL 25248.23 match
3. Schedule "Daily 06:00 New York": Daily at 06:00 (America/New_York), runs as northwind-reporter (reporter), next 2026-11-02T11:00:00.000Z; across the 1 Nov DST change: 2026-10-31T10:00:00.000Z, 2026-11-01T11:00:00.000Z, 2026-11-02T11:00:00.000Z
4. Version 2: parameters :start date = 2026-04-04, :end date = 2026-09-30; analyses daily-anomalies (anomaly.rolling_mad), daily-forecast (forecast.auto)
5. Run 4ea9675c: succeeded (query succeeded, analyses succeeded, delivery delivered); query 100 ms, analyses 181 ms
   [high] paid for 2026-04-26 is above its expected range (272.9% above the baseline)
          Observed 4,664.97 against an expected 1,251.04 from the median of the previous 8 same-phase observations (period 7); expected range 750.93 to 1,751.15. Robust z-score 23.89 (threshold 3.5). Method: anomaly.rolling_mad v1.0.0. This is a statistical deviation; i…
   [high] paid for 2026-04-25 is above its expected range (185.3% above the baseline)
          Observed 3,441.51 against an expected 1,206.34 from the median of the previous 8 same-phase observations (period 7); expected range 734.49 to 1,678.19. Robust z-score 16.58 (threshold 3.5). Method: anomaly.rolling_mad v1.0.0. This is a statistical deviation; i…
   [high] paid for 2026-08-31 is above its expected range (119% above the baseline)
          Observed 25,248.23 against an expected 11,529.76 from the median of the previous 8 same-phase observations (period 7); expected range 5,741.16 to 17,318.36. Robust z-score 8.3 (threshold 3.5). Method: anomaly.rolling_mad v1.0.0. This is a statistical deviation…
   [high] paid for 2026-05-02 is above its expected range (121.1% above the baseline)
          Observed 2,685.73 against an expected 1,214.97 from the median of the previous 8 same-phase observations (period 7); expected range 590.42 to 1,839.51. Robust z-score 8.24 (threshold 3.5). Method: anomaly.rolling_mad v1.0.0. This is a statistical deviation; it…
   planted anomaly on 2026-08-31 detected: yes
6. Deliveries: Analyst inbox (in_app) delivered; Finance email (email) delivered
   in-app for the analyst: [anomaly] Daily paid claims: anomaly detected
7. Audit trail for the run: schedule.run_now:succeeded -> query.execution.requested:allowed -> query.execution:succeeded -> analysis.run:succeeded -> run.finish:succeeded -> delivery.attempt:succeeded
8. Schedule of token "analyst-demo": ran (succeeded); token revoked; next run denied (authorization: identity_revoked), query executed: no, deliveries: failed (no_recipients)
   schedule attention: The execution identity "analyst-demo" no longer has an active token. Someone with schedule:manage must recreate the schedule under an active identity.

Native client: npm run native:run -- --url http://localhost:8080  (sign in with cl_dev_northwind_operator, cl_dev_northwind_reporter, cl_dev_northwind_steward or cl_dev_northwind_admin).
Result: every metric and every checked query result matches ground truth.
```

In step 5 the planted day (2026-08-31) is found; the other high findings in late April are real deviations in the combined data — the reference dataset's own claims fall on days where the analytics dataset's baseline is low. They are listed because they are statistically unusual, not because they are errors.

## Native client screenshots

Written by `npm run test:e2e` to `test-results/native/` from the real window (Xvfb, 1440×920) while it runs Scenario J (native), Scenario O and Scenario U:

| File | What it shows |
|---|---|
| `01-overview-northwind-reporter.png`, `01-overview-bluefin-reporter.png` | Overview for two tenants with different models: verdict, ran versus trusted, freshness, business summary (values checked against ground truth by the test) |
| `02-batch-untrusted-operator.png` | A batch that ran but is not trusted, with the failed reconciliation check and its explanation |
| `03-approver-contracts.png` | The approver sees only Contracts: no tenant data views |
| `04-query-proposal-reporter.png` | Natural-language question → validated proposal: server summary, unverified model explanation, referenced columns with the role's access, and the role's catalog |
| `05-query-result-reporter.png` | The edited proposal re-validated and run; result equal to independent SQL |
| `06-query-pii-redacted-reporter.png` | Masked fields returned in redacted form by the database |
| `07-fields-admin.png` | Field policy editor: an administrator makes `member.ssn` sensitive (last4), operator filter-only, reporter hidden; effective access per role |
| `08-query-hidden-field-reporter.png` | The reporter's query on the now-hidden field: rejected exactly as for a nonexistent column |
| `09-query-masked-reporter.png` | `provider_npi` after it is marked sensitive: redacted in the workspace |
| `10-records-claims-operator.png`, `11-lineage-operator.png` | The same redaction in record view and lineage (canonical and raw source values) |
| `12-history-steward.png`, `13-history-steward-dark.png` | Everyone's query history for the steward, re-validated for the viewer, entries flagged where the policy has changed since; dark theme |
| `14-large-result-reporter.png` | A 5,000-row result in the virtualized grid |
| `15-destinations-admin.png` | Delivery destinations: an in-app inbox created and test-delivered; a webhook to a private address refused |
| `16-library-sql-versions-reporter.png` | The saved query in the library, SQL tab: version 2 with typed `:start`/`:end` parameters |
| `17-analysis-builder-reporter.png` | Analysis builder: anomaly detection on daily paid amounts, validated by the server, saved as version 3 |
| `18-schedule-editor-reporter.png` | Schedule editor: daily 06:00 America/New_York, run as the reporter, next occurrences across the DST change |
| `19-run-insights-reporter.png` | A run executed by the scheduler: phase outcomes, timings and evidence-backed insights |
| `20-run-chart-reporter.png` | The same run: observed series, expected band and anomaly markers; delivery; bounded result |
| `21-notifications-reporter.png` | The anomaly notification in the reporter's inbox (opening it opens the run) |
| `22-run-history-reporter.png` | Run history with query, analysis and delivery outcomes |

[`query-workspace.png`](query-workspace.png) (used in the top-level README) is a copy of `04`.

Scenarios without a visual surface are demonstrated by tests whose results are in [`../test-results.md`](../test-results.md): duplicate delivery (C), crash and graceful-shutdown recovery (F), cross-tenant SQL access (G), drift detection and trust restoration (I), query isolation with the validator bypassed, timeouts, cancellation and limits (N).
