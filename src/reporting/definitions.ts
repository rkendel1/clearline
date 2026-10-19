// Platform-defined metric definitions (tenant-declared metrics come from the
// contract). Each entry states definition, source, filters, aggregation and
// refresh behaviour; docs/metrics.md is the human-readable version.

export interface MetricDefinition { id: string; definition: string; source: string; filters: string; aggregation: string; refresh: string }

export const PLATFORM_METRIC_DEFINITIONS: MetricDefinition[] = [
  { id: 'batches', definition: 'Batches registered in the window (including rejected).', source: 'core.batches', filters: 'tenant_id, arrival_at in [from, to]', aggregation: 'count(*)', refresh: 'live query' },
  { id: 'succeeded', definition: 'Batches whose processing committed (completed or completed_with_exceptions). Says nothing about trust.', source: 'core.batches', filters: "status IN ('completed','completed_with_exceptions')", aggregation: 'count(*)', refresh: 'live query' },
  { id: 'trusted', definition: 'Batches that completed AND passed every reconciliation check AND stayed under the reject-rate threshold.', source: 'core.batches', filters: "trust_status = 'trusted'", aggregation: 'count(*)', refresh: 'set when the batch commits' },
  { id: 'untrusted', definition: 'Batches excluded from trusted outputs (reconciliation failure, reject rate above threshold, structural rejection or processing failure).', source: 'core.batches', filters: "trust_status = 'untrusted'", aggregation: 'count(*)', refresh: 'set when the batch commits or fails' },
  { id: 'rows_received', definition: 'Rows staged from submitted payloads (one per CSV data line or JSON record).', source: 'core.batches.received_count', filters: 'window', aggregation: 'sum', refresh: 'set at submission' },
  { id: 'rows_accepted', definition: 'Canonical record versions written (current or historical/late). Exact duplicates excluded.', source: 'core.batches.accepted_count', filters: 'window', aggregation: 'sum', refresh: 'set when the batch commits' },
  { id: 'rows_quarantined', definition: 'Rows held out of canonical data for structural, business-rule, referential, privacy or conflict errors.', source: 'core.batches.quarantined_count', filters: 'window', aggregation: 'sum', refresh: 'set when the batch commits' },
  { id: 'exception_rate', definition: 'rows_quarantined / rows_received across processed batches (all time).', source: 'core.batches', filters: "status IN ('completed','completed_with_exceptions')", aggregation: 'sum(quarantined_count) / sum(received_count)', refresh: 'live query' },
  { id: 'duplicate_submissions', definition: 'Submissions whose payload digest matched an existing batch (no business effect).', source: 'core.batch_submissions', filters: "outcome = 'duplicate', submitted_at in window", aggregation: 'count(*)', refresh: 'live query' },
  { id: 'latency_p50_s / latency_p95_s', definition: 'Arrival-to-completion seconds for processed batches.', source: 'core.batches', filters: 'completed_at IS NOT NULL, not rejected, window', aggregation: 'percentile_cont(0.5 / 0.95)', refresh: 'live query' },
  { id: 'freshness.age_hours', definition: 'Hours since the most recent TRUSTED batch for the source completed. Stale when above the entity freshness.max_age_hours.', source: 'core.batches', filters: "source_id, trust_status = 'trusted'", aggregation: 'now() - max(completed_at)', refresh: 'live query' },
  { id: 'queue.queued / queue.oldest_queued_age_s', definition: 'Backlog depth and age of the oldest waiting batch.', source: 'core.batches', filters: "status = 'queued'", aggregation: 'count / now() - min(arrival_at)', refresh: 'live query' },
];
