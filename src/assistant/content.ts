// The version-controlled content model (content/*.json). One source for the landing page, the architecture
// diagram, the capability catalog, the decision records, and the assistant's retrieval corpus. Nothing here
// is read from the database, and nothing here may contain secrets or tenant data.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const STATUS_LABELS = ['Implemented and verified', 'Implemented; verification incomplete', 'Partially implemented', 'Planned'] as const;
export type CapabilityStatus = (typeof STATUS_LABELS)[number];
export type ComponentStatus = 'implemented' | 'partial' | 'planned';
export interface Ref { label: string; path: string }
export interface Component {
  id: string; name: string; layer: string; status: ComponentStatus; layout: { x: number; y: number; w: number; h: number }; summary: string;
  responsibility: string; inputs: string[]; outputs: string[]; dependencies: string[]; data: string; security: string; failure_modes: string[]; why: string; decisions: string[]; refs: Ref[];
}
export interface Edge { from: string; to: string; kind: 'sync' | 'async' | 'retrieval' | 'planned'; label: string }
export interface Boundary { id: string; label: string; x: number; y: number; w: number; h: number; enforced_by: string }
export interface Capability {
  id: string; name: string; status: CapabilityStatus; actors: string[]; description: string; business_value: string; use_case: string; scenarios: string[];
  evidence: { type: 'test'; path: string }[]; docs: string[]; demo: { view: string; label: string }; limitations: string[]; verification: { doc: string; commit?: string; note: string };
}
export interface Decision {
  id: string; letter: string; title: string; tags: string[]; rationale_note: string; context: string; decision: string; alternatives: string[]; advantages: string[]; costs: string[]; risks: string[];
  revisit_when: string; implementation_evidence: string[]; refs: Ref[]; components: string[];
}
export interface Actor { id: string; name: string; goal: string; questions: string[]; areas: string[]; components: string[]; decisions: string[] }
export interface Site { problems: { title: string; body: string }[]; limitations: string[]; scenarios: [string, string, string][]; recorded_commit: string }
export interface Content {
  components: Component[]; diagram: { edges: Edge[]; boundaries: Boundary[] }; capabilities: Capability[]; status_labels: string[];
  decisions: Decision[]; decision_tags: [string, string][]; actors: Actor[]; site: Site;
}

export const contentDir = () => resolve(process.env.CONTENT_DIR ?? join(process.cwd(), 'content'));
export const repoRoot = () => resolve(process.env.REPO_ROOT ?? process.cwd());
const read = <T>(f: string): T => JSON.parse(readFileSync(join(contentDir(), f), 'utf8')) as T;

let cache: Content | undefined;
export function loadContent(): Content {
  if (cache) return cache;
  const components = read<Component[]>('components.json');
  const decisionsFile = read<{ tags: [string, string][]; decisions: Decision[] }>('decisions.json');
  for (const d of decisionsFile.decisions) d.components = components.filter((c) => c.decisions.includes(d.id)).map((c) => c.id);
  const caps = read<{ status_labels: string[]; capabilities: Capability[] }>('capabilities.json');
  cache = {
    components, diagram: read('diagram.json'), capabilities: caps.capabilities, status_labels: caps.status_labels,
    decisions: decisionsFile.decisions, decision_tags: decisionsFile.tags, actors: read('actors.json'), site: read('site.json'),
  };
  return cache;
}
export const resetContent = () => { cache = undefined; };

/** Structural and referential checks. Returns problems; empty means consistent. With checkFiles (the default) referenced files, tests and recorded results must exist in the repository. */
export function validateContent(c: Content, root = repoRoot(), opts: { checkFiles?: boolean } = {}): string[] {
  const problems: string[] = [];
  const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
  const comp = ids(c.components), dec = ids(c.decisions), cap = ids(c.capabilities), act = ids(c.actors);
  const dup = (xs: { id: string }[], what: string) => { if (ids(xs).size !== xs.length) problems.push(`duplicate ${what} id`); };
  dup(c.components, 'component'); dup(c.decisions, 'decision'); dup(c.capabilities, 'capability'); dup(c.actors, 'actor');
  // File references are checked in tests against the full repository; the runtime image does not contain src/ or test/.
  const exists = (p: string) => opts.checkFiles === false || existsSync(join(root, p));
  for (const k of c.components) {
    for (const d of k.dependencies) if (!comp.has(d)) problems.push(`component ${k.id}: unknown dependency ${d}`);
    for (const d of k.decisions) if (!dec.has(d)) problems.push(`component ${k.id}: unknown decision ${d}`);
    for (const r of k.refs) if (!exists(r.path)) problems.push(`component ${k.id}: missing ref ${r.path}`);
  }
  for (const e of c.diagram.edges) { if (!comp.has(e.from) || !comp.has(e.to)) problems.push(`edge ${e.from}->${e.to}: unknown component`); }
  for (const b of c.diagram.boundaries) if (!comp.has(b.enforced_by)) problems.push(`boundary ${b.id}: unknown component`);
  for (const d of c.decisions) {
    for (const r of d.refs) if (!exists(r.path)) problems.push(`decision ${d.id}: missing ref ${r.path}`);
    if (!d.alternatives.length || !d.costs.length || !d.revisit_when) problems.push(`decision ${d.id}: incomplete (alternatives, costs and revisit_when are required)`);
    if (!d.rationale_note) problems.push(`decision ${d.id}: rationale_note required`);
  }
  for (const k of c.capabilities) {
    if (!(STATUS_LABELS as readonly string[]).includes(k.status)) problems.push(`capability ${k.id}: invalid status ${k.status}`);
    for (const a of k.actors) if (!act.has(a)) problems.push(`capability ${k.id}: unknown actor ${a}`);
    for (const e of k.evidence) if (!exists(e.path)) problems.push(`capability ${k.id}: missing evidence ${e.path}`);
    for (const p of k.docs) if (!exists(p)) problems.push(`capability ${k.id}: missing doc ${p}`);
    // A capability is only "verified" when automated tests exist for it and the recorded results exist.
    if (k.status === 'Implemented and verified' && (!k.evidence.length || !k.verification.commit || !exists(k.verification.doc))) problems.push(`capability ${k.id}: verified status needs test evidence and a recorded result`);
    if (k.status === 'Planned' && k.evidence.length) problems.push(`capability ${k.id}: a planned capability cannot cite test evidence`);
  }
  for (const a of c.actors) {
    for (const x of a.areas) if (!cap.has(x)) problems.push(`actor ${a.id}: unknown capability ${x}`);
    for (const x of a.components) if (!comp.has(x)) problems.push(`actor ${a.id}: unknown component ${x}`);
    for (const x of a.decisions) if (!dec.has(x)) problems.push(`actor ${a.id}: unknown decision ${x}`);
  }
  return problems;
}
