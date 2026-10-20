// Minimal Prometheus text-format metrics registry (no external dependency).

type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',');
}

class Counter {
  values = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  inc(labels: Labels = {}, by = 1) { const k = key(labels); this.values.set(k, (this.values.get(k) ?? 0) + by); }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  data = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(public name: string, public help: string, public bounds: number[]) {}
  observe(value: number, labels: Labels = {}) {
    const k = key(labels);
    let d = this.data.get(k);
    if (!d) { d = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 }; this.data.set(k, d); }
    this.bounds.forEach((b, i) => { if (value <= b) d!.buckets[i]++; });
    d.sum += value; d.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, d] of this.data) {
      const pre = k ? `${k},` : '';
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket{${pre}le="${b}"} ${d.buckets[i]}`));
      lines.push(`${this.name}_bucket{${pre}le="+Inf"} ${d.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${d.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${d.count}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('clearline_http_requests_total', 'HTTP requests by route and status'),
  httpDuration: new Histogram('clearline_http_request_duration_seconds', 'HTTP request latency', [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
  batchesSubmitted: new Counter('clearline_batches_submitted_total', 'Batch submissions by outcome'),
  batchesProcessed: new Counter('clearline_batches_processed_total', 'Batch processing attempts by final status'),
  rowsProcessed: new Counter('clearline_rows_processed_total', 'Rows processed by disposition'),
  batchDuration: new Histogram('clearline_batch_processing_seconds', 'Batch processing time (claim to commit)', [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300]),
  authDenials: new Counter('clearline_authorization_denials_total', 'Authorization denials by reason'),
  analyticsRunSeconds: new Histogram('clearline_analytics_run_seconds', 'Saved-query run execution time (claim to outcome, excluding delivery)', [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]),
  analyticsRuns: new Counter('clearline_analytics_runs_total', 'Saved-query runs by outcome'),
  deliveryAttempts: new Counter('clearline_delivery_attempts_total', 'Delivery attempts by destination kind and result'),
};

/** Render process-local metrics plus gauges computed from the database at scrape time. */
export function renderMetrics(gauges: string[]): string {
  return [...Object.values(metrics).map((m) => m.render()), ...gauges].join('\n') + '\n';
}
