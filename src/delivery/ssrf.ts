// Outbound destination safety for webhooks (server-side request forgery defence).
//
//  - https only (plain http and private targets only with WEBHOOK_ALLOW_PRIVATE, refused in production);
//  - no credentials in the URL, no unusual ports (443, 8443, or 1024-65535);
//  - the host is resolved once and EVERY resolved address must be public: loopback, private,
//    link-local (incl. cloud metadata 169.254.169.254), CGNAT, unique-local, multicast, reserved,
//    documentation and IPv4-mapped / NAT64-embedded forms of those are refused;
//  - the connection is pinned to the address that was checked (custom lookup), so a second DNS
//    answer cannot redirect it (DNS rebinding), and redirects are never followed.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class DestinationError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

function v4ToInt(a: string): number { return a.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0; }
const V4_BLOCKED: [string, number, string][] = [
  ['0.0.0.0', 8, 'this-network'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'carrier-grade NAT'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata)'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'IETF protocol assignments'], ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'], ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmarking'], ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
];

function v4Reason(a: string): string | null {
  const n = v4ToInt(a);
  for (const [base, bits, why] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (v4ToInt(base) & mask)) return why;
  }
  return null;
}

/** Expand an IPv6 address to 8 hextets (handles :: and an embedded dotted IPv4 tail). */
function expand6(a: string): number[] {
  let s = a.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const n = v4ToInt(v4[1]); s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

function v6Reason(a: string): string | null {
  const x = expand6(a);
  const embedded = () => `${x[6] >> 8}.${x[6] & 255}.${x[7] >> 8}.${x[7] & 255}`;
  if (x.every((h) => h === 0)) return 'unspecified';
  if (x.slice(0, 7).every((h) => h === 0) && x[7] === 1) return 'loopback';
  if (x.slice(0, 5).every((h) => h === 0) && x[5] === 0xffff) return v4Reason(embedded()) ?? null;   // IPv4-mapped
  if (x[0] === 0x64 && x[1] === 0xff9b && x.slice(2, 6).every((h) => h === 0)) return v4Reason(embedded()) ?? null; // NAT64
  if ((x[0] & 0xfe00) === 0xfc00) return 'unique-local';
  if ((x[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((x[0] & 0xff00) === 0xff00) return 'multicast';
  if (x[0] === 0x2001 && x[1] === 0x0db8) return 'documentation';
  if (x[0] === 0x2002) return v4Reason(`${x[1] >> 8}.${x[1] & 255}.${x[2] >> 8}.${x[2] & 255}`) ?? null; // 6to4
  return null;
}

/** Why an address may not be contacted, or null when it is a public unicast address. */
export function blockedReason(address: string): string | null {
  const fam = isIP(address);
  if (fam === 4) return v4Reason(address);
  if (fam === 6) return v6Reason(address);
  return 'not an IP address';
}

export interface CheckedTarget { url: URL; address: string; family: number }

/** Syntactic checks (no network): scheme, credentials, port. */
export function checkUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DestinationError('invalid_url', 'The endpoint is not a valid URL.'); }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new DestinationError('https_required', 'Webhook endpoints must use https.');
  if (url.username || url.password) throw new DestinationError('credentials_in_url', 'Put credentials in the destination\'s secret reference, not in the URL.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!allowPrivate && !(port === 443 || port === 8443 || port >= 1024)) throw new DestinationError('port_not_allowed', `Port ${port} is not allowed for webhooks.`);
  if (raw.length > 2000) throw new DestinationError('invalid_url', 'The endpoint URL is too long.');
  return url;
}

/** Resolve and check every address; return the one to connect to (the connection is pinned to it). */
export async function resolveTarget(raw: string, opts: { allowPrivate: boolean; resolver?: Resolver }): Promise<CheckedTarget> {
  const url = checkUrl(raw, opts.allowPrivate);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: { address: string; family: number }[];
  if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
  else {
    try { addrs = await (opts.resolver ?? systemResolver)(host); } catch { throw new DestinationError('dns_failure', `The endpoint host ${host} could not be resolved.`); }
    if (!addrs.length) throw new DestinationError('dns_failure', `The endpoint host ${host} has no addresses.`);
  }
  if (!opts.allowPrivate) {
    for (const a of addrs) {
      const why = blockedReason(a.address);
      if (why) throw new DestinationError('private_address', `The endpoint resolves to a ${why} address (${a.address}); webhooks may only target public addresses.`);
    }
  }
  return { url, address: addrs[0].address, family: addrs[0].family };
}
