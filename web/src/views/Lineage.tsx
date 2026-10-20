import { FormEvent, useState } from 'react';
import { request, t, enc } from '../lib/api';
import { go, href } from '../lib/router';
import { useLoad } from '../lib/useLoad';
import { cell, count, short, when } from '../lib/format';
import { Async, Button, Facts, Field, Json, Note, Page, Section, Signal, Table, Tag } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Lineage({ entity, recordKey }: { entity?: string; recordKey?: string }) {
  const contract = useLoad((s) => request<any>('GET', t('/contracts/active'), undefined, { signal: s }), []);
  const entities = Object.keys(contract.data?.document?.entities ?? {});
  const [e, setE] = useState(entity ?? '');
  const [k, setK] = useState(recordKey ?? '');
  const ent = entity ?? (e || entities[0] || '');
  const submit = (ev: FormEvent) => { ev.preventDefault(); if (ent && k.trim()) go('lineage', ent, k.trim()); };
  const load = useLoad((s) => (entity && recordKey ? request<any>('GET', t(`/lineage/${enc(entity)}/${enc(recordKey)}`), undefined, { signal: s }) : Promise.resolve(null)), [entity, recordKey]);
  return (
    <Page title="Lineage" sub="Where a record came from: source row, batch, contract and transform versions, quality, reconciliation, metrics and exports.">
      <Section>
        <form className="row" onSubmit={submit}>
          <Field label="Entity"><select value={ent} onChange={(ev) => setE(ev.target.value)}>{entities.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Record key"><input value={k} onChange={(ev) => setK(ev.target.value)} placeholder="e.g. C000000104" /></Field>
          <Button type="submit" primary disabled={!ent || !k.trim()}>Look up</Button>
        </form>
      </Section>
      {entity && recordKey && <Async load={load}>{(l) => l && (<>
        <Section title={`${l.entity} ${l.key}`}><Facts items={[['Active contract', l.active_contract_version], ['Current version', String(l.current_record_id ?? '—')], ['Trusted version', String(l.trusted_record_id ?? '—')], ['Versions', String(l.versions.length)]]} /></Section>
        {l.versions.map((v: any) => (
          <Section key={v.record_id} title={`Version ${v.record_id}`} actions={<>{v.is_current && <Tag>current</Tag>}{v.is_late && <Tag>late</Tag>}</>}>
            <Facts items={[['Loaded', when(v.loaded_at)], ['Contract', v.contract_version], ['Transform', <span className="mono">{v.transform_version}</span>],
              ['Batch', <a href={href('batches', v.batch.id)}>{short(v.batch.id)}</a>], ['Source', v.batch.source_id], ['Batch status', <Signal status={v.batch.status} />], ['Trust', <Signal status={v.batch.trust_status} />],
              ['Source row', v.source_row ? `#${count(v.source_row.row_number)}${v.source_row.payload_retained ? '' : ' (payload erased)'}` : '—']]} />
            <h3>Values</h3>
            <Table rows={Object.entries(v.values)} cols={[{ head: 'Field', cell: ([f]: any) => f }, { head: 'Value', cell: ([, x]: any) => cell(x) }]} />
            {v.source_row?.mapped_columns && <><h3>Mapped from source columns</h3><Table rows={Object.entries(v.source_row.mapped_columns)} cols={[{ head: 'Column', cell: ([f]: any) => f }, { head: 'Raw', cell: ([, x]: any) => cell(x) }]} /></>}
            {v.source_row?.quality_findings?.length > 0 && <><h3>Quality findings</h3><Json open value={v.source_row.quality_findings} label="Findings" /></>}
            {v.metric_contribution?.length > 0 && <Json value={v.metric_contribution} label="Metric contribution" />}
            {v.exports?.length > 0 && <Json value={v.exports} label="Exports containing this version" />}
          </Section>))}
        {l.quarantined_submissions?.length > 0 && <Section title="Quarantined submissions"><Json open value={l.quarantined_submissions} label="Submissions" /></Section>}
      </>)}</Async>}
      {!entity && <Note tone="idle">Open a record from Records or Exceptions, or enter its key above.</Note>}
    </Page>
  );
}
