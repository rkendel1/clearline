import { useMemo, useState } from 'react';
import { request, session, t, enc } from '../lib/api';
import { when } from '../lib/format';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, ErrorBox, Facts, Field, Json, Note, Page, Section, Signal, Table, Tabs } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const LEVELS = ['hidden', 'discover', 'filter', 'full'];

export function Fields() {
  const load = useLoad((s) => request<any>('GET', t('/fields/policies'), undefined, { signal: s }), []);
  const hist = useLoad((s) => request<any[]>('GET', t('/fields/policies/history?limit=100'), undefined, { signal: s }), []);
  const [tab, setTab] = useState('policies');
  const [sel, setSel] = useState<{ entity: string; field: string } | null>(null);
  return (
    <Page title="Field policies" sub="Who can see which fields, and how sensitive values are redacted. Changes are versioned and audited." actions={<Button onClick={() => { load.reload(); hist.reload(); }}>Refresh</Button>}>
      <Tabs active={tab} onChange={setTab} tabs={[['policies', 'Policies'], ['history', 'Change history']]} />
      {tab === 'policies' && <Async load={load}>{(d) => (
        <div className="split">
          <div className="list" role="listbox" aria-label="Fields">
            {d.entities.map((e: any) => (
              <div key={e.entity}>
                <button className={sel && sel.entity === e.entity && sel.field === '*' ? 'active' : ''} onClick={() => setSel({ entity: e.entity, field: '*' })}><strong>{e.entity}</strong><span className="muted small">table policy</span></button>
                {e.fields.map((f: any) => <button key={f.field} className={sel && sel.entity === e.entity && sel.field === f.field ? 'active' : ''} onClick={() => setSel({ entity: e.entity, field: f.field })}>
                  <span>{f.field} {f.policy.sensitive && <Signal status="warn" label="sensitive" />}</span><span className="muted small">{f.type} · {f.policy.redaction}</span></button>)}
              </div>))}
          </div>
          <div>{sel ? <Editor key={`${sel.entity}.${sel.field}`} data={d} sel={sel} onSaved={() => { load.reload(); hist.reload(); }} /> : <Note>Select a field to see its effective access by role.</Note>}</div>
        </div>)}</Async>}
      {tab === 'history' && <Async load={hist}>{(rows) => <Table rows={rows} empty="No changes." cols={[
        { head: 'When', cell: (r) => when(r.changed_at) }, { head: 'Field', cell: (r) => `${r.entity}.${r.field}` }, { head: 'v', num: true, cell: (r) => r.version }, { head: 'Change', cell: (r) => r.change_kind },
        { head: 'By', cell: (r) => `${r.changed_by} (${r.changed_role})` }, { head: 'Policy', cell: (r) => <Json value={{ policy: r.policy, previous: r.previous }} label="diff" /> }]} />}</Async>}
    </Page>
  );
}

function Editor({ data, sel, onSaved }: { data: any; sel: { entity: string; field: string }; onSaved: () => void }) {
  const ent = data.entities.find((e: any) => e.entity === sel.entity);
  const fld = sel.field === '*' ? null : ent.fields.find((f: any) => f.field === sel.field);
  const pol = fld ? fld.policy : ent.table_policy;
  const [sensitive, setSensitive] = useState<boolean>(pol.sensitive);
  const [redaction, setRedaction] = useState<string>(pol.redaction);
  const [unmask, setUnmask] = useState<string[]>(pol.unmask_roles ?? []);
  const [access, setAccess] = useState<Record<string, string>>(pol.role_access ?? {});
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<any>(null);
  const changed = useMemo(() => sensitive !== pol.sensitive || redaction !== pol.redaction || JSON.stringify([...unmask].sort()) !== JSON.stringify([...(pol.unmask_roles ?? [])].sort()) || JSON.stringify(access) !== JSON.stringify(pol.role_access ?? {}), [sensitive, redaction, unmask, access, pol]);
  const save = useAction(async () => {
    const patch: any = { reason };
    if (sensitive !== pol.sensitive) patch.sensitive = sensitive;
    if (redaction !== pol.redaction) patch.redaction = redaction;
    patch.unmask_roles = unmask; patch.role_access = access;
    setResult(await request('POST', t(`/fields/${enc(sel.entity)}/${enc(sel.field)}/policy`), patch)); onSaved();
  });
  const writable = session.can('policy:manage');
  const redactions: string[] = fld?.allowed_redactions?.length ? fld.allowed_redactions : ['full', 'partial', 'hash', 'none'];
  return (
    <Section title={`${sel.entity}${fld ? '.' + fld.field : ' (table)'}`} hint={fld?.description}>
      <Facts items={[['Contract sensitivity', fld?.contract_sensitivity ?? '—'], ['Policy version', `v${pol.version} (${pol.source})`], ['Last changed', `${pol.updated_by ?? '—'} ${when(pol.updated_at)}`]]} />
      <h3>Effective access by role</h3>
      <Table rows={Object.entries(fld?.effective_access ?? {})} cols={[{ head: 'Role', cell: ([r]: any) => r }, { head: 'Access', cell: ([, l]: any) => <Signal status={l} /> }]} empty="Table policy applies to all fields." />
      <h3>Change policy</h3>
      <div className="form-grid">
        <Field label="Sensitive"><select disabled={!writable} value={String(sensitive)} onChange={(e) => setSensitive(e.target.value === 'true')}><option value="true">sensitive</option><option value="false">not sensitive</option></select></Field>
        <Field label="Redaction"><select disabled={!writable} value={redaction} onChange={(e) => setRedaction(e.target.value)}>{redactions.map((r) => <option key={r}>{r}</option>)}</select></Field>
      </div>
      <h3>Role access</h3>
      <div className="form-grid">{data.roles.map((r: string) => (
        <Field key={r} label={r}><select disabled={!writable} value={access[r] ?? 'full'} onChange={(e) => setAccess((a) => { const n = { ...a }; if (e.target.value === 'full') delete n[r]; else n[r] = e.target.value; return n; })}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select></Field>))}</div>
      <h3>May see sensitive values unmasked</h3>
      <div className="row">{data.roles.map((r: string) => <label key={r} className="row"><input type="checkbox" disabled={!writable} checked={unmask.includes(r)} onChange={(e) => setUnmask((u) => (e.target.checked ? [...u, r] : u.filter((x) => x !== r)))} /> {r}</label>)}</div>
      {writable && <><Field label="Reason (recorded in the audit trail)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={save.error} />
        <div><Button primary busy={save.busy} disabled={!changed || !reason.trim()} onClick={() => save.run()}>Apply change</Button></div></>}
      {!writable && <Note>Your role can view policies but not change them.</Note>}
      {result && <Note tone={result.change?.kind === 'loosening' ? 'warn' : 'good'}>Applied ({result.change?.kind}). {result.change?.loosening?.length ? `Loosened: ${result.change.loosening.join('; ')}. ` : ''}{result.change?.tightening?.length ? `Tightened: ${result.change.tightening.join('; ')}.` : ''}</Note>}
    </Section>
  );
}
