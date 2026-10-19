// Source adapters turn a submitted payload into uniform raw rows
// (column -> string | null). They know nothing about canonical models: all
// meaning is applied later by the contract-driven transformation engine.

import { parse } from 'csv-parse/sync';

export interface ParsedRow { row_number: number; payload: Record<string, string | null> | null; parse_error: string | null }
export interface ParsedPayload { columns: string[]; rows: ParsedRow[] }

export class StructuralError extends Error {
  constructor(public reason: string, message: string, public details?: unknown) { super(message); }
}

export function parseCsv(buf: Buffer, maxRows: number): ParsedPayload {
  let records: string[][];
  try {
    records = parse(buf, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: false });
  } catch (err) {
    throw new StructuralError('unparseable_csv', `CSV could not be parsed: ${(err as Error).message.split('\n')[0]}`);
  }
  if (records.length === 0) throw new StructuralError('empty_payload', 'CSV has no header row');
  const header = records[0].map((h) => h.trim());
  if (header.some((h) => h === '')) throw new StructuralError('invalid_header', 'CSV header contains an empty column name');
  const dupes = header.filter((h, i) => header.indexOf(h) !== i);
  if (dupes.length) throw new StructuralError('invalid_header', `CSV header has duplicate columns: ${[...new Set(dupes)].join(', ')}`);
  if (records.length - 1 > maxRows) throw new StructuralError('too_many_rows', `Batch exceeds the ${maxRows} row limit`);
  if (records.length === 1) throw new StructuralError('empty_payload', 'CSV contains a header but no data rows');
  const rows: ParsedRow[] = records.slice(1).map((r, i) => {
    if (r.length !== header.length) {
      return { row_number: i + 1, payload: null, parse_error: `expected ${header.length} columns, found ${r.length}` };
    }
    const payload: Record<string, string | null> = {};
    header.forEach((h, j) => { payload[h] = r[j] === '' ? null : r[j]; });
    return { row_number: i + 1, payload, parse_error: null };
  });
  return { columns: header, rows };
}

export function parseJsonRecords(records: unknown, maxRows: number): ParsedPayload {
  if (!Array.isArray(records)) throw new StructuralError('invalid_envelope', '"records" must be an array');
  if (records.length === 0) throw new StructuralError('empty_payload', '"records" is empty');
  if (records.length > maxRows) throw new StructuralError('too_many_rows', `Batch exceeds the ${maxRows} row limit`);
  const columns = new Set<string>();
  const rows: ParsedRow[] = records.map((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return { row_number: i + 1, payload: null, parse_error: 'record is not a JSON object' };
    const payload: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      columns.add(k);
      if (v === null || v === undefined || v === '') payload[k] = null;
      else if (typeof v === 'string') payload[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') payload[k] = String(v);
      else return { row_number: i + 1, payload: null, parse_error: `field "${k}" is a nested ${Array.isArray(v) ? 'array' : 'object'}; only scalar values are supported` };
    }
    return { row_number: i + 1, payload, parse_error: null };
  });
  return { columns: [...columns], rows };
}
