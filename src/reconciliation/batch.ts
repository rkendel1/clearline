// Batch reconciliation: does what landed in the target match what the source
// said it sent, and does every received row have exactly one accounted-for
// disposition? Each check carries expected/actual/difference and a
// plain-language explanation so an operator can act without reading code.

import { addDecimal, subDecimal, compareCanonical } from '../transform/coerce.js';

export interface ReconResult {
  check_id: string;
  status: 'passed' | 'failed';
  expected: unknown;
  actual: unknown;
  difference: unknown;
  explanation: string;
}

export interface BatchTallies {
  received: number;
  accepted: number;        // canonical versions written (current + historical)
  quarantined: number;
  duplicates: number;
  control?: { record_count?: number; sums?: Record<string, string> } | null;
  sums: Record<string, { received: string; unparseable_rows: number; accepted: string; quarantined: string; duplicate: string }>;
  target: { rows: number; sums: Record<string, string> };
}

const isZero = (d: string) => !/[1-9]/.test(d);

export function reconcileBatch(t: BatchTallies): ReconResult[] {
  const out: ReconResult[] = [];
  const accounted = t.accepted + t.quarantined + t.duplicates;
  out.push({
    check_id: 'row_accounting',
    status: accounted === t.received ? 'passed' : 'failed',
    expected: { received: t.received },
    actual: { accepted: t.accepted, quarantined: t.quarantined, duplicates: t.duplicates, total: accounted },
    difference: { rows: t.received - accounted },
    explanation: accounted === t.received
      ? `All ${t.received} received rows are accounted for: ${t.accepted} accepted, ${t.quarantined} quarantined, ${t.duplicates} exact duplicates.`
      : `${t.received - accounted} received rows have no recorded disposition (internal processing defect).`,
  });
  out.push({
    check_id: 'target_row_count',
    status: t.target.rows === t.accepted ? 'passed' : 'failed',
    expected: { accepted: t.accepted },
    actual: { persisted: t.target.rows },
    difference: { rows: t.target.rows - t.accepted },
    explanation: t.target.rows === t.accepted
      ? `Target table holds exactly the ${t.accepted} versions this batch accepted.`
      : `Target holds ${t.target.rows} rows for this batch but ${t.accepted} were accepted; ${Math.abs(t.target.rows - t.accepted)} ${t.target.rows > t.accepted ? 'unexpected' : 'missing'}.`,
  });
  if (t.control?.record_count !== undefined) {
    const exp = t.control.record_count;
    const diff = t.received - exp;
    out.push({
      check_id: 'source_control_count',
      status: diff === 0 ? 'passed' : 'failed',
      expected: { source_declared: exp },
      actual: { received: t.received },
      difference: { rows: diff },
      explanation: diff === 0
        ? `Received row count matches the sender's control count (${exp}).`
        : diff < 0
          ? `Sender declared ${exp} rows but ${t.received} arrived: ${-diff} row(s) missing in transit or omitted from the file. Request a corrected file from the source.`
          : `Sender declared ${exp} rows but ${t.received} arrived: ${diff} unexpected extra row(s). Check for duplicated or appended data.`,
    });
  }
  for (const [field, s] of Object.entries(t.sums)) {
    const declared = t.control?.sums?.[field];
    if (declared !== undefined) {
      const diff = subDecimal(s.received, declared);
      const ok = isZero(diff) && s.unparseable_rows === 0;
      out.push({
        check_id: `source_control_sum:${field}`,
        status: ok ? 'passed' : 'failed',
        expected: { source_declared: declared },
        actual: { received: s.received, unparseable_rows: s.unparseable_rows },
        difference: { amount: diff },
        explanation: ok
          ? `Sum of ${field} across received rows matches the sender's control total (${declared}).`
          : `Sum of ${field} across received rows is ${s.received} vs declared ${declared} (difference ${diff})` +
            (s.unparseable_rows ? `; ${s.unparseable_rows} row(s) had an unreadable ${field} and could not be counted.` : '.') +
            (compareCanonical('decimal', diff, '0') < 0 ? ' Value is missing relative to the control total.' : isZero(diff) ? '' : ' Value exceeds the control total.'),
      });
    }
    const breakdown = addDecimal(addDecimal(s.accepted, s.quarantined), s.duplicate);
    const accountingDiff = subDecimal(s.received, breakdown);
    out.push({
      check_id: `financial_accounting:${field}`,
      status: isZero(accountingDiff) ? 'passed' : 'failed',
      expected: { received: s.received },
      actual: { accepted: s.accepted, quarantined: s.quarantined, duplicate: s.duplicate },
      difference: { amount: accountingDiff },
      explanation: `${field}: ${s.accepted} accepted into canonical data, ${s.quarantined} held in quarantine, ${s.duplicate} in exact duplicates (no effect).`,
    });
    const persisted = t.target.sums[field] ?? '0';
    const targetDiff = subDecimal(persisted, s.accepted);
    out.push({
      check_id: `target_sum:${field}`,
      status: isZero(targetDiff) ? 'passed' : 'failed',
      expected: { accepted: s.accepted },
      actual: { persisted },
      difference: { amount: targetDiff },
      explanation: isZero(targetDiff)
        ? `Persisted ${field} total equals the accepted total (${s.accepted}).`
        : `Persisted ${field} total ${persisted} differs from accepted total ${s.accepted} by ${targetDiff}.`,
    });
  }
  return out;
}
