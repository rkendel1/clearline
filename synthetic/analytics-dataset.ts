// Deterministic analytics dataset for the saved-analytics scenarios (P-T) and demo.
//
// 180 days of northwind claims ending REF_DATE with structure the analyses must recover:
//   - weekly seasonality: weekdays carry ~10 claims, weekends ~4;
//   - one planted spike: ANOMALY_DATE carries 2 extra inpatient and 3 extra specialist claims;
//   - three claim profiles (procedure codes) with distinct amount and processing-time ranges
//     (routine 99213, specialist 99244, inpatient 99223), i.e. known cluster structure;
//   - three seeded outliers among routine claims: one billed ~25x the norm, one processed after
//     120 days, one with both amounts unusually high.
// Ground truth (daily paid totals in cents, profiles, outlier ids) is computed from the rows.

import { rng, toCsv, NW_PLANS, nwMembers, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, REF_DATE, type NwClaim } from './generator.js';
import type { SubmitApi } from './reference-dataset.js';

export const ANALYTICS_DAYS = 180;
export const ANOMALY_DATE = '2026-08-31';   // a Monday, 30 days before REF_DATE
export const OUTLIER_IDS = ['A000000077', 'A000000555', 'A000000999'];
const PROFILES = {
  routine: { proc: '99213', billed: [12_000, 20_000], days: [5, 10] },
  specialist: { proc: '99244', billed: [90_000, 140_000], days: [14, 21] },
  inpatient: { proc: '99223', billed: [800_000, 1_000_000], days: [30, 40] },
} as const;
type Profile = keyof typeof PROFILES;

const day = (iso: string, delta: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
const money = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

export interface AnalyticsTruth {
  from: string; to: string; claims: number;
  /** Paid cents per service date. */
  dailyPaidCents: Map<string, number>;
  profileOf: Map<string, Profile>;
  outliers: string[];
  anomalyDate: string;
}

export function analyticsClaims(memberIds: string[], seed = 77): { rows: NwClaim[]; truth: AnalyticsTruth } {
  const r = rng(seed);
  const rows: NwClaim[] = [];
  const daily = new Map<string, number>();
  const profileOf = new Map<string, Profile>();
  const from = day(REF_DATE, -(ANALYTICS_DAYS - 1));
  let n = 0;
  const add = (svc: string, p: Profile, override?: { billed?: number; days?: number }) => {
    n++;
    const spec = PROFILES[p];
    const id = `A${String(n).padStart(9, '0')}`;
    const billed = override?.billed ?? r.int(spec.billed[0], spec.billed[1]);
    const allowed = Math.floor(billed * 0.8);
    const paid = Math.floor(allowed * 0.9);
    const lag = override?.days ?? r.int(spec.days[0], spec.days[1]);
    rows.push({ CLM_ID: id, MBR_ID: r.pick(memberIds), RENDERING_NPI: `1${r.digits(9)}`, SVC_DT: svc, RCVD_DT: day(svc, lag), DX_CD: 'E11.9', PROC_CD: spec.proc,
      BILLED_AMT: money(billed), ALLOWED_AMT: money(allowed), PAID_AMT: money(paid), CLM_STATUS: 'P', ADJ_SEQ: '1' });
    daily.set(svc, (daily.get(svc) ?? 0) + paid);
    profileOf.set(id, p);
  };
  for (let i = 0; i < ANALYTICS_DAYS; i++) {
    const svc = day(from, i);
    const weekday = (new Date(`${svc}T00:00:00Z`).getUTCDay() + 6) % 7;
    const weekend = weekday >= 5;
    for (let k = 0; k < (weekend ? 3 : 6 + r.int(-1, 1)); k++) add(svc, 'routine');
    for (let k = 0; k < (weekend ? 1 : 3); k++) add(svc, 'specialist');
    if (!weekend) add(svc, 'inpatient');
    if (svc === ANOMALY_DATE) { add(svc, 'inpatient'); add(svc, 'inpatient'); for (let k = 0; k < 3; k++) add(svc, 'specialist'); }
  }
  // Seeded outliers (replace three routine claims in place, keeping their dates).
  const replace = (id: string, o: { billed?: number; days?: number }) => {
    const i = rows.findIndex((x) => x.CLM_ID === id);
    const old = rows[i];
    if (profileOf.get(id) !== 'routine') throw new Error(`seeded outlier ${id} is not a routine claim`);
    const billed = o.billed ?? Number(old.BILLED_AMT.replace('.', ''));
    const allowed = Math.floor(billed * 0.8); const paid = Math.floor(allowed * 0.9);
    daily.set(old.SVC_DT, daily.get(old.SVC_DT)! - Number(old.PAID_AMT.replace('.', '')) + paid);
    rows[i] = { ...old, BILLED_AMT: money(billed), ALLOWED_AMT: money(allowed), PAID_AMT: money(paid), RCVD_DT: o.days ? day(old.SVC_DT, o.days) : old.RCVD_DT };
  };
  replace(OUTLIER_IDS[0], { billed: 400_000 });
  replace(OUTLIER_IDS[1], { days: 120 });
  replace(OUTLIER_IDS[2], { billed: 150_000, days: 60 });
  return { rows, truth: { from, to: REF_DATE, claims: rows.length, dailyPaidCents: daily, profileOf, outliers: OUTLIER_IDS, anomalyDate: ANOMALY_DATE } };
}

/** Load plans, 150 members and the analytics claims into northwind through the API; returns ground truth. */
export async function loadAnalyticsDataset(nw: SubmitApi): Promise<AnalyticsTruth> {
  const members = nwMembers(150, 1);
  const ok = (r: { status: number; text?: string }, what: string) => { if (r.status !== 202 && r.status !== 200) throw new Error(`${what}: HTTP ${r.status} ${r.text ?? ''}`); };
  ok(await nw.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never)), 'plans');
  ok(await nw.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS)), 'members');
  const { rows, truth } = analyticsClaims(members.map((m) => m.MBR_ID));
  ok(await nw.csv('northwind', 'nw_medical_claims_csv', toCsv(rows as never, NW_CLAIM_COLUMNS)), 'claims');
  return truth;
}
