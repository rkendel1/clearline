import { useState } from 'react';
import { request, t, qs } from '../lib/api';
import { when } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { Async, Button, Field, Json, Page, Section, Signal, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Audit() {
  const [action, setAction] = useState('');
  const [corr, setCorr] = useState('');
  const [applied, setApplied] = useState({ action: '', corr: '' });
  const load = useLoad((s) => request<any[]>('GET', t(`/audit${qs({ action: applied.action, correlation_id: applied.corr, limit: 300 })}`), undefined, { signal: s }), [applied]);
  return (
    <Page title="Audit trail" sub="Append-only record of access, decisions and administrative changes." actions={<Button onClick={load.reload}>Refresh</Button>}>
      <Section><form className="row" onSubmit={(e) => { e.preventDefault(); setApplied({ action, corr }); }}>
        <Field label="Action prefix"><input value={action} placeholder="e.g. policy." onChange={(e) => setAction(e.target.value)} /></Field>
        <Field label="Correlation id (e.g. a run id)"><input value={corr} onChange={(e) => setCorr(e.target.value)} /></Field>
        <Button type="submit" primary>Filter</Button></form></Section>
      <Async load={load}>{(rows) => <Table rows={rows} empty="No events." cols={[
        { head: 'When', cell: (e) => when(e.at) }, { head: 'Actor', cell: (e) => <>{e.actor}{e.role && <span className="muted"> ({e.role})</span>}</> }, { head: 'Action', cell: (e) => <span className="mono">{e.action}</span> },
        { head: 'Resource', cell: (e) => e.resource ?? '' }, { head: 'Outcome', cell: (e) => <Signal status={e.outcome} /> }, { head: 'Details', cell: (e) => <Json value={e.details} label="details" /> }]} />}</Async>
    </Page>
  );
}
