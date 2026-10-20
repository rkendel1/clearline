import { useState } from 'react';
import { request, session, t, qs } from '../lib/api';
import { count, short } from '../lib/format';
import { href } from '../lib/router';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, ErrorBox, Json, Page, Section, Signal, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Exceptions() {
  const [status, setStatus] = useState('open');
  const q = useLoad((s) => request<any[]>('GET', t(`/quarantine${qs({ status, limit: 500 })}`), undefined, { signal: s }), [status]);
  const rep = useLoad((s) => request<any>('GET', t('/reports/exceptions'), undefined, { signal: s }), []);
  const [resolving, setResolving] = useState<string | null>(null);
  const [text, setText] = useState('');
  const resolve = useAction(async (id: string) => { await request('POST', t(`/quarantine/${id}/resolve`), { resolution: text }); setResolving(null); setText(''); q.reload(); rep.reload(); });
  return (
    <Page title="Exceptions" sub="Quarantined records, orphaned references, late arrivals and batches needing review." actions={<>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select>
      <Button onClick={() => { q.reload(); rep.reload(); }}>Refresh</Button></>}>
      <ErrorBox error={resolve.error} />
      <Section title="Quarantined records" hint="Quarantine never admits a record. Resolving records the decision; corrected data must be resubmitted.">
        <Async load={q}>{(rows) => <Table rows={rows} empty="Nothing quarantined." cols={[
          { head: 'Id', num: true, cell: (r) => String(r.id) }, { head: 'Batch', cell: (r) => <a href={href('batches', r.batch_id)}>{short(r.batch_id)}</a> }, { head: 'Entity', cell: (r) => r.entity },
          { head: 'Key', cell: (r) => r.record_key ? <a href={href('lineage', r.entity, r.record_key)}>{r.record_key}</a> : '—' }, { head: 'Row', num: true, cell: (r) => count(r.source_row) }, { head: 'Category', cell: (r) => r.category },
          { head: 'Why', cell: (r) => <ul>{(r.reasons ?? []).map((x: any, i: number) => <li key={i}><span className="mono">{x.rule_id}</span>: {x.message}</li>)}</ul> },
          { head: 'Status', cell: (r) => <Signal status={r.status} /> },
          { head: '', cell: (r) => r.status === 'open' && session.can('quarantine:resolve') ? (resolving === String(r.id)
            ? <span className="row"><input value={text} placeholder="Resolution" onChange={(e) => setText(e.target.value)} aria-label="Resolution" /><Button primary disabled={!text.trim()} busy={resolve.busy} onClick={() => resolve.run(String(r.id))}>Resolve</Button><Button onClick={() => setResolving(null)}>Cancel</Button></span>
            : <Button onClick={() => { setResolving(String(r.id)); setText(''); }}>Resolve…</Button>) : null }]} />}</Async>
      </Section>
      <Async load={rep}>{(r) => (<>
        <Section title="Orphaned references"><Table rows={r.orphaned_references ?? []} empty="None." cols={[
          { head: 'Entity', cell: (x: any) => x.entity }, { head: 'Relationship', cell: (x: any) => x.relationship }, { head: 'References', cell: (x: any) => x.references }, { head: 'Key', cell: (x: any) => JSON.stringify(x.key) },
          { head: 'Missing', cell: (x: any) => JSON.stringify(x.missing_reference) }, { head: 'Batch', cell: (x: any) => <a href={href('batches', x.batch_id)}>{short(x.batch_id)}</a> }]} /></Section>
        <Section title="Late records and batches needing review"><Json value={{ late_records: r.late_records, batches_requiring_review: r.batches_requiring_review }} /></Section>
        <Section title="Summary"><Json value={r.summary} /></Section>
      </>)}</Async>
    </Page>
  );
}
