// Deterministic synthetic data. Entirely fabricated: names come from small
// word lists, SSNs use the 900-series (never issued), NPIs and NDCs are random
// digits. Every generator returns the payload AND its ground truth (which rows
// are valid and why not), so tests derive expectations independently of the
// platform under test.

import { stringify } from 'csv-stringify/sync';

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    digits: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 10)).join(''),
  };
}
export type Rng = ReturnType<typeof rng>;

const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Emerson', 'Harper', 'Sage', 'Parker', 'Reese', 'Skyler', 'Dakota', 'Finley', 'Hayden'];
const LAST = ['Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fable', 'Grove', 'Heath', 'Isle', 'Juniper', 'Kestrel', 'Larch', 'Meadow', 'Norrow', 'Orchard', 'Pike'];
const ICD10 = ['E11.9', 'I10', 'J45.909', 'M54.5', 'K21.9', 'F41.1', 'E78.5', 'J06.9', 'N39.0', 'R51.9', 'Z00.00', 'M25.561'];
const CPT = ['99213', '99214', '80053', '85025', '93000', '71046', '97110', '36415'];

export const REF_DATE = '2026-09-30';
const isoDay = (base: string, offsetDays: number) => new Date(Date.parse(`${base}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const ymd = (iso: string) => iso.replace(/-/g, '');
const money = (cents: number) => (cents / 100).toFixed(2);

export function toCsv(rows: Record<string, string | number | null>[], columns?: string[]): Buffer {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  return Buffer.from(stringify([cols, ...rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))))]));
}

// ---------------------------------------------------------------- Northwind
export const NW_PLANS = [
  { PLAN_CD: 'NWHMO1', PLAN_NM: 'Northwind HMO Standard', PLAN_TYP: 'HMO', DEDUCT_AMT: '500.00', OOP_MAX_AMT: '4000.00', EFF_DT: '01/01/2026', TERM_DT: '', LAST_UPD_TS: '2026-01-01T00:00:00Z' },
  { PLAN_CD: 'NWPPO1', PLAN_NM: 'Northwind PPO Choice', PLAN_TYP: 'PPO', DEDUCT_AMT: '1000.00', OOP_MAX_AMT: '6000.00', EFF_DT: '01/01/2026', TERM_DT: '', LAST_UPD_TS: '2026-01-01T00:00:00Z' },
  { PLAN_CD: 'NWHDHP', PLAN_NM: 'Northwind HDHP Saver', PLAN_TYP: 'HDHP', DEDUCT_AMT: '3200.00', OOP_MAX_AMT: '7500.00', EFF_DT: '01/01/2026', TERM_DT: '', LAST_UPD_TS: '2026-01-01T00:00:00Z' },
];

export interface NwMember { MBR_ID: string; SSN: string; FIRST_NM: string; LAST_NM: string; DOB: string; GENDER_CD: string; ZIP: string; PLAN_CD: string; COV_START: string; COV_END: string; MBR_STATUS: string; LAST_UPD_TS: string }
export const NW_MEMBER_COLUMNS = ['MBR_ID', 'SSN', 'FIRST_NM', 'LAST_NM', 'DOB', 'GENDER_CD', 'ZIP', 'PLAN_CD', 'COV_START', 'COV_END', 'MBR_STATUS', 'LAST_UPD_TS'];

export function nwMembers(n: number, seed = 1, start = 1): NwMember[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const dob = isoDay('1950-01-01', r.int(0, 365 * 55));
    const cov = isoDay('2025-01-01', r.int(0, 600));
    const status = r.pick(['A', 'A', 'A', 'A', 'T', 'P']);
    return {
      MBR_ID: `NW${String(start + i).padStart(7, '0')}`, SSN: `9${r.digits(2)}-${r.digits(2)}-${r.digits(4)}`,
      FIRST_NM: r.pick(FIRST), LAST_NM: r.pick(LAST), DOB: mdy(dob), GENDER_CD: r.pick(['F', 'M', 'U']), ZIP: r.digits(5),
      PLAN_CD: r.pick(NW_PLANS).PLAN_CD, COV_START: mdy(cov), COV_END: status === 'T' ? mdy(isoDay(cov, r.int(30, 200))) : '',
      MBR_STATUS: status, LAST_UPD_TS: `2026-09-${String(r.int(1, 28)).padStart(2, '0')}T12:00:00Z`,
    };
  });
}

export interface NwClaim { CLM_ID: string; MBR_ID: string; RENDERING_NPI: string; SVC_DT: string; RCVD_DT: string; DX_CD: string; PROC_CD: string; BILLED_AMT: string; ALLOWED_AMT: string; PAID_AMT: string; CLM_STATUS: string; ADJ_SEQ: string; LOB?: string }
export const NW_CLAIM_COLUMNS = ['CLM_ID', 'MBR_ID', 'RENDERING_NPI', 'SVC_DT', 'RCVD_DT', 'DX_CD', 'PROC_CD', 'BILLED_AMT', 'ALLOWED_AMT', 'PAID_AMT', 'CLM_STATUS', 'ADJ_SEQ'];

export function nwClaims(n: number, memberIds: string[], seed = 2, start = 1): NwClaim[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const svc = isoDay(REF_DATE, -r.int(5, 160));
    const billed = r.int(5_000, 250_000);
    const allowed = Math.floor(billed * (0.5 + r.next() * 0.4));
    const status = r.pick(['P', 'P', 'P', 'P', 'D', 'H']);
    const paid = status === 'P' ? Math.floor(allowed * (0.6 + r.next() * 0.4)) : 0;
    return {
      CLM_ID: `C${String(start + i).padStart(9, '0')}`, MBR_ID: r.pick(memberIds), RENDERING_NPI: `1${r.digits(9)}`,
      SVC_DT: svc, RCVD_DT: isoDay(svc, r.int(1, 30)), DX_CD: r.pick(ICD10), PROC_CD: r.pick(CPT),
      BILLED_AMT: money(billed), ALLOWED_AMT: money(allowed), PAID_AMT: money(paid), CLM_STATUS: status, ADJ_SEQ: '1',
    };
  });
}

export function nwPharmacy(n: number, memberIds: string[], seed = 3, start = 1) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const ing = r.int(300, 60_000);
    const fee = r.int(100, 300);
    const member = r.int(0, 2_500);
    return {
      rxNumber: `RX${String(start + i).padStart(7, '0')}`, fillNumber: r.int(0, 3), memberId: r.pick(memberIds),
      ndc: `${r.digits(5)}-${r.digits(4)}-${r.digits(2)}`, fillDate: isoDay(REF_DATE, -r.int(1, 60)), daysSupply: r.pick([30, 30, 30, 90, 7]),
      quantity: (r.int(1, 180)).toFixed(3), ingredientCost: money(ing), dispensingFee: money(fee),
      planPaid: money(Math.max(0, ing + fee - member)), memberPaid: money(Math.min(member, ing + fee)), status: 'FILLED',
      pharmacyNpi: `1${r.digits(9)}`, updatedAt: `${isoDay(REF_DATE, -r.int(0, 3))}T0${r.int(0, 9)}:00:00Z`,
    };
  });
}

// ---------------------------------------------------------------- Bluefin
export const BF_PLANS = [
  { planId: 101, label: 'Bluefin Core Rx', tiers: 3, effectiveOn: '2026-01-01', rev: 1 },
  { planId: 102, label: 'Bluefin Plus Rx', tiers: 4, effectiveOn: '2026-01-01', rev: 1 },
  { planId: 103, label: 'Bluefin Specialty', tiers: 5, effectiveOn: '2026-01-01', rev: 1 },
];
export const BF_ENROLLEE_COLUMNS = ['SUB_ID', 'DEP_SEQ', 'REL', 'NAME', 'BIRTH_DT', 'EMAIL', 'PLAN_ID', 'TIER', 'EFF_DT', 'TERM_DT', 'REC_VER'];
export const BF_CLAIM_COLUMNS = ['CLAIM_NO', 'SUB_ID', 'DEP_SEQ', 'NDC', 'FILL_DT', 'DAYS', 'ING_COST_C', 'DISP_FEE_C', 'TOTAL_C', 'COPAY_C', 'PLAN_C', 'STATE', 'ADJ_TS', 'PHARM_ID', 'NOTES'];

export function bfEnrollees(subscribers: number, seed = 11, start = 1) {
  const r = rng(seed);
  const rows: Record<string, string | number>[] = [];
  for (let s = 0; s < subscribers; s++) {
    const sub = String(500000 + start + s);
    const deps = r.int(0, 3);
    const plan = r.pick(BF_PLANS).planId;
    const tier = deps === 0 ? 'EE' : deps === 1 ? r.pick(['ES', 'EC']) : 'FAM';
    for (let d = 0; d <= deps; d++) {
      const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
      rows.push({ SUB_ID: sub, DEP_SEQ: d, REL: d === 0 ? 'S' : d === 1 && tier !== 'EC' ? 'P' : 'C', NAME: name,
        BIRTH_DT: ymd(isoDay(d >= 2 ? '2005-01-01' : '1955-01-01', r.int(0, 365 * 18))), EMAIL: d === 0 ? `${name.replace(' ', '.').toLowerCase()}@example.test` : '',
        PLAN_ID: plan, TIER: tier, EFF_DT: ymd(isoDay('2025-06-01', r.int(0, 300))), TERM_DT: '', REC_VER: 1 });
    }
  }
  return rows;
}

export function bfClaims(n: number, enrollees: { SUB_ID: string | number; DEP_SEQ: string | number }[], seed = 12, start = 1) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const e = r.pick(enrollees);
    const ing = r.int(500, 90_000), fee = r.int(150, 250), total = ing + fee;
    const state = r.pick(['A', 'A', 'A', 'A', 'A', 'R']);
    const copay = state === 'A' ? Math.min(total, r.pick([500, 1000, 2500, 5000])) : 0;
    return { CLAIM_NO: `BX${String(start + i).padStart(8, '0')}`, SUB_ID: String(e.SUB_ID), DEP_SEQ: String(e.DEP_SEQ), NDC: r.digits(11), FILL_DT: ymd(isoDay(REF_DATE, -r.int(1, 90))),
      DAYS: r.pick([30, 30, 90, 14]), ING_COST_C: ing, DISP_FEE_C: fee, TOTAL_C: total, COPAY_C: copay, PLAN_C: state === 'A' ? total - copay : 0, STATE: state,
      ADJ_TS: `${isoDay(REF_DATE, -r.int(0, 5))}T1${r.int(0, 9)}:30:00Z`, PHARM_ID: `PH${r.digits(6)}`, NOTES: '' } as Record<string, string | number>;
  });
}

/** Ground-truth helpers for tests: exact sums with integer cents. */
export const centsOf = (s: string | number) => { const [i, f = ''] = String(s).split('.'); const neg = i.startsWith('-'); return (neg ? -1 : 1) * (Math.abs(Number(i)) * 100 + Number(f.padEnd(2, '0').slice(0, 2))); };
export const fromCents = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
