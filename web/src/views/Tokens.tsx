import { useState } from 'react';
import { request, session, t, enc } from '../lib/api';
import { when } from '../lib/format';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, Code, Confirm, ErrorBox, Field, Note, Page, Section, Signal, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Tokens() {
  const load = useLoad((s) => request<any[]>('GET', t('/tokens'), undefined, { signal: s }), []);
  const [name, setName] = useState('');
  const [role, setRole] = useState('operator');
  const [issued, setIssued] = useState<any>(null);
  const issue = useAction(async () => { setIssued(await request('POST', t('/tokens'), { name, role })); setName(''); load.reload(); });
  const revoke = useAction(async (n: string) => { await request('POST', t(`/tokens/${enc(n)}/revoke`), {}); load.reload(); });
  const roles = session.me?.role === 'platform_admin' ? ['admin', 'approver'] : ['admin', 'operator', 'reporter'];
  return (
    <Page title="API tokens" sub="Secrets are shown once, when issued. Revocation takes effect on the next request.">
      <Section title="Issue a token">
        <div className="row"><Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Button primary busy={issue.busy} disabled={!name.trim()} onClick={() => issue.run()}>Issue</Button></div>
        <ErrorBox error={issue.error ?? revoke.error} />
        {issued && <Note tone="warn"><strong>Copy this token now; it will not be shown again.</strong><Code>{String(issued.token ?? JSON.stringify(issued))}</Code></Note>}
      </Section>
      <Async load={load}>{(rows) => <Section title="Tokens"><Table rows={rows} cols={[
        { head: 'Name', cell: (r) => r.name }, { head: 'Role', cell: (r) => r.role }, { head: 'State', cell: (r) => <Signal status={r.revoked_at ? 'disabled' : 'active'} label={r.revoked_at ? 'revoked' : 'active'} /> },
        { head: 'Created', cell: (r) => when(r.created_at) }, { head: '', cell: (r) => !r.revoked_at && <Confirm danger label="Revoke" onConfirm={() => revoke.run(r.name)} busy={revoke.busy} /> }]} /></Section>}</Async>
    </Page>
  );
}
