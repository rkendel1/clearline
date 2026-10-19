// Detection of sensitive data in unexpected places: values that look like
// identifiers or contact details appearing in unmapped source columns or in
// fields the contract classifies as non-sensitive.

const DETECTORS: { kind: string; re: RegExp }[] = [
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { kind: 'phone', re: /(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.]\d{4}\b/ },
];

const SUSPICIOUS_COLUMN = /(ssn|social.?sec|birth|dob|e.?mail|phone|address|first.?name|last.?name|patient.?name)/i;

export function detectSensitiveValue(v: string): string | null {
  for (const d of DETECTORS) if (d.re.test(v)) return d.kind;
  return null;
}

export function isSuspiciousColumnName(name: string): boolean {
  return SUSPICIOUS_COLUMN.test(name);
}
