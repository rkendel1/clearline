import { num } from './lib/format';

// Charts are plain SVG built from the numbers the server returned (nothing is re-derived). Presentation attributes only, no inline styles (CSP).

export interface Pt { label: string; observed?: number | null; lower?: number | null; upper?: number | null; expected?: number | null; forecast?: number | null; marker?: 'high' | 'other' | null }
const W = 720, H = 200, PL = 44, PR = 8, PT = 8, PB = 22;

function extent(vals: (number | null | undefined)[]): [number, number] {
  const v = vals.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return [0, 1];
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}
const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Math.round(n * 100) / 100));

export function SeriesChart({ title, points }: { title: string; points: Pt[] }) {
  const n = Math.max(points.length, 2);
  const [lo, hi] = extent(points.flatMap((p) => [p.observed, p.lower, p.upper, p.expected, p.forecast]));
  const x = (i: number) => PL + ((W - PL - PR) * i) / (n - 1);
  const y = (v: number) => PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo));
  const runs = (pick: (p: Pt) => number | null | undefined) => {
    const out: [number, number][][] = []; let cur: [number, number][] = [];
    points.forEach((p, i) => { const v = pick(p); if (v === null || v === undefined) { if (cur.length) out.push(cur); cur = []; } else cur.push([i, v]); });
    if (cur.length) out.push(cur);
    return out;
  };
  const line = (r: [number, number][]) => r.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const bandRuns: [number, number, number][][] = []; let cur: [number, number, number][] = [];
  points.forEach((p, i) => { if (p.lower != null && p.upper != null) cur.push([i, p.lower, p.upper]); else { if (cur.length) bandRuns.push(cur); cur = []; } });
  if (cur.length) bandRuns.push(cur);
  const band = (r: [number, number, number][]) => `${r.map(([i, , u], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(u).toFixed(1)}`).join('')}${[...r].reverse().map(([i, l]) => `L${x(i).toFixed(1)},${y(l).toFixed(1)}`).join('')}Z`;
  const ticks = [lo + (hi - lo) * 0.06, (lo + hi) / 2, hi - (hi - lo) * 0.06];
  return (
    <figure>
      <figcaption className="small muted">{title}</figcaption>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {ticks.map((v) => <g key={v}><line className="axis" x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} /><text x={PL - 4} y={y(v) + 3} textAnchor="end">{fmt(v)}</text></g>)}
        {bandRuns.filter((r) => r.length > 1).map((r, k) => <path key={k} className="band" d={band(r)} />)}
        {runs((p) => p.observed).map((r, k) => <path key={k} className="obs" d={line(r)} />)}
        {runs((p) => p.forecast).map((r, k) => <path key={k} className="fc" d={line(r)} />)}
        {points.map((p, i) => p.marker && p.observed != null ? <circle key={i} className={p.marker === 'high' ? 'dot-high' : 'dot-other'} cx={x(i)} cy={y(p.observed)} r={4}><title>{`${p.label}: ${p.observed}`}</title></circle> : null)}
        <text x={PL} y={H - 6}>{points[0]?.label ?? ''}</text><text x={W - PR} y={H - 6} textAnchor="end">{points[points.length - 1]?.label ?? ''}</text>
      </svg>
      <div className="legend"><span>— observed</span>{points.some((p) => p.lower != null) && <span>▒ expected / interval</span>}{points.some((p) => p.forecast != null) && <span>- - forecast</span>}{points.some((p) => p.marker) && <span>● anomaly</span>}</div>
    </figure>
  );
}

export function Bars({ data, aLabel, bLabel }: { data: { label: string; a: unknown; b: unknown }[]; aLabel: string; bLabel: string }) {
  if (!data.length) return <p className="muted">No data in this window.</p>;
  const rows = data.map((d) => ({ label: d.label, a: num(d.a) ?? 0, b: num(d.b) ?? 0 }));
  const max = Math.max(1, ...rows.map((r) => r.a));
  const bw = (W - PL - PR) / rows.length;
  return (
    <figure>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${aLabel} and ${bLabel} per day`}>
        <line className="axis" x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} /><text x={PL - 4} y={PT + 8} textAnchor="end">{fmt(max)}</text><text x={PL - 4} y={H - PB} textAnchor="end">0</text>
        {rows.map((r, i) => {
          const h = ((H - PT - PB) * r.a) / max, hb = ((H - PT - PB) * r.b) / max, bx = PL + i * bw + bw * 0.15;
          return <g key={r.label}><rect className="band" x={bx} y={H - PB - h} width={bw * 0.7} height={h}><title>{`${r.label}: ${r.a} ${aLabel}, ${r.b} ${bLabel}`}</title></rect>{r.b > 0 && <rect className="dot-other" x={bx} y={H - PB - hb} width={bw * 0.7} height={hb} />}</g>;
        })}
        <text x={PL} y={H - 6}>{rows[0].label}</text><text x={W - PR} y={H - 6} textAnchor="end">{rows[rows.length - 1].label}</text>
      </svg>
      <div className="legend"><span>▒ {aLabel}</span><span>● {bLabel}</span></div>
    </figure>
  );
}
