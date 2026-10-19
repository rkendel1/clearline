import { useState } from 'react';
import { api, type Me } from '../api';
import { useApi, Section, ErrorNote, TrustSignal, Empty } from '../components';
import { when, shortId } from '../format';

export function Exceptions({ tenant, me, onOpenBatch }: { tenant: string; me: Me; onOpenBatch: (id: string) => void }) {
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const r = useApi<any>(`/api/v1/tenants/${tenant}/reports/exceptions?status=${status}`);
  const d = r.data;
  const canResolve = me.role === 'admin' || me.role === 'operator';
  const resolve = async (id: number) => {
    const resolution = window.prompt('How was this resolved? The record is not admitted; the sender must resend corrected data.');
    if (!resolution) return;
    await api(`/api/v1/tenants/${tenant}/quarantine/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) });
    void r.reload();
  };
  return (
    <>
      <div className="page-head"><div><h1>Exceptions</h1><p className="lede">Records held out of trusted data, references to records that have not arrived, late deliveries, and batches that need a decision.</p></div></div>
      <ErrorNote error={r.error} />
      {d && (
        <>
          <Section id="review" title="Batches needing review">
            {d.batches_requiring_review.length === 0 ? <Empty>Nothing to review: every processed batch is trusted.</Empty> : (
              <table className="grid"><thead><tr><th>Batch</th><th>Source</th><th>Arrived</th><th>Trust</th><th>Why</th></tr></thead>
                <tbody>{d.batches_requiring_review.map((b: any) => (
                  <tr key={b.id}><td><button className="link" onClick={() => onOpenBatch(b.id)}>{shortId(b.id)}</button></td><td>{b.source_id}</td><td>{when(b.arrival_at)}</td>
                    <td><TrustSignal status={b.trust_status} /></td><td className="prose">{b.status === 'failed' ? 'Processing failed. ' : ''}{(b.trust_reasons ?? []).join('; ')}</td></tr>))}</tbody></table>
            )}
          </Section>

          <Section id="quarantine" title="Quarantined records" actions={
            <label className="inline">Show <select value={status} onChange={(e) => setStatus(e.target.value as never)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select></label>}>
            <p className="muted">{d.summary.map((s: any) => `${s.n} ${s.status} ${s.category.replace('_', ' ')}`).join(', ') || 'No quarantined records.'}</p>
            {d.quarantined.length === 0 ? <Empty>No {status === 'all' ? '' : status} quarantined records.</Empty> : (
              <div className="scroll-x"><table className="grid"><thead><tr><th>Batch</th><th>Source</th><th className="num">Row</th><th>Key</th><th>Category</th><th>Reasons</th><th></th></tr></thead>
                <tbody>{d.quarantined.map((q: any) => (
                  <tr key={q.id}><td><button className="link" onClick={() => onOpenBatch(q.batch_id)}>{shortId(q.batch_id)}</button></td><td>{q.source_id}</td><td className="num">{q.source_row}</td>
                    <td>{q.record_key ?? '—'}</td><td>{q.category.replace('_', ' ')}</td>
                    <td className="prose">{q.reasons.map((x: any, i: number) => <div key={i}><span className="muted">{x.rule_id}</span> {x.message}</div>)}</td>
                    <td>{q.status === 'open' && canResolve ? <button className="btn btn-small" onClick={() => resolve(q.id)}>Mark resolved</button> : q.resolution ?? ''}</td></tr>))}</tbody></table></div>
            )}
          </Section>

          <Section id="orphans" title="References to records not yet received" description="Admitted with a warning; they clear once the referenced records arrive.">
            {d.orphaned_references.length === 0 ? <Empty>Every reference resolves.</Empty> : (
              <table className="grid"><thead><tr><th>Entity</th><th>Key</th><th>Missing</th><th>Batch</th></tr></thead>
                <tbody>{d.orphaned_references.map((o: any) => <tr key={`${o.entity}-${o.record_id}`}><td>{o.entity}</td><td>{o.key}</td><td>{o.references} {o.missing_reference}</td><td><button className="link" onClick={() => onOpenBatch(o.batch_id)}>{shortId(o.batch_id)}</button></td></tr>)}</tbody></table>
            )}
          </Section>

          <Section id="late" title="Late arrivals" description="Versions older than the current one are kept as history and do not change current results.">
            {d.late_records.length === 0 && d.late_batches.length === 0 ? <Empty>No late data.</Empty> : (
              <table className="grid"><thead><tr><th>Entity</th><th>Key</th><th>Loaded</th><th>Batch</th></tr></thead>
                <tbody>{d.late_records.map((l: any) => <tr key={`${l.entity}-${l.record_id}`}><td>{l.entity}</td><td>{l.key}</td><td>{when(l.loaded_at)}</td><td><button className="link" onClick={() => onOpenBatch(l.batch_id)}>{shortId(l.batch_id)}</button></td></tr>)}</tbody></table>
            )}
          </Section>
        </>
      )}
    </>
  );
}
