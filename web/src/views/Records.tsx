import { request, t, enc, qs } from '../lib/api';
import { go, href } from '../lib/router';
import { useLoad } from '../lib/useLoad';
import { useState } from 'react';
import { cell } from '../lib/format';
import { Async, Note, Page, Pager, Section, Tag } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const LIMIT = 100;
export function Records({ entity }: { entity?: string }) {
  const contract = useLoad((s) => request<any>('GET', t('/contracts/active'), undefined, { signal: s }), []);
  const [offset, setOffset] = useState(0);
  const entities = Object.keys(contract.data?.document?.entities ?? {});
  const active = entity ?? entities[0];
  const recs = useLoad((s) => (active ? request<any>('GET', t(`/entities/${enc(active)}/records${qs({ limit: LIMIT, offset })}`), undefined, { signal: s }) : Promise.resolve(null)), [active, offset]);
  return (
    <Page title="Records" sub="Current canonical records. Fields redacted for your role are marked and shown as the server sends them."
      actions={<select value={active ?? ''} onChange={(e) => { setOffset(0); go('records', e.target.value); }} aria-label="Entity">{entities.map((e) => <option key={e}>{e}</option>)}</select>}>
      {contract.error && !contract.data && <Note tone="warn">{contract.error.message}</Note>}
      <Section>
        <Async load={recs}>{(r) => (<>
          {Object.keys(r.redacted ?? {}).length > 0 && <Note tone="warn">Redacted for your role: {Object.entries(r.redacted).map(([f, s]) => <Tag key={f}>{f} · {String(s)}</Tag>)}</Note>}
          <div className="table-wrap grid"><table>
            <thead><tr>{r.fields.map((f: string) => <th key={f}>{f}{r.redacted?.[f] && <span className="mask" title={`Redacted (${r.redacted[f]})`}>◐</span>}</th>)}</tr></thead>
            <tbody>{r.records.map((row: any, i: number) => <tr key={i}>{r.fields.map((f: string, j: number) => <td key={f}>{j === 0 && !r.redacted?.[f] ? <a href={href('lineage', r.entity, cell(row[f]))}>{cell(row[f])}</a> : cell(row[f])}</td>)}</tr>)}</tbody>
          </table></div>
          <Pager offset={offset} limit={LIMIT} total={r.total} onChange={setOffset} />
        </>)}</Async>
      </Section>
    </Page>
  );
}
