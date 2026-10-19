import { useState } from 'react';
import { api, type Me } from '../api';
import { useApi, Section, ErrorNote, PipelineSignal, TrustSignal, CheckSignal, Json, Signal, Empty } from '../components';
import { formatValue, when } from '../format';

export function BatchDetail({ tenant, id, me, onBack }: { tenant: string; id: string; me: Me; onBack: () => void }) {
  const b = useApi<any>(`/api/v1/tenants/${tenant}/batches/${id}`);
  const canSeeFindings = me.role === 'admin' || me.role === 'operator';
  const [rule, setRule] = useState<string | null>(null);
  const findings = useApi<any[]>(canSeeFindings && rule ? `/api/v1/tenants/${tenant}/batches/${id}/findings?rule_id=${encodeURIComponent(rule)}&limit=200` : null);
  const [replayMsg, setReplayMsg] = useState<string | null>(null);
  const d = b.data;

  const replay = async () => {
    try { await api(`/api/v1/tenants/${tenant}/batches/${id}/replay`, { method: 'POST', body: '{}' }); setReplayMsg('Batch re-queued. A worker will pick it up shortly.'); void b.reload(); }
    catch (e) { setReplayMsg((e as Error).message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <button className="link back" onClick={onBack}>Back to overview</button>
          <h1>Batch {id.slice(0, 8)}</h1>
          <p className="muted small">{id}</p>
          {d && <p className="verdict"><PipelineSignal status={d.status} /> <TrustSignal status={d.trust_status} reasons={d.trust_reasons} /> {d.trust_reasons?.length ? <span>{d.trust_reasons.join('; ')}</span> : null}</p>}
        </div>
        {d?.status === 'failed' && me.role !== 'reporter' && <button className="btn" onClick={replay}>Replay batch</button>}
      </div>
      {replayMsg && <p className="note">{replayMsg}</p>}
      <ErrorNote error={b.error} />
      {d && (
        <>
          <Section id="provenance" title="Provenance">
            <dl className="facts">
              <Fact k="Source" v={`${d.source_id} (${d.format})`} /><Fact k="Entity" v={d.entity} />
              <Fact k="Contract version" v={d.contract_version} /><Fact k="Transform version" v={d.transform_version} />
              <Fact k="Payload SHA-256" v={<code>{d.payload_digest}</code>} /><Fact k="Size" v={`${formatValue(d.byte_size)} bytes`} />
              <Fact k="Arrived" v={when(d.arrival_at)} /><Fact k="Source-reported time" v={when(d.source_reported_at)} />
              <Fact k="Started" v={when(d.started_at)} /><Fact k="Completed" v={when(d.completed_at)} />
              <Fact k="Submitted by" v={d.submitted_by} /><Fact k="Processing run" v={d.processing_run_id ?? '—'} />
              <Fact k="Control totals" v={<Json value={d.control} />} /><Fact k="Late delivery" v={d.is_late ? 'Yes' : 'No'} />
            </dl>
            {d.structural_rejection && <p className="note note-bad">Rejected before processing: {d.structural_rejection.message}</p>}
            {d.failure && <p className="note note-bad">Failure on attempt {d.failure.attempt}: {d.failure.message}</p>}
          </Section>

          <Section id="counts" title="Record dispositions" description="Every received row has exactly one disposition.">
            <dl className="tally">
              {[['Received', d.received_count], ['Accepted', d.accepted_count], ['Quarantined', d.quarantined_count], ['Exact duplicates', d.duplicate_count],
                ['Late (kept as history)', d.late_record_count], ['Corrections', d.correction_count], ['Conflicts', d.conflict_count], ['Warnings', d.warning_count]].map(([k, v]) => (
                <div className="tally-item" key={k as string}><dt>{k}</dt><dd>{formatValue(v as number)}</dd></div>))}
            </dl>
          </Section>

          <Section id="recon" title="Reconciliation" description={`Expected versus actual, with the difference explained. Processing run ${d.processing_run_id ?? '—'}.`}>
            {d.reconciliation.length === 0 ? <Empty>Reconciliation runs when the batch is processed.</Empty> : (
              <div className="scroll-x"><table className="grid">
                <thead><tr><th>Check</th><th>Result</th><th>Expected</th><th>Actual</th><th>Difference</th><th>Explanation</th></tr></thead>
                <tbody>{d.reconciliation.map((r: any, i: number) => (
                  <tr key={i} data-check={r.check_id} className={r.status === 'failed' ? 'row-bad' : ''}>
                    <td>{r.check_id}{r.run_id !== d.processing_run_id && <div className="muted small">{r.run_id.startsWith('reverify') ? 'post-load re-verification' : r.run_id}</div>}</td><td><CheckSignal status={r.status} /></td>
                    <td><Json value={r.expected} /></td><td><Json value={r.actual} /></td><td><Json value={r.difference} /></td><td className="prose">{r.explanation}</td>
                  </tr>))}</tbody>
              </table></div>
            )}
          </Section>

          <Section id="quality" title="Quality results" description={canSeeFindings ? 'Select a rule with failures to list the affected source rows.' : 'Per-record findings are visible to operators and administrators.'}>
            <div className="scroll-x"><table className="grid">
              <thead><tr><th>Rule</th><th>Category</th><th>Severity</th><th className="num">Evaluated</th><th className="num">Failed</th><th>Description</th><th>Contract</th></tr></thead>
              <tbody>{d.quality_results.map((q: any) => (
                <tr key={`${q.rule_id}-${q.attempt}`} className={q.failed_count && q.severity === 'error' ? 'row-bad' : ''}>
                  <td>{q.failed_count && canSeeFindings ? <button className="link" onClick={() => setRule(q.rule_id)}>{q.rule_id}</button> : q.rule_id}</td>
                  <td>{q.category}</td><td>{q.severity}</td><td className="num">{formatValue(q.evaluated_count)}</td>
                  <td className="num">{q.failed_count ? <strong>{formatValue(q.failed_count)}</strong> : 0}</td><td className="prose">{q.description}</td><td>{q.contract_version}</td>
                </tr>))}</tbody>
            </table></div>
            {rule && (
              <div className="subpanel">
                <h3>Rows failing {rule}</h3>
                <ErrorNote error={findings.error} />
                {findings.data && (findings.data.length === 0 ? <Empty>No findings.</Empty> : (
                  <table className="grid"><thead><tr><th className="num">Source row</th><th>Field</th><th>Severity</th><th>Reason</th></tr></thead>
                    <tbody>{findings.data.map((f, i) => <tr key={i}><td className="num">{f.source_row}</td><td>{f.field ?? '—'}</td><td>{f.severity}</td><td className="prose">{f.message}</td></tr>)}</tbody></table>))}
              </div>
            )}
          </Section>

          <Section id="attempts" title="Attempts and submissions">
            <table className="grid">
              <thead><tr><th className="num">Attempt</th><th>Worker</th><th>Started</th><th>Ended</th><th>Outcome</th><th>Error</th></tr></thead>
              <tbody>{d.attempts.map((a: any) => (
                <tr key={a.attempt}><td className="num">{a.attempt}</td><td className="small">{a.worker_id}</td><td>{when(a.started_at)}</td><td>{when(a.ended_at)}</td>
                  <td>{a.outcome === 'succeeded' ? <Signal tone="good" label="Succeeded" /> : a.outcome === 'running' ? <Signal tone="idle" label="Running" /> : <Signal tone="bad" label={a.outcome} />}</td>
                  <td className="prose">{a.error?.message ?? ''}</td></tr>))}</tbody>
            </table>
            <table className="grid">
              <thead><tr><th>Submission</th><th>By</th><th>At</th><th>Correlation id</th></tr></thead>
              <tbody>{d.submissions.map((s: any, i: number) => <tr key={i}><td>{s.outcome === 'duplicate' ? 'Duplicate (no effect)' : s.outcome}</td><td>{s.submitted_by}</td><td>{when(s.submitted_at)}</td><td className="small">{s.correlation_id}</td></tr>)}</tbody>
            </table>
          </Section>
        </>
      )}
    </>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="fact"><dt>{k}</dt><dd>{v}</dd></div>;
}
