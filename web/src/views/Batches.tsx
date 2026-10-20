import { useState } from 'react';
import { request, t, enc, qs } from '../lib/api';
import { count, short, when } from '../lib/format';
import { href, go } from '../lib/router';
import { useAction, useLoad } from '../lib/useLoad';
import { session } from '../lib/api';
import { Async, Button, ErrorBox, Facts, Json, Note, Page, Section, Signal, Table, Tag } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Batches({ id }: { id?: string }) { return id ? <Detail id={id} /> : <List />; }

function List() {
  const [status, setStatus] = useState('');
  const load = useLoad((s) => request<any[]>('GET', t(`/batches${qs({ status, limit: 200 })}`), undefined, { signal: s }), [status]);
  return (
    <Page title="Batches" sub="Newest first. A batch that ran is not necessarily a batch that can be trusted." actions={<>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="">All statuses</option>{['queued', 'processing', 'completed', 'completed_with_exceptions', 'failed', 'rejected'].map((s) => <option key={s}>{s}</option>)}
      </select><Button onClick={load.reload}>Refresh</Button></>}>
      <Async load={load}>{(rows) => (
        <Table rows={rows} onRow={(r) => go('batches', r.id)} empty="No batches." cols={[
          { head: 'Batch', cell: (r) => <a href={href('batches', r.id)}>{short(r.id)}</a> }, { head: 'Source', cell: (r) => r.source_id }, { head: 'Entity', cell: (r) => r.entity }, { head: 'Contract', cell: (r) => r.contract_version },
          { head: 'Status', cell: (r) => <Signal status={r.status} /> }, { head: 'Trust', cell: (r) => <Signal status={r.trust_status} /> },
          { head: 'Received', num: true, cell: (r) => count(r.received_count) }, { head: 'Accepted', num: true, cell: (r) => count(r.accepted_count) }, { head: 'Quarantined', num: true, cell: (r) => count(r.quarantined_count) },
          { head: 'Arrived', cell: (r) => <>{when(r.arrival_at)}{r.is_late && <> <Tag>late</Tag></>}</> }]} />)}</Async>
    </Page>
  );
}

function Detail({ id }: { id: string }) {
  const load = useLoad((s) => request<any>('GET', t(`/batches/${enc(id)}`), undefined, { signal: s }), [id]);
  const findings = useLoad((s) => (session.can('quarantine:read') ? request<any[]>('GET', t(`/batches/${enc(id)}/findings?limit=500`), undefined, { signal: s }) : Promise.resolve([])), [id]);
  const replay = useAction(async () => { await request('POST', t(`/batches/${enc(id)}/replay`), {}); load.reload(); });
  return (
    <Page title={`Batch ${short(id)}`} sub={<a href="#/batches">← All batches</a>} actions={<>
      {load.data?.status === 'failed' && session.can('batch:replay') && <Button primary busy={replay.busy} onClick={() => replay.run()}>Replay</Button>}
      <Button onClick={() => { load.reload(); findings.reload(); }}>Refresh</Button></>}>
      <ErrorBox error={replay.error} />
      <Async load={load}>{(b) => (<>
        <Note tone={b.trust_status === 'trusted' ? 'good' : 'warn'}><Signal status={b.trust_status} /> {b.trust_reasons?.length ? b.trust_reasons.join('; ') : b.trust_status === 'trusted' ? 'All quality and reconciliation checks passed.' : 'Not trusted.'}</Note>
        <Section title="Provenance"><Facts items={[
          ['Source', b.source_id], ['Entity', b.entity], ['Format', b.format], ['Status', <Signal status={b.status} />], ['Contract version', b.contract_version], ['Transform version', <span className="mono">{b.transform_version}</span>],
          ['Payload digest', <span className="mono">{b.payload_digest}</span>], ['Submitted by', b.submitted_by], ['Arrived', when(b.arrival_at)], ['Completed', when(b.completed_at)],
          ['Received', count(b.received_count)], ['Accepted', count(b.accepted_count)], ['Quarantined', count(b.quarantined_count)], ['Duplicates', count(b.duplicate_count)]]} /></Section>
        <Section title="Quality results"><Table rows={b.quality_results ?? []} empty="No quality results." cols={[
          { head: 'Rule', cell: (r) => r.rule_id ?? r.check_id }, { head: 'Status', cell: (r) => <Signal status={r.status} /> }, { head: 'Severity', cell: (r) => r.severity }, { head: 'Affected', num: true, cell: (r) => count(r.affected_count ?? r.failed_count) }, { head: 'Detail', cell: (r) => r.message ?? r.explanation ?? '' }]} /></Section>
        <Section title="Reconciliation"><Table rows={b.reconciliation ?? []} empty="No reconciliation checks." cols={[
          { head: 'Check', cell: (r) => r.check_id }, { head: 'Status', cell: (r) => <Signal status={r.status} /> }, { head: 'Expected', cell: (r) => String(r.expected ?? '') }, { head: 'Actual', cell: (r) => String(r.actual ?? '') }, { head: 'Explanation', cell: (r) => r.explanation }]} /></Section>
        <Section title="Attempts and submissions"><Json value={{ attempts: b.attempts, submissions: b.submissions }} /></Section>
      </>)}</Async>
      <Section title="Findings" hint="Per-record quality findings (by source row).">
        <Async load={findings}>{(f) => <Table rows={f} empty="No findings." cols={[
          { head: 'Row', num: true, cell: (r) => count(r.source_row) }, { head: 'Rule', cell: (r) => r.rule_id }, { head: 'Severity', cell: (r) => <Signal status={r.severity === 'error' ? 'failed' : 'warn'} label={r.severity} /> }, { head: 'Field', cell: (r) => r.field ?? '' }, { head: 'Message', cell: (r) => r.message }]} />}</Async>
      </Section>
    </Page>
  );
}
