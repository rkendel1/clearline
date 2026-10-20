import { Field } from '../ui';
import type { ParamDecl } from '../types';

/** Typed inputs for a saved query's declared parameters. Values stay strings until sent; the server validates bounds. */
export function paramBody(decls: ParamDecl[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of decls) {
    const v = values[d.name];
    if (v === undefined || v === '') continue;
    out[d.name] = d.type === 'integer' || d.type === 'decimal' ? Number(v) : d.type === 'boolean' ? v === 'true' : v;
  }
  return out;
}

export function defaults(decls: ParamDecl[]): Record<string, string> {
  return Object.fromEntries(decls.filter((d) => d.default !== null && d.default !== undefined).map((d) => [d.name, String(d.default)]));
}

export function ParamInputs({ decls, values, onChange }: { decls: ParamDecl[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  if (!decls.length) return null;
  const set = (n: string, v: string) => onChange({ ...values, [n]: v });
  return (
    <div className="form-grid">
      {decls.map((d) => (
        <Field key={d.name} label={`${d.label || d.name}${d.required === false ? '' : ' *'}`} hint={[d.type, d.min != null ? `min ${d.min}` : '', d.max != null ? `max ${d.max}` : ''].filter(Boolean).join(' · ')}>
          {d.allowed?.length ? <select value={values[d.name] ?? ''} onChange={(e) => set(d.name, e.target.value)}><option value="" />{d.allowed.map((a) => <option key={String(a)}>{String(a)}</option>)}</select>
            : d.type === 'boolean' ? <select value={values[d.name] ?? ''} onChange={(e) => set(d.name, e.target.value)}><option value="" /><option>true</option><option>false</option></select>
            : <input type={d.type === 'date' ? 'date' : 'text'} inputMode={d.type === 'integer' || d.type === 'decimal' ? 'decimal' : undefined} value={values[d.name] ?? ''} onChange={(e) => set(d.name, e.target.value)} />}
        </Field>))}
    </div>
  );
}
