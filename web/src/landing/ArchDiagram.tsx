import { useMemo } from 'react';
import { Link, RefLink } from './Link';
import { Signal } from '../ui';
import { type Boundary, type Component, type Content, type Edge } from '../lib/content';
import { destHref } from '../lib/content';

const KIND_LABEL: Record<Edge['kind'], string> = { sync: 'Synchronous request', async: 'Asynchronous (queued, claimed later)', retrieval: 'Assistant retrieval path', planned: 'Planned, not built' };
const STATUS: Record<Component['status'], string> = { implemented: 'Implemented', partial: 'Partially implemented', planned: 'Planned' };

function wrap(text: string, max: number): string[] {
  const out: string[] = []; let cur = '';
  for (const w of text.split(' ')) { if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
  if (cur) out.push(cur);
  return out;
}
const center = (c: Component) => ({ x: c.layout.x + c.layout.w / 2, y: c.layout.y + c.layout.h / 2 });
/** Where the line from a's centre toward b's centre leaves a's rectangle. */
function edgePoint(a: Component, b: Component) {
  const ca = center(a), cb = center(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  const sx = dx === 0 ? Infinity : (a.layout.w / 2) / Math.abs(dx), sy = dy === 0 ? Infinity : (a.layout.h / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: ca.x + dx * s, y: ca.y + dy * s };
}

export function ArchDiagram({ content, selected, onSelect }: { content: Content; selected: string | null; onSelect: (id: string | null) => void }) {
  const byId = useMemo(() => new Map(content.components.map((c) => [c.id, c])), [content]);
  const visible = content.components.filter((c) => c.layout.w > 0);
  const edges = content.diagram.edges.filter((e) => byId.get(e.from)!.layout.w > 0 && byId.get(e.to)!.layout.w > 0);
  const connected = (e: Edge) => selected !== null && (e.from === selected || e.to === selected);
  const near = new Set<string>(selected ? [selected, ...edges.filter(connected).flatMap((e) => [e.from, e.to])] : []);
  return (
    <div className="diagram">
      <div className="row"><button className="btn" onClick={() => onSelect(null)} disabled={!selected}>Reset view</button>
        <span className="muted small">Select a component to inspect it. {selected ? 'Its connections are highlighted.' : ''}</span></div>
      <svg className="arch-svg" viewBox="0 0 1000 720" role="group" aria-label="Clearline architecture diagram. A text version follows below.">
        <defs>
          {(['sync', 'async', 'retrieval', 'planned'] as const).map((k) => (
            <marker key={k} id={`arr-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className={`arrow ${k}`} /></marker>))}
        </defs>
        {content.diagram.boundaries.map((b: Boundary) => (
          <g key={b.id}><rect x={b.x} y={b.y} width={b.w} height={b.h} rx="10" className="boundary" /><text x={b.x + 8} y={b.y + b.h - 6} className="boundary-label">{b.label}</text></g>))}
        {edges.map((e, i) => {
          const a = byId.get(e.from)!, b = byId.get(e.to)!;
          const p = edgePoint(a, b), q = edgePoint(b, a);
          return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={`edge ${e.kind}${selected ? (connected(e) ? ' on' : ' dim') : ''}`} markerEnd={`url(#arr-${e.kind})`}><title>{`${a.name} → ${b.name}: ${e.label}`}</title></line>;
        })}
        {visible.map((c) => {
          const lines = wrap(c.name, Math.max(14, Math.floor(c.layout.w / 11)));
          const active = selected === c.id;
          return (
            <g key={c.id} role="button" tabIndex={0} aria-pressed={active} aria-label={`${c.name}, ${STATUS[c.status]}. ${c.summary}`}
              className={`node ${c.status} ${c.layer}${active ? ' selected' : ''}${selected && !near.has(c.id) ? ' dim' : ''}`}
              onClick={() => onSelect(active ? null : c.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(active ? null : c.id); } }}>
              <rect x={c.layout.x} y={c.layout.y} width={c.layout.w} height={c.layout.h} rx="8" />
              {lines.map((l, i) => <text key={i} x={c.layout.x + c.layout.w / 2} y={c.layout.y + 30 + i * 22} textAnchor="middle" className="node-title">{l}</text>)}
              <text x={c.layout.x + c.layout.w / 2} y={c.layout.y + c.layout.h - 12} textAnchor="middle" className="node-sub">{c.status === 'implemented' ? '' : STATUS[c.status].toLowerCase()}</text>
            </g>);
        })}
      </svg>
      <div className="legend">{(Object.keys(KIND_LABEL) as Edge['kind'][]).map((k) => <span key={k}><svg width="30" height="8" aria-hidden="true"><line x1="0" y1="4" x2="30" y2="4" className={`edge ${k}`} /></svg> {KIND_LABEL[k]}</span>)}<span><svg width="30" height="10" aria-hidden="true"><rect x="0" y="1" width="30" height="8" className="boundary" /></svg> Enforcement boundary</span></div>
      <details className="textalt"><summary>Text version of the diagram</summary>
        <p className="muted small">Components are listed with what they connect to. Each is also a button above.</p>
        <ul>{content.components.map((c) => (
          <li key={c.id}><button className="linklike" onClick={() => onSelect(c.id)}>{c.name}</button> <Signal status={c.status === 'implemented' ? 'ok' : c.status === 'partial' ? 'warn' : 'idle'} label={STATUS[c.status]} /> {c.summary}
            <ul>{content.diagram.edges.filter((e) => e.from === c.id).map((e, i) => <li key={i} className="small muted">→ {byId.get(e.to)!.name} ({KIND_LABEL[e.kind].toLowerCase()}): {e.label}</li>)}</ul></li>))}
        </ul>
        <p className="small"><strong>Enforcement boundaries:</strong> {content.diagram.boundaries.map((b) => b.label).join('; ')}.</p>
      </details>
    </div>
  );
}

export function ComponentPanel({ c, content, onSelectDecision }: { c: Component; content: Content; onSelectDecision?: (id: string) => void }) {
  const byId = new Map(content.components.map((x) => [x.id, x]));
  const li = (xs: string[]) => (xs.length ? <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="muted">None.</p>);
  return (
    <article className="panel" aria-live="polite">
      <div className="row"><h3>{c.name}</h3><Signal status={c.status === 'implemented' ? 'ok' : c.status === 'partial' ? 'warn' : 'idle'} label={STATUS[c.status]} /></div>
      <p>{c.responsibility}</p>
      <dl className="facts">
        <div><dt>Why it exists</dt><dd>{c.why}</dd></div>
        <div><dt>Data owned or accessed</dt><dd>{c.data}</dd></div>
        <div><dt>Security boundary</dt><dd>{c.security}</dd></div>
      </dl>
      <div className="two"><div><h4>Inputs</h4>{li(c.inputs)}</div><div><h4>Outputs</h4>{li(c.outputs)}</div></div>
      <h4>Depends on</h4>
      <div className="row">{c.dependencies.length ? c.dependencies.map((d) => <Link key={d} to={destHref({ kind: 'component', id: d })!} className="chip">{byId.get(d)?.name}</Link>) : <span className="muted">Nothing inside Clearline.</span>}</div>
      <h4>Failure modes</h4>{li(c.failure_modes)}
      {c.decisions.length > 0 && <><h4>Design decisions</h4><div className="row">{c.decisions.map((d) => <Link key={d} to={destHref({ kind: 'decision', id: d })!} className="chip" onClick={() => onSelectDecision?.(d)}>{content.decisions.find((x) => x.id === d)?.title}</Link>)}</div></>}
      <h4>References</h4>
      <ul>{c.refs.map((r) => <li key={r.path}><RefLink href={destHref({ kind: 'source', path: r.path })} path={r.path} label={r.label} /> <span className="muted small mono">{r.path}</span></li>)}</ul>
    </article>
  );
}
