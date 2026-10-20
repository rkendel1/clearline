import { useState } from 'react';
import { request, requestWithStatus, session, t } from '../lib/api';
import { when } from '../lib/format';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, Code, Confirm, ErrorBox, Facts, Field, Json, Note, Page, Section, Signal, Table, Tabs } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Contracts() {
  const [tab, setTab] = useState('versions');
  const versions = useLoad((s) => request<any[]>('GET', t('/contracts'), undefined, { signal: s }), []);
  const active = useLoad((s) => request<any>('GET', t('/contracts/active'), undefined, { signal: s }), []);
  const migrations = useLoad((s) => request<any[]>('GET', t('/migrations'), undefined, { signal: s }), []);
  const refresh = () => { versions.reload(); active.reload(); migrations.reload(); };
  return (
    <Page title="Contracts" sub="Each tenant's canonical model is declared in a versioned data contract. Breaking changes need approval." actions={<Button onClick={refresh}>Refresh</Button>}>
      <Tabs active={tab} onChange={setTab} tabs={[['versions', 'Versions'], ['active', 'Active contract'], ['migrations', 'Migrations'], ['publish', 'Validate / publish']]} />
      {tab === 'versions' && <Async load={versions}>{(v) => <Table rows={v} cols={[
        { head: 'Version', cell: (r) => r.version }, { head: 'State', cell: (r) => <Signal status={r.lifecycle} /> }, { head: 'Hash', cell: (r) => <span className="mono">{String(r.document_hash).slice(0, 12)}</span> },
        { head: 'Created by', cell: (r) => r.created_by }, { head: 'Created', cell: (r) => when(r.created_at) }, { head: 'Activated', cell: (r) => when(r.activated_at) }]} />}</Async>}
      {tab === 'active' && <Async load={active}>{(a) => (<>
        <Facts items={[['Version', a.version], ['Transform', <span className="mono">{a.transform_version}</span>]]} />
        {Object.entries(a.document.entities ?? {}).map(([name, e]: any) => (
          <Section key={name} title={name} hint={e.description}>
            <Facts items={[['Key', e.key?.join(', ')], ['Correction', e.correction?.strategy], ['Freshness', e.freshness ? `${e.freshness.max_age_hours} h` : 'not required']]} />
            <Table rows={Object.entries(e.fields)} cols={[{ head: 'Field', cell: ([f]: any) => f }, { head: 'Type', cell: ([, d]: any) => d.type }, { head: 'Sensitivity', cell: ([, d]: any) => d.sensitivity ?? 'internal' }, { head: 'Required', cell: ([, d]: any) => (d.required ? 'yes' : '') }, { head: 'Description', cell: ([, d]: any) => d.description ?? '' }]} />
            {e.rules?.length > 0 && <Json value={e.rules} label={`${e.rules.length} quality rules`} />}
          </Section>))}
        <Json value={a.document} label="Full document" />
      </>)}</Async>}
      {tab === 'migrations' && <Migrations load={migrations} onChange={refresh} />}
      {tab === 'publish' && <Publish onPublished={refresh} />}
    </Page>
  );
}

function Migrations({ load, onChange }: { load: ReturnType<typeof useLoad<any[]>>; onChange: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction(async (kind: 'approve' | 'reject' | 'rollback', m: any) => {
    const body = kind === 'approve' ? { confirm_version: m.to_version } : kind === 'reject' ? { reason: reason || 'rejected' } : {};
    await request('POST', t(`/migrations/${m.id}/${kind}`), body); onChange();
  });
  const canApprove = session.can('contract:approve');
  return (
    <Section hint="Approving requires the exact target version as confirmation (the button supplies it). The approver cannot be the requester.">
      <ErrorBox error={act.error} />
      {canApprove && <Field label="Reason (for rejection)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      <Async load={load}>{(rows) => <Table rows={rows} empty="No migrations." cols={[
        { head: 'Id', cell: (m) => String(m.id) }, { head: 'From → to', cell: (m) => `${m.from_version ?? '—'} → ${m.to_version}` }, { head: 'Class', cell: (m) => m.classification }, { head: 'Status', cell: (m) => <Signal status={m.status} /> },
        { head: 'Requested by', cell: (m) => m.requested_by }, { head: 'Approved by', cell: (m) => m.approved_by ?? '—' },
        { head: 'Plan', cell: (m) => <Json value={m.plan} label="plan" /> },
        { head: '', cell: (m) => canApprove && (m.status === 'planned' || m.status === 'applied') ? (
          <span className="row">
            {m.status === 'planned' && <><Confirm label="Approve" onConfirm={() => act.run('approve', m)} busy={act.busy} /><Confirm label="Reject" danger onConfirm={() => act.run('reject', m)} busy={act.busy} /></>}
            {m.status === 'applied' && <Confirm label="Roll back" danger onConfirm={() => act.run('rollback', m)} busy={act.busy} />}
          </span>) : null }]} />}</Async>
    </Section>
  );
}

function Publish({ onPublished }: { onPublished: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const parse = () => { try { setParseErr(null); return JSON.parse(text); } catch (e) { setParseErr(`Not valid JSON: ${(e as Error).message}`); return undefined; } };
  const validate = useAction(async () => { const b = parse(); if (b) setResult({ kind: 'validate', ...(await request<any>('POST', t('/contracts/validate'), b)) }); });
  const publish = useAction(async () => { const b = parse(); if (b) { const r = await requestWithStatus<any>('POST', t('/contracts'), b, [422]); setResult({ kind: 'publish', http: r.status, ...r.data }); onPublished(); } });
  return (
    <Section hint="Paste a contract document (JSON). Validate is a dry run that shows the migration plan; publish applies it, or queues it for approval when breaking.">
      <textarea className="sql" rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "contract": { ... } }' aria-label="Contract JSON" />
      {parseErr && <Note tone="bad">{parseErr}</Note>}
      <ErrorBox error={validate.error ?? publish.error} />
      <div className="row"><Button busy={validate.busy} disabled={!text.trim()} onClick={() => validate.run()}>Validate</Button>
        {session.can('contract:publish') && <Button primary busy={publish.busy} disabled={!text.trim()} onClick={() => publish.run()}>Publish</Button>}</div>
      {result && (result.kind === 'validate'
        ? (result.valid ? <Note tone="good">Valid. <Json open value={result.plan} label="Migration plan" /></Note> : <Note tone="bad">Invalid. <Json open value={result.issues} label="Issues" /></Note>)
        : <Note tone={result.http === 201 ? 'good' : result.http === 202 ? 'warn' : 'bad'}>
            {result.http === 201 ? 'Applied.' : result.http === 202 ? 'Breaking change: awaiting approval by an approver.' : 'Rejected.'} <Json open value={result} label="Response" /></Note>)}
      <Code>{'The formal schema is served at GET /api/v1/contract-schema.'}</Code>
    </Section>
  );
}
