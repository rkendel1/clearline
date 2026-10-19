# Recorded demonstration

[`clearline-demo.mp4`](clearline-demo.mp4) (65 s, 1280×760) is recorded by `npm run demo:record` from a **fresh database**: the real API, worker and dashboard driven by Chromium. Nothing in it is mocked or edited. Re-run the script to reproduce it.

| Time | Scene | What it shows |
|---|---|---|
| 0:00 | Sign-in | Synthetic data only; two tenants with different canonical models on one codebase |
| 0:06 | Overview: normal operation | Verdict line, ran-versus-trusted totals, freshness per source |
| 0:11 | Business summary | Trusted-only figures; tiles say how many untrusted records were held back and what the figure would be if they were included |
| 0:16 | **Failure 1: reconciliation** | A claims batch that ran but is *not trusted*; its detail page shows `source_control_count` failed: "Sender declared 61 rows but 60 arrived" |
| 0:27 | **Failure 2: bad data** | Exceptions: impossible date, paid more than billed, denied claim with payment, each with rule and source row; none reach trusted metrics |
| 0:33 | Lineage | Claim C000000104: denied (v1) then re-adjudicated paid (v2), each version traced to source row, batch, contract and metric contribution |
| 0:40 | **Failure 3: privacy** | A reporter requests unredacted fields: denied by the backend and audited |
| 0:47 | **Failure 4: breaking contract change** | Northwind 2.0.0 waits for approval; the plan lists changes, DDL, impact and rollback. A second admin approves (0:55); it applies as new record versions |
| 1:00 | Close | Scenarios A–J verify these numbers against independent SQL and ground truth |

Scenarios not shown in the video, because they have no visual surface, are demonstrated by tests whose results are in [`../test-results.md`](../test-results.md): duplicate delivery (C), crash and graceful-shutdown recovery (F), cross-tenant SQL access (G), drift detection and trust restoration (I).

## Terminal demo

`docker compose run --rm demo` loads the same reference dataset over HTTP and prints the platform's results next to ground truth. Output from this repository's Compose stack:

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
  …  nw_medical_claims_csv  ran=completed_with_exceptions  trust=trusted   rows=400 accepted=397 quarantined=3
  …  nw_medical_claims_csv  ran=completed                  trust=untrusted rows=60 accepted=60 quarantined=0
            why: reconciliation failed: source_control_count
  duplicate submissions ignored: 1

Quarantined records (actionable reasons):
  row 8 of nw_medical_claims_csv: service_date: not a valid calendar date (YYYY-MM-DD) (got "2026-02-30")
  row 53 of nw_medical_claims_csv: Paid amount cannot exceed billed amount
  row 98 of nw_medical_claims_csv: Denied claims must have zero paid amount

Privacy: bluefin admin reading northwind -> HTTP 403 cross_tenant_denied; northwind reporter exporting sensitive fields -> HTTP 403 sensitive_export_denied. Both audited.
Result: every metric matches ground truth.
```
