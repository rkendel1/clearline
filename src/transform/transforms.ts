// Whitelisted, declarative transformation operators. Tenants compose these in
// contracts; no tenant-supplied code or regular expressions are ever executed.

import type { TransformOp } from '../contracts/types.js';
import { isValidDate } from './coerce.js';

export class TransformError extends Error {}

/** Bump when any operator's behaviour changes; recorded on every canonical row. */
export const TRANSFORM_ENGINE_VERSION = '1.0.0';

export function applyTransform(op: TransformOp, v: string | null): string | null {
  switch (op.op) {
    case 'trim': return v === null ? null : v.trim();
    case 'upper': return v === null ? null : v.toUpperCase();
    case 'lower': return v === null ? null : v.toLowerCase();
    case 'strip_non_digits': return v === null ? null : v.replace(/[^0-9]/g, '');
    case 'left_pad': return v === null ? null : v.padStart(op.length, op.char);
    case 'default': return v === null || v === '' ? op.value : v;
    case 'map_values': {
      if (v === null) return null;
      if (Object.prototype.hasOwnProperty.call(op.map, v)) return op.map[v];
      if (op.unmapped === 'keep') return v;
      if (op.unmapped === 'null') return null;
      throw new TransformError(`value "${v}" has no mapping`);
    }
    case 'parse_date': {
      if (v === null) return null;
      const s = v.trim();
      let y: number, m: number, d: number;
      let match: RegExpExecArray | null;
      if (op.format === 'YYYY-MM-DD' && (match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [+match[1], +match[2], +match[3]];
      else if (op.format === 'MM/DD/YYYY' && (match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [y, m, d] = [+match[3], +match[1], +match[2]];
      else if (op.format === 'YYYYMMDD' && (match = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [y, m, d] = [+match[1], +match[2], +match[3]];
      else throw new TransformError(`expected date in ${op.format}`);
      if (!isValidDate(y, m, d)) throw new TransformError(`not a valid calendar date (${op.format})`);
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    case 'parse_timestamp': return v === null ? null : v.trim();
    case 'parse_decimal': {
      if (v === null) return null;
      let s = v.trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '');
      if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1); // accounting negatives
      if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new TransformError('not a decimal number');
      if (op.implied_scale) {
        if (s.includes('.')) throw new TransformError(`implied-scale amount must not contain a decimal point`);
        const neg = s.startsWith('-'); const digits = s.replace(/^[+-]/, '').padStart(op.implied_scale + 1, '0');
        s = `${neg ? '-' : ''}${digits.slice(0, -op.implied_scale)}.${digits.slice(-op.implied_scale)}`;
      }
      return s;
    }
    case 'parse_integer': {
      if (v === null) return null;
      const s = v.trim();
      if (!/^[+-]?\d+$/.test(s)) throw new TransformError('not an integer');
      return s;
    }
    case 'parse_boolean': {
      if (v === null) return null;
      const s = v.trim();
      if (op.true_values.includes(s)) return 'true';
      if (op.false_values.includes(s)) return 'false';
      throw new TransformError(`"${s}" is not a recognised boolean`);
    }
  }
}
