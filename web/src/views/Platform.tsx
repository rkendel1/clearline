import { useState } from 'react';
import { request, enc } from '../lib/api';
import { useAction } from '../lib/useLoad';
import { Button, Code, ErrorBox, Field, Note, Page, Section } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Platform() {
  const [id, setId] = useState(''); const [name, setName] = useState('');
  const [tenant, setTenant] = useState(''); const [tname, setTname] = useState(''); const [role, setRole] = useState('admin');
  const [out, setOut] = useState<any>(null);
  const create = useAction(async () => { setOut(await request('POST', '/api/v1/tenants', { id, name })); });
  const issue = useAction(async () => { setOut(await request('POST', `/api/v1/tenants/${enc(tenant)}/tokens`, { name: tname, role })); });
  return (
    <Page title="Platform" sub="Platform administrators create tenants and issue each tenant's first tokens. They never see tenant data.">
      <Section title="Create a tenant"><div className="row">
        <Field label="Id"><input value={id} onChange={(e) => setId(e.target.value)} placeholder="lowercase-id" /></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Button primary busy={create.busy} disabled={!id || !name} onClick={() => create.run()}>Create</Button></div><ErrorBox error={create.error} /></Section>
      <Section title="Issue a first token"><div className="row">
        <Field label="Tenant id"><input value={tenant} onChange={(e) => setTenant(e.target.value)} /></Field>
        <Field label="Token name"><input value={tname} onChange={(e) => setTname(e.target.value)} /></Field>
        <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}><option>admin</option><option>approver</option></select></Field>
        <Button primary busy={issue.busy} disabled={!tenant || !tname} onClick={() => issue.run()}>Issue</Button></div><ErrorBox error={issue.error} /></Section>
      {out && <Note tone="warn"><strong>Result (a token is shown only once):</strong><Code>{JSON.stringify(out, null, 2)}</Code></Note>}
    </Page>
  );
}
