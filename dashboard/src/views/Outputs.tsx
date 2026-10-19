import { useState } from 'react';
import { download, type Me } from '../api';
import { useApi, Section, ErrorNote, Empty } from '../components';

export function Extracts({ tenant, me }: { tenant: string; me: Me }) {
  const list = useApi<any[]>(`/api/v1/tenants/${tenant}/extracts`);
  const [msg, setMsg] = useState<string | null>(null);
  const [untrusted, setUntrusted] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const run = async (id: string) => {
    const q = new URLSearchParams();
    if (untrusted) q.set('include_untrusted', 'true');
    if (sensitive) q.set('include_sensitive', 'true');
    try {
      const r = await download(`/api/v1/tenants/${tenant}/extracts/${id}/csv?${q}`, `${tenant}_${id}.csv`);
      setMsg(`Downloaded ${r.rows} rows. SHA-256 ${r.sha256}. The export is recorded in the audit log.`);
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <>
      <div className="page-head"><div><h1>Extracts</h1><p className="lede">CSV extracts with explicit schemas. By default they contain trusted data only, with sensitive fields redacted. Every download is audited.</p></div></div>
      <ErrorNote error={list.error} />
      <div className="form-row">
        <label className="inline"><input type="checkbox" checked={untrusted} onChange={(e) => setUntrusted(e.target.checked)} /> Include untrusted batches</label>
        <label className="inline"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} /> Include sensitive fields{me.role !== 'admin' ? ' (administrators only; will be denied)' : ''}</label>
      </div>
      {msg && <p className="note" role="status">{msg}</p>}
      {list.data?.length === 0 && <Empty>The active contract declares no extracts.</Empty>}
      {list.data?.map((x) => (
        <Section key={x.extract_id} id={`x-${x.extract_id}`} title={x.title} actions={<button className="btn" onClick={() => run(x.extract_id)}>Download CSV</button>}>
          <p className="muted">Entity {x.entity}; ordered by {x.ordering}; filterable by {x.filterable.join(', ') || 'nothing'}; contract {x.contract_version}.</p>
          <div className="scroll-x"><table className="grid compact"><thead><tr><th>Column</th><th>Type</th><th>Sensitivity</th><th>Description</th></tr></thead>
            <tbody>{x.columns.map((c: any) => <tr key={c.name}><td>{c.name}</td><td>{c.type}</td><td>{c.sensitivity ?? ''}{c.redacted_by_default ? ' (redacted by default)' : ''}</td><td className="prose">{c.description ?? ''}</td></tr>)}</tbody></table></div>
        </Section>
      ))}
    </>
  );
}

export function Definitions({ tenant }: { tenant: string }) {
  const d = useApi<any>(`/api/v1/tenants/${tenant}/metrics/definitions`);
  return (
    <>
      <div className="page-head"><div><h1>Metric definitions</h1><p className="lede">What every number on this dashboard means, where it comes from, and when it refreshes.</p></div></div>
      <ErrorNote error={d.error} />
      {d.data && (
        <>
          <Section id="declared" title={`Declared by contract ${d.data.contract_version}`}>
            <div className="scroll-x"><table className="grid"><thead><tr><th>Metric</th><th>Definition</th><th>Aggregation</th><th>Filter</th><th>Trust scope</th><th>Refresh</th></tr></thead>
              <tbody>{d.data.declared.map((m: any) => <tr key={m.id}><td><strong>{m.title}</strong><div className="muted small">{m.id}</div></td><td className="prose">{m.description}</td>
                <td>{m.aggregation}{m.field ? `(${m.entity}.${m.field})` : ` of ${m.entity}`}</td><td className="small"><code>{m.filter ? JSON.stringify(m.filter) : 'none'}</code></td><td className="prose">{m.trust_scope}</td><td className="prose">{m.refresh}</td></tr>)}</tbody></table></div>
          </Section>
          <Section id="platform" title="Operational metrics">
            <div className="scroll-x"><table className="grid"><thead><tr><th>Metric</th><th>Definition</th><th>Source</th><th>Filters</th><th>Aggregation</th><th>Refresh</th></tr></thead>
              <tbody>{d.data.platform.map((m: any) => <tr key={m.id}><td><strong>{m.id}</strong></td><td className="prose">{m.definition}</td><td className="small">{m.source}</td><td className="small">{m.filters}</td><td className="small">{m.aggregation}</td><td>{m.refresh}</td></tr>)}</tbody></table></div>
          </Section>
        </>
      )}
    </>
  );
}
