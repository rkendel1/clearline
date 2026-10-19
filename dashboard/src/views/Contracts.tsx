import { useState } from 'react';
import { api, type Me } from '../api';
import { useApi, Section, ErrorNote, Signal, Empty } from '../components';
import { when } from '../format';

export function Contracts({ tenant, me }: { tenant: string; me: Me }) {
  const versions = useApi<any[]>(`/api/v1/tenants/${tenant}/contracts`);
  const migrations = useApi<any[]>(`/api/v1/tenants/${tenant}/migrations`);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const isAdmin = me.role === 'admin';

  const act = async (id: number, action: 'approve' | 'reject', toVersion: string) => {
    try {
      if (action === 'approve') {
        const confirm = window.prompt(`Type the target version (${toVersion}) to approve and apply migration ${id}.`);
        if (confirm === null) return;
        await api(`/api/v1/tenants/${tenant}/migrations/${id}/approve`, { method: 'POST', body: JSON.stringify({ confirm_version: confirm }) });
        setMsg({ tone: 'good', text: `Migration ${id} applied; ${toVersion} is now active.` });
      } else {
        const reason = window.prompt('Reason for rejecting this migration?');
        if (!reason) return;
        await api(`/api/v1/tenants/${tenant}/migrations/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
        setMsg({ tone: 'good', text: `Migration ${id} rejected.` });
      }
    } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); }
    void versions.reload(); void migrations.reload();
  };

  return (
    <>
      <div className="page-head"><div><h1>Contracts</h1><p className="lede">Versioned definitions of what {tenant}’s data means. Breaking changes wait for a second administrator’s approval; records keep the contract version that produced them.</p></div></div>
      {msg && <p className={`note note-${msg.tone}`} role="status">{msg.text}</p>}
      <ErrorNote error={versions.error ?? migrations.error} />
      {versions.data && (
        <Section id="versions" title="Versions">
          <table className="grid"><thead><tr><th>Version</th><th>Lifecycle</th><th>Transform version</th><th>Published by</th><th>Created</th><th>Activated</th></tr></thead>
            <tbody>{versions.data.map((v) => <tr key={v.id}><td>{v.version}</td><td>{v.lifecycle === 'active' ? <Signal tone="good" label="Active" /> : v.lifecycle === 'pending_approval' ? <Signal tone="warn" label="Awaiting approval" /> : v.lifecycle.replace('_', ' ')}</td>
              <td className="small">{v.transform_version}</td><td>{v.created_by}</td><td>{when(v.created_at)}</td><td>{when(v.activated_at)}</td></tr>)}</tbody></table>
        </Section>
      )}
      {migrations.data && (
        <Section id="migrations" title="Migration plans" description="Each plan lists every change with its classification, the exact DDL, data operations, impact and rollback path.">
          {migrations.data.length === 0 ? <Empty>No migrations.</Empty> : migrations.data.map((m) => (
            <article key={m.id} className="plan" data-migration={m.id}>
              <header>
                <h3>Migration {m.id}: {m.from_version ?? 'none'} to {m.to_version}</h3>
                <p>{m.status === 'planned' ? <Signal tone="warn" label="Awaiting approval" /> : m.status === 'applied' ? <Signal tone="good" label="Applied" /> : <Signal tone={m.status === 'failed' ? 'bad' : 'idle'} label={m.status.replace('_', ' ')} />}
                  <span className="muted"> {m.classification.replace('_', ' ')}; requested by {m.requested_by} {when(m.requested_at)}{m.approved_by ? `; approved by ${m.approved_by}` : ''}{m.error ? `; ${m.error}` : ''}</span></p>
                {m.status === 'planned' && isAdmin && <div className="actions"><button className="btn" onClick={() => act(m.id, 'approve', m.to_version)}>Approve and apply</button><button className="btn btn-quiet" onClick={() => act(m.id, 'reject', m.to_version)}>Reject</button></div>}
              </header>
              <table className="grid"><thead><tr><th>Change</th><th>Classification</th><th>What happens</th></tr></thead>
                <tbody>{m.plan.changes.map((c: any, i: number) => <tr key={i} className={c.classification === 'breaking' ? 'row-warn' : ''}><td>{c.entity ? `${c.entity}${c.field ? '.' + c.field : ''}: ` : ''}{c.description}</td><td>{c.classification}</td><td className="prose">{c.action}</td></tr>)}</tbody></table>
              {m.plan.impact && <p className="muted">Impact: {Object.entries(m.plan.impact).map(([en, x]: any) => `${en} ${x.current_rows} current rows${x.affected_rows !== undefined ? `, ${x.affected_rows} get new versions` : ''}`).join('; ')}</p>}
              <details><summary>DDL ({m.plan.ddl.length}) and data operations ({m.plan.data_ops.length})</summary>
                <pre className="code">{[...m.plan.ddl, ...m.plan.data_ops.map((d: any) => `-- ${d.type} ${d.entity}.${d.field}: ${d.backfill_value ?? JSON.stringify(d.value_map)}`)].join(';\n\n')}</pre></details>
              <details><summary>Rollback</summary><ul>{m.plan.rollback.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></details>
              {m.plan.rejected_reasons?.length > 0 && <ul className="note note-bad">{m.plan.rejected_reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>}
            </article>
          ))}
        </Section>
      )}
    </>
  );
}
