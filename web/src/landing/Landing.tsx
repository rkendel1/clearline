import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute } from '../lib/router';
import { session } from '../lib/api';
import { destHref, useContent, type Capability, type Content, type Decision } from '../lib/content';
import { Note, Signal } from '../ui';
import { ArchDiagram, ComponentPanel } from './ArchDiagram';
import { Link, RefLink } from './Link';
import { openAssistant } from './assistantBus';

const STATUS_TONE: Record<string, string> = { 'Implemented and verified': 'good', 'Implemented; verification incomplete': 'warn', 'Partially implemented': 'warn', Planned: 'idle' };
const NAV: [string, string][] = [['why', 'Why it matters'], ['architecture', 'Architecture'], ['capabilities', 'Capabilities'], ['actors', 'Use cases'], ['decisions', 'Decisions'], ['scenarios', 'Evidence'], ['limits', 'Limits']];

export function Landing({ embedded = false }: { embedded?: boolean }) {
  const { content, error } = useContent();
  const route = useRoute();
  const q = route.query;
  const section = q.get('s');
  const base = session.token ? '#/about' : '#/';
  const go = (params: Record<string, string | null>) => {
    const p = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    for (const [k, v] of Object.entries(params)) { if (v === null) p.delete(k); else p.set(k, v); }
    window.location.hash = `${base.slice(1)}?${p.toString()}`;
  };
  useEffect(() => {
    if (!section) { if (!embedded) window.scrollTo({ top: 0 }); return; }
    const el = document.getElementById(`sec-${section}`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [section, content, q.get('component'), q.get('decision'), q.get('capability'), q.get('actor'), embedded]);

  if (error) return <div className="landing"><Note tone="bad">The architecture content could not be loaded: {error}. Check that the API is running.</Note></div>;
  if (!content) return <div className="landing"><p className="muted" aria-busy="true">Loading…</p></div>;
  return (
    <div className="landing">
      {!embedded && <TopNav />}
      {!embedded && <Hero />}
      <Why content={content} />
      <Architecture content={content} selected={q.get('component')} onSelect={(id) => go({ component: id, s: 'architecture' })} />
      <Capabilities content={content} selected={q.get('capability')} actor={q.get('actor')} onActor={(a) => go({ actor: a, s: 'capabilities' })} />
      <Actors content={content} selected={q.get('actor')} onSelect={(a) => go({ actor: a, s: 'actors' })} />
      <Decisions content={content} selected={q.get('decision')} onSelect={(d) => go({ decision: d, s: 'decisions' })} />
      <Scenarios content={content} />
      <Limits content={content} />
      {!embedded && <Closing />}
    </div>
  );
}

function TopNav() {
  return (
    <header className="topnav">
      <a className="brand" href="#/">Clearline</a>
      <nav aria-label="Sections">{NAV.map(([id, label]) => <Link key={id} to={`#/?s=${id}`}>{label}</Link>)}</nav>
      <div className="row"><button className="btn" onClick={() => openAssistant()}>Ask Clearline</button><a className="btn primary" href="#/signin">Open the Demo</a></div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="eyebrow">Architecture demonstration</p>
      <h1 id="hero-title">Clearline</h1>
      <p className="lede">From raw data to trusted decisions.</p>
      <p className="hero-copy">Clearline demonstrates how a data platform can turn operational data into validated metrics, repeatable analytics and actionable insights, with explicit business rules, traceable execution and security controls.</p>
      <p className="hero-copy">Explore the architecture. Inspect the tradeoffs. Ask questions about the system. Then enter the working demo to see the capabilities in action.</p>
      <div className="row">
        <Link to="#/?s=architecture" className="btn primary big">Explore the Architecture</Link>
        <button className="btn big" onClick={() => openAssistant()}>Ask the Demo</button>
        <a className="btn big" href="#/signin">Open the Demo</a>
      </div>
      <p className="muted small hero-note">All data in the demo is synthetic. This is a demonstration, not a production service; each capability below states what has actually been verified.</p>
    </section>
  );
}

function Sec({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return <section id={`sec-${id}`} className="lsec" aria-labelledby={`h-${id}`}><h2 id={`h-${id}`}>{title}</h2>{intro && <p className="muted lsec-intro">{intro}</p>}{children}</section>;
}

function Why({ content }: { content: Content }) {
  return (
    <Sec id="why" title="Why this matters" intro="Data platforms often fail stakeholders in ways a dashboard does not show. These are the problems this architecture is designed to address, not claims that every platform has all of them.">
      <div className="cards">{content.site.problems.map((p) => <article key={p.title} className="card"><h3>{p.title}</h3><p>{p.body}</p></article>)}</div>
      <p className="lede2">Clearline's approach: make the rules, the execution, the evidence and the downstream results part of the platform itself.</p>
    </Sec>
  );
}

function Architecture({ content, selected, onSelect }: { content: Content; selected: string | null; onSelect: (id: string | null) => void }) {
  const comp = content.components.find((c) => c.id === selected) ?? null;
  const panel = useRef<HTMLDivElement>(null);
  const byLayer = useMemo(() => content.components, [content]);
  return (
    <Sec id="architecture" title="Architecture" intro="The diagram is generated from the same content the assistant reads. Solid arrows are synchronous requests, dashed arrows are queued work, the teal path is the assistant's retrieval, and dotted outlines are planned.">
      <div className="arch-layout">
        <ArchDiagram content={content} selected={selected} onSelect={onSelect} />
        <div ref={panel} className="arch-panel">
          {comp ? <ComponentPanel c={comp} content={content} /> : (
            <div className="panel muted"><h3>Inspect a component</h3><p>Select any box to see its responsibility, inputs and outputs, data, security boundary, failure modes, why it exists and the decisions behind it.</p>
              <h4>Components</h4><div className="complist">{byLayer.map((c) => <button key={c.id} className="chip" onClick={() => onSelect(c.id)}>{c.name}</button>)}</div></div>)}
          {comp && <button className="btn" onClick={() => openAssistant({ component: comp.id }, `Why does ${comp.name} exist, and what happens if it fails?`)}>Ask about this component</button>}
        </div>
      </div>
    </Sec>
  );
}

function Capabilities({ content, selected, actor, onActor }: { content: Content; selected: string | null; actor: string | null; onActor: (a: string | null) => void }) {
  const list = content.capabilities.filter((c) => !actor || c.actors.includes(actor));
  return (
    <Sec id="capabilities" title="What you can do with it" intro="Each status comes from recorded evidence, not from the presence of code. 'Verified' means named automated tests exist and their results were recorded at a stated commit.">
      <div className="row filters" role="group" aria-label="Filter by actor">
        <button className={`chip${!actor ? ' on' : ''}`} onClick={() => onActor(null)}>All actors</button>
        {content.actors.map((a) => <button key={a.id} className={`chip${actor === a.id ? ' on' : ''}`} onClick={() => onActor(a.id)}>{a.name}</button>)}
      </div>
      <div className="cards">{list.map((c) => <CapabilityCard key={c.id} c={c} open={selected === c.id} content={content} />)}</div>
    </Sec>
  );
}

function CapabilityCard({ c, open, content }: { c: Capability; open: boolean; content: Content }) {
  return (
    <article className={`card cap${open ? ' hl' : ''}`} id={`cap-${c.id}`}>
      <div className="row"><h3>{c.name}</h3></div>
      <span className={`signal ${STATUS_TONE[c.status] ?? 'idle'}`}>{c.status}</span>
      <p>{c.description}</p>
      <p className="small"><strong>Why it matters:</strong> {c.business_value}</p>
      <p className="small"><strong>Example:</strong> {c.use_case}</p>
      <p className="small muted">Serves: {c.actors.map((a) => content.actors.find((x) => x.id === a)?.name).filter(Boolean).join(', ')}</p>
      <details open={open}><summary>Evidence and limitations</summary>
        <p className="small">{c.verification.note}{c.verification.commit ? ` (commit ${c.verification.commit})` : ''}</p>
        {c.scenarios.length > 0 && <p className="small">Scenarios: {c.scenarios.join(', ')}</p>}
        {c.evidence.length > 0 && <ul className="small">{c.evidence.map((e) => <li key={e.path}><span className="mono">{e.path}</span></li>)}</ul>}
        {c.docs.length > 0 && <p className="small">Read: {c.docs.map((d, i) => <span key={d}>{i > 0 && ', '}<RefLink href={destHref({ kind: 'source', path: d })} path={d} label={d.split('/').pop()} /></span>)}</p>}
        {c.limitations.length > 0 && <><p className="small"><strong>Limitations</strong></p><ul className="small">{c.limitations.map((l) => <li key={l}>{l}</li>)}</ul></>}
      </details>
      <div className="row"><a className="btn" href={destHref({ kind: 'demo', view: c.demo.view }) ?? '#/signin'}>{c.demo.label}</a>
        <button className="btn" onClick={() => openAssistant({ capability: c.id }, `What does ${c.name} do and how was it verified?`)}>Ask</button></div>
    </article>
  );
}

function Actors({ content, selected, onSelect }: { content: Content; selected: string | null; onSelect: (a: string | null) => void }) {
  const a = content.actors.find((x) => x.id === selected) ?? null;
  return (
    <Sec id="actors" title="Who it serves" intro="Choose a role to see its questions and the capabilities, components and decisions most relevant to it.">
      <div className="row filters" role="tablist">{content.actors.map((x) => <button key={x.id} role="tab" aria-selected={selected === x.id} className={`chip${selected === x.id ? ' on' : ''}`} onClick={() => onSelect(selected === x.id ? null : x.id)}>{x.name}</button>)}</div>
      {a ? (
        <article className="panel">
          <h3>{a.name}</h3><p><strong>Goal:</strong> {a.goal}</p>
          <h4>Typical questions</h4><ul>{a.questions.map((q) => <li key={q}><button className="linklike" onClick={() => openAssistant({}, q)}>{q}</button></li>)}</ul>
          <h4>Relevant capabilities</h4><div className="row">{a.areas.map((x) => <Link key={x} className="chip" to={destHref({ kind: 'capability', id: x })!}>{content.capabilities.find((c) => c.id === x)?.name}</Link>)}</div>
          <h4>Components to inspect</h4><div className="row">{a.components.map((x) => <Link key={x} className="chip" to={destHref({ kind: 'component', id: x })!}>{content.components.find((c) => c.id === x)?.name}</Link>)}</div>
          <h4>Decisions</h4><div className="row">{a.decisions.map((x) => <Link key={x} className="chip" to={destHref({ kind: 'decision', id: x })!}>{content.decisions.find((c) => c.id === x)?.title}</Link>)}</div>
        </article>) : <p className="muted">Select a role above.</p>}
    </Sec>
  );
}

function Decisions({ content, selected, onSelect }: { content: Content; selected: string | null; onSelect: (d: string | null) => void }) {
  const [tag, setTag] = useState<string | null>(null);
  const list = content.decisions.filter((d) => !tag || d.tags.includes(tag));
  return (
    <Sec id="decisions" title="Decisions, Tradeoffs, and Alternatives" intro="Each record states the context, the chosen approach, the alternatives, the costs, the risks and when to revisit it. Where the original deliberation was not recorded, the record says so and documents the current rationale.">
      <div className="row filters" role="group" aria-label="Filter decisions">
        <button className={`chip${!tag ? ' on' : ''}`} onClick={() => setTag(null)}>All</button>
        {content.decision_tags.map(([id, label]) => <button key={id} className={`chip${tag === id ? ' on' : ''}`} onClick={() => setTag(id)}>{label}</button>)}
      </div>
      <div className="stack">{list.map((d) => <DecisionRecord key={d.id} d={d} open={selected === d.id} content={content} onToggle={() => onSelect(selected === d.id ? null : d.id)} />)}</div>
    </Sec>
  );
}

function DecisionRecord({ d, open, content, onToggle }: { d: Decision; open: boolean; content: Content; onToggle: () => void }) {
  const ul = (xs: string[]) => <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>;
  return (
    <article className={`decision${open ? ' hl' : ''}`} id={`dec-${d.id}`}>
      <button className="decision-head" aria-expanded={open} onClick={onToggle}><span className="letter">{d.letter}</span><span className="grow"><strong>{d.title}</strong><span className="muted small block">{d.decision.slice(0, 150)}{d.decision.length > 150 ? '…' : ''}</span></span><span aria-hidden="true">{open ? '−' : '+'}</span></button>
      {open && (
        <div className="decision-body">
          <p className="note idle small">{d.rationale_note}</p>
          <h4>Context and problem</h4><p>{d.context}</p>
          <h4>Chosen approach</h4><p>{d.decision}</p>
          <div className="two"><div><h4>Alternatives considered</h4>{ul(d.alternatives)}</div><div><h4>Advantages</h4>{ul(d.advantages)}</div></div>
          <div className="two"><div><h4>Costs and disadvantages</h4>{ul(d.costs)}</div><div><h4>Risks and mitigations</h4>{ul(d.risks)}</div></div>
          <h4>Revisit when</h4><p>{d.revisit_when}</p>
          <h4>Evidence in the repository</h4>{ul(d.implementation_evidence)}
          <div className="row">{d.refs.map((r) => destHref({ kind: 'source', path: r.path }) ? <Link key={r.path} className="chip" to={destHref({ kind: 'source', path: r.path })!}>{r.label}</Link> : <span key={r.path} className="chip">{r.label}</span>)}</div>
          {d.components.length > 0 && <div className="row"><span className="muted small">Components:</span>{d.components.map((c) => <Link key={c} className="chip" to={destHref({ kind: 'component', id: c })!}>{content.components.find((x) => x.id === c)?.name}</Link>)}</div>}
          <button className="btn" onClick={() => openAssistant({ decision: d.id }, `What are the tradeoffs of this decision: ${d.title}?`)}>Ask about this decision</button>
        </div>)}
    </article>
  );
}

function Scenarios({ content }: { content: Content }) {
  return (
    <Sec id="scenarios" title="Demonstration scenarios and evidence" intro={`These scenarios are automated tests that compare the platform with independently computed expected values. They were recorded from one clean clone at commit ${content.site.recorded_commit}; they have not been re-run for this page.`}>
      <div className="table-wrap"><table><thead><tr><th>Scenario</th><th>Name</th><th>What it demonstrates</th></tr></thead>
        <tbody>{content.site.scenarios.map(([l, n, d]) => <tr key={l}><td><strong>{l}</strong></td><td>{n}</td><td>{d}</td></tr>)}</tbody></table></div>
      <p className="small">Full results: <Link to={destHref({ kind: 'source', path: 'docs/test-results.md' })!}>test-results.md</Link> · per-capability status: <Link to={destHref({ kind: 'source', path: 'docs/production-readiness.md' })!}>production-readiness.md</Link></p>
    </Sec>
  );
}

function Limits({ content }: { content: Content }) {
  return (
    <Sec id="limits" title="Security, limitations and production considerations" intro="What this demonstration does not claim.">
      <ul className="limits">{content.site.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      <p className="small">Security model and known gaps: <Link to={destHref({ kind: 'source', path: 'docs/threat-model.md' })!}>threat-model.md</Link> · scaling triggers: <Link to={destHref({ kind: 'source', path: 'docs/scale-out.md' })!}>scale-out.md</Link></p>
    </Sec>
  );
}

function Closing() {
  return (
    <section className="closing"><h2>See it working</h2><p>Sign in with a demo token to run queries, inspect lineage, view a scheduled analysis and its charts. The assistant is available on every screen.</p>
      <div className="row"><a className="btn primary big" href="#/signin">Open the Demo</a><button className="btn big" onClick={() => openAssistant()}>Ask Clearline</button></div></section>
  );
}
