import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useApi, Section, ErrorNote, PipelineSignal, TrustSignal, CheckSignal, Signal, Empty } from '../components';
import { when, shortId } from '../format';

export function Lineage({ tenant, onOpenBatch }: { tenant: string; onOpenBatch: (id: string) => void }) {
  const contract = useApi<any>(`/api/v1/tenants/${tenant}/contracts/active`);
  const entities = contract.data ? Object.keys(contract.data.document.entities) : [];
  const [entity, setEntity] = useState('');
  const [key, setKey] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const en = entity || entities[0] || '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    try { setData(await api(`/api/v1/tenants/${tenant}/lineage/${en}/${encodeURIComponent(key.trim())}`)); setError(null); }
    catch (err) { setError(err as ApiError); setData(null); }
  };

  return (
    <>
      <div className="page-head"><div><h1>Lineage</h1><p className="lede">Follow one record from its source row through every version, the batch and contract that produced it, reconciliation, the metrics it counts toward, and the extracts it appeared in.</p></div></div>
      <form className="form-row" onSubmit={submit}>
        <label>Entity <select value={en} onChange={(e) => setEntity(e.target.value)}>{entities.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Key <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. C000000005" /></label>
        <button className="btn" type="submit">Trace record</button>
      </form>
      <ErrorNote error={error ?? contract.error} />
      {data && (
        <>
          <p className="muted">Correction rule: {data.ordering.strategy}{data.ordering.order_by ? ` by ${data.ordering.order_by}` : ''}. Active contract {data.active_contract_version}.</p>
          {data.versions.length === 0 && <Empty>No accepted versions; see quarantined submissions below.</Empty>}
          <ol className="timeline">
            {data.versions.map((v: any) => (
              <li key={v.record_id} className={v.is_current ? 'current' : ''}>
                <header>
                  <h3>Record {v.record_id} {v.is_current ? <Signal tone="good" label="Current" /> : v.is_late ? <Signal tone="idle" label="Late, kept as history" /> : <Signal tone="idle" label="Superseded" />}</h3>
                  <p className="muted">Loaded {when(v.loaded_at)} under contract {v.contract_version}, transform {v.transform_version}{v.supersedes_record_id ? `, supersedes record ${v.supersedes_record_id}` : ''}{v.migration ? `, created by migration ${v.migration.id} approved by ${v.migration.approved_by ?? 'auto-applied'}` : ''}</p>
                </header>
                <div className="lineage-grid">
                  <div>
                    <h4>Source</h4>
                    <p>Batch <button className="link" onClick={() => onOpenBatch(v.batch.id)}>{shortId(v.batch.id)}</button> from {v.batch.source_id} ({v.batch.format}), arrived {when(v.batch.arrival_at)}</p>
                    <p><PipelineSignal status={v.batch.status} /> <TrustSignal status={v.batch.trust_status} reasons={v.batch.trust_reasons} /></p>
                    {v.source_row ? <>
                      <p>Row {v.source_row.row_number}, disposition {v.source_row.disposition}{v.source_row.payload_retained ? '' : ' (raw payload purged by retention)'}</p>
                      {v.source_row.mapped_columns && <table className="grid compact"><tbody>{Object.entries(v.source_row.mapped_columns).map(([k, val]) => <tr key={k}><th>{k}</th><td>{String(val ?? '')}</td></tr>)}</tbody></table>}
                    </> : <p className="muted">Created by a migration, not a source row.</p>}
                  </div>
                  <div>
                    <h4>Canonical values</h4>
                    <table className="grid compact"><tbody>{Object.entries(v.values).map(([k, val]) => <tr key={k}><th>{k}</th><td>{val === null ? <span className="muted">null</span> : String(val)}</td></tr>)}</tbody></table>
                  </div>
                  <div>
                    <h4>Reconciliation of its batch</h4>
                    <ul className="plain">{v.batch_reconciliation.map((r: any, i: number) => <li key={i}><CheckSignal status={r.status} /> {r.check_id}</li>)}</ul>
                    {v.is_current && <><h4>Metrics</h4><ul className="plain">{v.metric_contribution.map((m: any) => <li key={m.metric_id}>{m.included ? <Signal tone="good" label="Counted" /> : <Signal tone="idle" label="Not counted" />} {m.metric_id} <span className="muted">{m.reason}</span></li>)}</ul></>}
                    <h4>Extracts</h4>
                    {v.exports.length === 0 ? <p className="muted">Not yet exported.</p> : <ul className="plain">{v.exports.map((x: any) => <li key={x.id}>{x.extract_id} by {x.requested_by}, {when(x.created_at)} <span className="muted small">sha256 {x.content_sha256.slice(0, 12)}…</span></li>)}</ul>}
                    {v.duplicate_deliveries.length > 0 && <p className="muted">Delivered again {v.duplicate_deliveries.length} time(s) as an exact duplicate (no effect).</p>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {data.quarantined_submissions.length > 0 && (
            <Section id="lineage-q" title="Quarantined submissions of this key">
              <table className="grid"><thead><tr><th>Batch</th><th className="num">Row</th><th>Status</th><th>Reasons</th></tr></thead>
                <tbody>{data.quarantined_submissions.map((q: any) => <tr key={q.id}><td><button className="link" onClick={() => onOpenBatch(q.batch_id)}>{shortId(q.batch_id)}</button></td><td className="num">{q.row_number}</td><td>{q.status}</td><td className="prose">{q.errors.map((e: any) => e.message).join('; ')}</td></tr>)}</tbody></table>
            </Section>
          )}
        </>
      )}
    </>
  );
}
