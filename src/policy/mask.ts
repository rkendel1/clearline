// Redaction styles. The database applies core.mask_value() (migration 0003) to
// query results; this TypeScript twin masks values on the other read surfaces
// (records, lineage, extracts, exceptions). test/unit/policy.test.ts checks
// that both produce identical output.

export type RedactionStyle = 'full' | 'last4' | 'first_initial' | 'year_only';
export const REDACTION_STYLES: readonly RedactionStyle[] = ['full', 'last4', 'first_initial', 'year_only'];

/** Which partial styles make sense for which field types; 'full' is valid for every type. */
export const STYLE_TYPES: Record<Exclude<RedactionStyle, 'full'>, readonly string[]> = {
  last4: ['string'],
  first_initial: ['string', 'enum'],
  year_only: ['date', 'timestamp'],
};

/** Strictness: lower reveals less. Moving to a higher number loosens a policy. */
export const STYLE_DISCLOSURE: Record<RedactionStyle, number> = { full: 0, year_only: 1, first_initial: 1, last4: 2 };

export const REDACTED_MARKER = '[redacted]';

const ALNUM = /[A-Za-z0-9]/;

export function maskValue(v: string | null, style: RedactionStyle, marker = REDACTED_MARKER): string | null {
  if (v === null) return null;
  switch (style) {
    case 'last4': {
      const chars = [...v];
      const total = chars.filter((c) => ALNUM.test(c)).length;
      if (total <= 4) return chars.map((c) => (ALNUM.test(c) ? '*' : c)).join('');
      let fromEnd = 0;
      const out = new Array<string>(chars.length);
      for (let i = chars.length - 1; i >= 0; i--) {
        const c = chars[i];
        if (ALNUM.test(c)) { fromEnd++; out[i] = fromEnd > 4 ? '*' : c; } else out[i] = c;
      }
      return out.join('');
    }
    case 'first_initial': return `${[...v][0] ?? ''}***`;
    case 'year_only': return /^\d{4}/.test(v) ? `${v.slice(0, 4)}-**-**` : marker;
    default: return marker;
  }
}
