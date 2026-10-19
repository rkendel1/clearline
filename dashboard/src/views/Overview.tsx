import { useState } from 'react';
import { useApi, Section, ErrorNote, PipelineSignal, TrustSignal, Signal, Empty, CheckSignal } from '../components';
import { formatValue, ago, when, shortId, seconds } from '../format';

export function Overview({ tenant, onOpenBatch }: { tenant: string; onOpenBatch: (id: string) => void }) {
  const ops = useApi<any>(`/api/v1/tenants/${tenant}/reports/operations`);
  const biz = useApi<any>(`/api/v1/tenants/${tenant}/reports/business`);
  const o = ops.data, b = biz.data;
  const reload = () => { void ops.reload(); void biz.reload(); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Is {tenant}’s data trustworthy right now?</h1>
          {o && <Verdict verdict={o.verdict} />}
        </div>
        <button className="btn" onClick={reload} disabled={ops.loading || biz.loading}>{ops.loading || biz.loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <ErrorNote error={ops.error ?? biz.error} />

      {o && (
        <Section id="ran-vs-trusted" title="Ran versus trusted" description={`Batches arriving ${when(o.window.from)} – ${when(o.window.to)}. A batch that ran is not automatically trusted: it must also reconcile and stay under its reject-rate threshold.`}>
          <dl className="tally" data-testid="ops-totals">
            <Tally label="Batches received" value={o.totals.batches} field="batches" />
            <Tally label="Ran to completion" value={o.totals.succeeded} field="succeeded" />
            <Tally label="Trusted" value={o.totals.trusted} field="trusted" tone="good" />
            <Tally label="Not trusted" value={o.totals.untrusted} field="untrusted" tone={o.totals.untrusted ? 'bad' : undefined} />
            <Tally label="Failed" value={o.totals.failed} field="failed" tone={o.totals.failed ? 'bad' : undefined} />
            <Tally label="Rejected at intake" value={o.totals.rejected} field="rejected" />
            <Tally label="In flight" value={o.totals.in_flight} field="in_flight" />
            <Tally label="Duplicate submissions ignored" value={o.totals.duplicate_submissions} field="duplicate_submissions" />
          </dl>
        </Section>
      )}

      {o && (
        <Section id="freshness" title="Freshness by source" description="Age of the most recent trusted batch per source, against the contract’s freshness limit.">
          <table className="grid">
            <thead><tr><th>Source</th><th>Entity</th><th>Last arrival</th><th>Last trusted</th><th className="num">Age</th><th className="num">Limit</th><th>Status</th></tr></thead>
            <tbody>
              {o.freshness.map((f: any) => (
                <tr key={f.source_id}>
                  <td>{f.source_id}</td><td>{f.entity}</td><td>{when(f.last_arrival)}</td><td>{ago(f.last_trusted)}</td>
                  <td className="num">{f.age_hours === null ? '—' : `${f.age_hours} h`}</td><td className="num">{f.max_age_hours ?? '—'}{f.max_age_hours ? ' h' : ''}</td>
                  <td>{f.status === 'fresh' ? <Signal tone="good" label="Fresh" /> : f.status === 'stale' ? <Signal tone="bad" label="Stale" /> : <Signal tone="idle" label="No trusted data" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {b && (
        <Section id="business" title="Business summary" description={<>Declared by contract {b.contract_version}. Values use the latest version of each record that came from a trusted batch; where untrusted data was held back, the tile says how much it would change the figure.</>}>
          <div className="metrics" data-testid="business-metrics">
            {b.metrics.map((m: any) => (
              <article key={m.id} className={`metric ${m.trusted ? '' : 'metric-partial'}`} data-trusted={String(m.trusted)} data-metric={m.id} data-value={m.value} title={m.description}>
                <h3>{m.title}</h3>
                <p className="metric-value">{formatValue(m.value, m.unit)}</p>
                {m.trusted && <p className="metric-foot"><Signal tone="good" label="Covers all received data" /></p>}
                {m.untrusted_records_excluded > 0 && <p className="metric-foot"><Signal tone="warn" label={`${formatValue(m.untrusted_records_excluded)} untrusted records held back`} /><span className="muted"> {formatValue(m.value_including_untrusted, m.unit)} if included</span></p>}
                {m.dataset_checks_failing?.length > 0 && <p className="metric-foot" data-qualified="true"><Signal tone="warn" label="Dataset check failing" /><span className="muted"> {m.dataset_checks_failing.map((q: { explanation: string }) => q.explanation).join(' ')}</span></p>}
              </article>
            ))}
            <article className="metric" data-metric="exception_rate" data-value={b.exception_rate.rate}>
              <h3>Exception rate</h3>
              <p className="metric-value">{(b.exception_rate.rate * 100).toFixed(2)}%</p>
              <p className="metric-foot muted">{formatValue(b.exception_rate.quarantined)} of {formatValue(b.exception_rate.received)} rows quarantined</p>
            </article>
          </div>
        </Section>
      )}

      {o && (
        <Section id="volume" title="Daily volume and quarantine" description={<>Latency p50 {seconds(o.totals.latency_p50_s)}, p95 {seconds(o.totals.latency_p95_s)} from arrival to completion. Queue: {o.queue.queued} waiting, {o.queue.processing} processing{o.queue.oldest_queued_age_s ? `, oldest ${seconds(o.queue.oldest_queued_age_s)}` : ''}.</>}>
          <DailyChart days={o.daily} />
        </Section>
      )}

      {o && (
        <Section id="recent" title="Recent batches" description="Select a batch to see its reconciliation checks, quality results and attempts.">
          <BatchTable batches={o.recent_batches} onOpen={onOpenBatch} />
        </Section>
      )}

      {o && o.reconciliation.latest_dataset_run.length > 0 && (
        <Section id="dataset" title="Dataset reconciliation" description="Invariants over the whole trusted dataset, re-evaluated after every batch.">
          <table className="grid">
            <thead><tr><th>Check</th><th>Result</th><th>Explanation</th></tr></thead>
            <tbody>{o.reconciliation.latest_dataset_run.map((r: any) => <tr key={r.check_id}><td>{r.check_id.replace(/^dataset:/, '')}</td><td><CheckSignal status={r.status} /></td><td className="prose">{r.explanation}</td></tr>)}</tbody>
          </table>
        </Section>
      )}
    </>
  );
}

// Rendered verbatim from the API's verdict: the dashboard does not decide trust itself.
function Verdict({ verdict }: { verdict: { status: string; summary: string } }) {
  const tone = verdict.status === 'trusted' ? 'good' : verdict.status === 'in_progress' ? 'idle' : 'bad';
  const label = verdict.status === 'trusted' ? 'Yes' : verdict.status === 'in_progress' ? 'Processing' : 'Needs review';
  return <p className={`verdict verdict-${tone}`} data-testid="verdict" data-status={verdict.status}><Signal tone={tone} label={label} /> {verdict.summary}</p>;
}

function Tally({ label, value, field, tone }: { label: string; value: number; field: string; tone?: 'good' | 'bad' }) {
  return <div className={`tally-item ${tone ? `tally-${tone}` : ''}`} data-total={field} data-value={value}><dt>{label}</dt><dd>{formatValue(value)}</dd></div>;
}

export function BatchTable({ batches, onOpen }: { batches: any[]; onOpen: (id: string) => void }) {
  if (!batches.length) return <Empty>No batches yet. Submit a CSV or JSON batch to a declared source to see it here.</Empty>;
  return (
    <div className="scroll-x">
      <table className="grid batches">
        <thead><tr><th>Batch</th><th>Source</th><th>Arrived</th><th>Ran</th><th>Trusted</th><th className="num">Rows</th><th className="num">Accepted</th><th className="num">Quarantined</th><th className="num">Duplicates</th><th className="num">Attempts</th></tr></thead>
        <tbody>
          {batches.map((x) => (
            <tr key={x.id} data-batch={x.id}>
              <td><button className="link" onClick={() => onOpen(x.id)} aria-label={`Open batch ${x.id}`}>{shortId(x.id)}</button>{x.is_late && <span className="tag" title="Source-reported time is older than a batch already received">late</span>}</td>
              <td>{x.source_id}</td><td>{when(x.arrival_at)}</td>
              <td><PipelineSignal status={x.status} /></td>
              <td><TrustSignal status={x.trust_status} reasons={x.trust_reasons} /></td>
              <td className="num">{formatValue(x.received_count)}</td><td className="num">{formatValue(x.accepted_count)}</td>
              <td className="num">{formatValue(x.quarantined_count)}</td><td className="num">{formatValue(x.duplicate_count)}</td><td className="num">{x.attempt_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyChart({ days }: { days: any[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return <Empty>No batches in this window.</Empty>;
  const W = 720, H = 180, pad = { l: 48, r: 8, t: 8, b: 24 };
  const max = Math.max(...days.map((d) => d.rows_received), 1);
  const step = (W - pad.l - pad.r) / days.length;
  const bw = Math.min(28, step * 0.6);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  return (
    <figure className="chart">
      <div className="legend"><span><i className="sw sw-1" /> Rows received</span><span><i className="sw sw-2" /> Rows quarantined (part of received)</span></div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Rows received and quarantined per day">
          {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="gridline" /><text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{formatValue(t)}</text></g>)}
          {days.map((d, i) => {
            const x = pad.l + i * step + (step - bw) / 2;
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${d.day}: ${d.rows_received} rows received, ${d.rows_quarantined} quarantined`}>
                <rect x={pad.l + i * step} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" />
                <path d={bar(x, y(d.rows_received), bw, y(0))} className="bar-1" />
                {d.rows_quarantined > 0 && <path d={bar(x + 2, y(d.rows_quarantined), bw - 4, y(0))} className="bar-2" />}
                {(days.length <= 10 || i % Math.ceil(days.length / 10) === 0) && <text x={x + bw / 2} y={H - 6} className="axis" textAnchor="middle">{d.day.slice(5)}</text>}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: `${((pad.l + hover * step + step / 2) / W) * 100}%` }}>
            <strong>{days[hover].day}</strong><br />{formatValue(days[hover].rows_received)} rows received<br />{formatValue(days[hover].rows_quarantined)} quarantined<br />{days[hover].batches} batches, {days[hover].untrusted} not trusted
          </div>
        )}
      </div>
      <details className="table-view"><summary>Show as table</summary>
        <table className="grid"><thead><tr><th>Day</th><th className="num">Batches</th><th className="num">Rows received</th><th className="num">Quarantined</th><th className="num">Failed</th><th className="num">Not trusted</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td>{d.day}</td><td className="num">{d.batches}</td><td className="num">{formatValue(d.rows_received)}</td><td className="num">{formatValue(d.rows_quarantined)}</td><td className="num">{d.failed}</td><td className="num">{d.untrusted}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

// Bar with 4px rounded top, square baseline.
function bar(x: number, top: number, w: number, base: number) {
  const h = base - top;
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}
