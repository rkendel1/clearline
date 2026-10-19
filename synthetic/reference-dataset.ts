// The reference dataset used by Scenario J, the dashboard end-to-end test and
// the demo. It deliberately mixes every condition the platform must handle —
// valid rows, structural and business-rule defects, corrections, an exact
// redelivery, an untrusted (non-reconciling) batch, JSON and CSV sources, two
// tenants — and returns the ground truth computed from the generated rows
// alone, so the platform's outputs can be checked against something it did not
// produce.

import { NW_PLANS, nwMembers, nwClaims, nwPharmacy, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, BF_PLANS, bfEnrollees, bfClaims, BF_ENROLLEE_COLUMNS, BF_CLAIM_COLUMNS, centsOf, fromCents, type NwClaim } from './generator.js';

export interface SubmitApi {
  csv(tenant: string, source: string, body: Buffer, opts?: { reportedAt?: string; control?: unknown }): Promise<{ status: number; body: any }>;
  json(tenant: string, source: string, records: unknown[], opts?: { reportedAt?: string; control?: unknown }): Promise<{ status: number; body: any }>;
}

export interface Truth {
  northwind: Record<string, string>;
  bluefin: Record<string, string>;
  trustedClaimIds: string[];
  quarantinedClaimRows: number;
  untrustedClaimRows: number;
  batches: { northwind: number; bluefin: number };
  duplicateSubmissions: number;
}

