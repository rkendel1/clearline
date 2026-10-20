import { useState } from 'react';
import { request, session, t } from '../lib/api';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, ErrorBox, Field, Json, Note, Page, Section, Signal, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const KINDS = ['in_app', 'email', 'webhook', 'export'];
const NOTIFY = ['always', 'success', 'failure', 'anomaly'];

export function Destinations() {
  const load = useLoad((s) => request<any>('GET', t('/analytics/destinations'), undefined, { signal: s }), []);
  const [f, setF] = useState({ name: '', kind: 'in_app', target: '', secret_ref: '', notify_on: 'always', with_csv: false, max_attempts: '5' });
  const [tests, setTests] = useState<Record<string, any>>({});
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const create = useAction(async () => {
    const config: any = f.kind === 'email' ? { to: f.target.split(',').map((x) => x.trim()).filter(Boolean) } : f.kind === 'webhook' ? { url: f.target, ...(f.secret_ref ? { secret_ref: f.secret_ref } : {}) } : f.kind === 'export' ? { label: f.target || 'export' } : {};
    await request('POST', t('/analytics/destinations'), { name: f.name, kind: f.kind, config, content: f.with_csv ? 'summary_with_csv' : 'summary', notify_on: f.notify_on, max_attempts: Number(f.max_attempts) || 5 });
    setF({ ...f, name: '', target: '', secret_ref: '' }); load.reload();
  });
  const test = useAction(async (id: string) => { const r = await request<any>('POST', t(`/analytics/destinations/${id}/test`), {}); setTests((x) => ({ ...x, [id]: r })); });
  const toggle = useAction(async (d: any) => { await request('POST', t(`/analytics/destinations/${d.id}`), { name: d.name, kind: d.kind, config: d.config, content: d.content, notify_on: d.notify_on, max_attempts: d.max_attempts, enabled: !d.enabled }); load.reload(); });
  const manage = session.can('delivery:manage');
  return (
    <Page title="Delivery destinations" sub="Where scheduled results go. Secrets are references: only their presence is shown." actions={<Button onClick={load.reload}>Refresh</Button>}>
      <ErrorBox error={test.error ?? toggle.error} />
      <Async load={load}>{(d) => <Section><Table rows={d.items} empty="No destinations yet." cols={[
        { head: 'Name', cell: (x: any) => x.name }, { head: 'Kind', cell: (x: any) => x.kind }, { head: 'Notify on', cell: (x: any) => x.notify_on }, { head: 'Content', cell: (x: any) => x.content },
        { head: 'State', cell: (x: any) => <Signal status={x.enabled ? 'enabled' : 'disabled'} /> }, { head: 'Config', cell: (x: any) => <Json value={{ config: x.config, secrets: x.secrets }} label="config" /> },
        { head: 'Test', cell: (x: any) => <span className="row"><Button busy={test.busy} onClick={() => test.run(x.id)}>Send test</Button>{tests[x.id] && <Signal status={tests[x.id].ok ? 'ok' : 'failed'} label={tests[x.id].ok ? 'delivered' : tests[x.id].message ?? tests[x.id].code} />}</span> },
        { head: '', cell: (x: any) => manage && <Button busy={toggle.busy} onClick={() => toggle.run(x)}>{x.enabled ? 'Disable' : 'Enable'}</Button> }]} /></Section>}</Async>
      {manage ? (
        <Section title="Add a destination" hint="Webhook URLs are checked server-side (no private addresses). Email recipients are comma-separated.">
          <div className="form-grid">
            <Field label="Name"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Kind"><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            {(f.kind === 'email' || f.kind === 'webhook' || f.kind === 'export') && <Field label={f.kind === 'email' ? 'Recipients' : f.kind === 'webhook' ? 'URL' : 'Label'}><input value={f.target} onChange={(e) => set('target', e.target.value)} /></Field>}
            {f.kind === 'webhook' && <Field label="Signing secret reference" hint="name of a secret held by the server, never the secret itself"><input value={f.secret_ref} onChange={(e) => set('secret_ref', e.target.value)} /></Field>}
            <Field label="Notify on"><select value={f.notify_on} onChange={(e) => set('notify_on', e.target.value)}>{NOTIFY.map((k) => <option key={k}>{k}</option>)}</select></Field>
            <Field label="Max attempts"><input inputMode="numeric" value={f.max_attempts} onChange={(e) => set('max_attempts', e.target.value)} /></Field>
          </div>
          <label className="row"><input type="checkbox" checked={f.with_csv} onChange={(e) => set('with_csv', e.target.checked)} /> Include a CSV of the bounded result (re-authorized for each viewer)</label>
          <ErrorBox error={create.error} />
          <div><Button primary busy={create.busy} disabled={!f.name.trim()} onClick={() => create.run()}>Create destination</Button></div>
        </Section>) : <Note>Your role can use destinations but not create them.</Note>}
    </Page>
  );
}