const sumC = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export async function loadReferenceDataset(nw: SubmitApi, bf: SubmitApi): Promise<Truth> {
  // ------------------------------------------------------------- Northwind
  const members = nwMembers(150, 1001);
  const ids = members.map((m) => m.MBR_ID);
  const claimsA = nwClaims(400, ids, 1002);
  // Three defective rows (index -> defect), all genuinely invalid under contract v1.
  claimsA[7] = { ...claimsA[7], SVC_DT: '2026-02-30' };                                               // structural: not a date
  const p50 = claimsA.findIndex((c, i) => i >= 50 && c.CLM_STATUS === 'P');
  claimsA[p50] = { ...claimsA[p50], PAID_AMT: fromCents(centsOf(claimsA[p50].BILLED_AMT) + 100) };    // rule paid_le_billed
  const d90 = claimsA.findIndex((c, i) => i >= 90 && c.CLM_STATUS === 'D');
  claimsA[d90] = { ...claimsA[d90], PAID_AMT: '12.34' };                                               // rule denied_zero_paid
  const badIdx = new Set([7, p50, d90]);

  // Corrections: 25 valid claims re-adjudicated (sequence 2) as PAID at half the allowed amount.
  const corrected: NwClaim[] = [];
  for (let i = 100; corrected.length < 25; i++) {
    if (badIdx.has(i)) continue;
    const c = claimsA[i];
    corrected.push({ ...c, CLM_STATUS: 'P', PAID_AMT: fromCents(Math.floor(centsOf(c.ALLOWED_AMT) / 2)), ADJ_SEQ: '2' });
  }
  // A batch whose control count disagrees with its contents: processed, but untrusted.
  const claimsC = nwClaims(60, ids, 1003, 20_001);
  const pharmacy = nwPharmacy(120, ids, 1004);

  const ok = (r: { status: number }, what: string) => { if (r.status >= 300 && r.status !== 200) throw new Error(`${what}: HTTP ${r.status}`); };
  ok(await nw.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never), { reportedAt: '2026-09-01T00:00:00Z' }), 'plans');
  ok(await nw.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS), { reportedAt: '2026-09-30T01:00:00Z', control: { record_count: 150 } }), 'members');
  const aCsv = toCsv(claimsA as never, NW_CLAIM_COLUMNS);
  const aControl = { record_count: 400, sums: { billed_amount: fromCents(sumC(claimsA.map((c) => centsOf(c.BILLED_AMT)))) } };
  ok(await nw.csv('northwind', 'nw_medical_claims_csv', aCsv, { reportedAt: '2026-09-30T02:00:00Z', control: aControl }), 'claims A');
  ok(await nw.csv('northwind', 'nw_medical_claims_csv', toCsv(corrected as never, NW_CLAIM_COLUMNS), { reportedAt: '2026-10-01T02:00:00Z', control: { record_count: 25 } }), 'corrections');
  ok(await nw.csv('northwind', 'nw_medical_claims_csv', aCsv, { reportedAt: '2026-09-30T02:00:00Z', control: aControl }), 'claims A redelivered');
  ok(await nw.csv('northwind', 'nw_medical_claims_csv', toCsv(claimsC as never, NW_CLAIM_COLUMNS), { reportedAt: '2026-10-02T02:00:00Z', control: { record_count: 61 } }), 'claims C');
  ok(await nw.json('northwind', 'nw_pharmacy_api', pharmacy, { reportedAt: '2026-10-02T03:00:00Z', control: { record_count: 120, sums: { plan_paid: fromCents(sumC(pharmacy.map((p) => centsOf(p.planPaid)))) } } }), 'pharmacy');

  // Northwind truth: current trusted claims = valid A rows with corrections applied (C is untrusted).
  const current = new Map<string, NwClaim>();
  claimsA.forEach((c, i) => { if (!badIdx.has(i)) current.set(c.CLM_ID, c); });
  for (const c of corrected) current.set(c.CLM_ID, c);
  const cur = [...current.values()];
  const nwTruth: Record<string, string> = {
    members_total: String(members.length),
    active_members: String(members.filter((m) => m.MBR_STATUS === 'A').length),
    claims_total: String(cur.length),
    paid_claims: String(cur.filter((c) => c.CLM_STATUS === 'P').length),
    denied_claims: String(cur.filter((c) => c.CLM_STATUS === 'D').length),
    total_paid: fromCents(sumC(cur.filter((c) => c.CLM_STATUS === 'P' || c.CLM_STATUS === 'R').map((c) => centsOf(c.PAID_AMT)))),
    total_billed: fromCents(sumC(cur.map((c) => centsOf(c.BILLED_AMT)))),
    rx_fills: String(pharmacy.filter((p) => p.status === 'FILLED').length),
    rx_plan_paid: fromCents(sumC(pharmacy.filter((p) => p.status === 'FILLED').map((p) => centsOf(p.planPaid)))),
  };

  // --------------------------------------------------------------- Bluefin
  const enrollees = bfEnrollees(40, 1011);
  const rx = bfClaims(300, enrollees as never, 1012);
  ok(await bf.json('bluefin', 'bf_plans_api', BF_PLANS, { reportedAt: '2026-09-01T00:00:00Z' }), 'bf plans');
  ok(await bf.csv('bluefin', 'bf_enrollment_csv', toCsv(enrollees as never, BF_ENROLLEE_COLUMNS), { reportedAt: '2026-09-30T00:00:00Z', control: { record_count: enrollees.length } }), 'bf enrollees');
  ok(await bf.csv('bluefin', 'bf_rx_claims_csv', toCsv(rx as never, BF_CLAIM_COLUMNS), { reportedAt: '2026-10-01T00:00:00Z',
    control: { record_count: rx.length, sums: { plan_cost: fromCents(sumC(rx.map((r) => Number(r.PLAN_C)))), total_cost: fromCents(sumC(rx.map((r) => Number(r.TOTAL_C)))) } } }), 'bf rx');
  const approved = rx.filter((r) => r.STATE === 'A');
  const avgCopayCents = sumC(approved.map((r) => Number(r.COPAY_C))) / approved.length;
  const bfTruth: Record<string, string> = {
    active_enrollees: String(enrollees.filter((e) => !e.TERM_DT).length),
    approved_rx_claims: String(approved.length),
    plan_cost_total: fromCents(sumC(approved.map((r) => Number(r.PLAN_C)))),
    avg_copay: (avgCopayCents / 100).toFixed(4),
    utilizing_enrollees: String(new Set(approved.map((r) => `${r.SUB_ID}-${r.DEP_SEQ}`)).size),
  };

  return {
    northwind: nwTruth, bluefin: bfTruth, trustedClaimIds: [...current.keys()].sort(),
    quarantinedClaimRows: badIdx.size, untrustedClaimRows: claimsC.length,
    batches: { northwind: 6, bluefin: 3 }, duplicateSubmissions: 1,
  };
}
