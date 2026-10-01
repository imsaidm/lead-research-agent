import { isIP } from 'node:net';

/**
 * SSRF IP policy. Returns true when an address must NOT be connected to:
 * private, loopback, link-local, CGNAT, metadata, multicast, reserved and
 * documentation ranges (IPv4 + IPv6). IPv6 is allow-listed to global unicast
 * (2000::/3) minus special-purpose blocks; IPv4 embedded in IPv6
 * (mapped, compatible, NAT64, 6to4) is unwrapped and checked as IPv4.
 * Anything that does not parse is blocked.
 */

type Cidr = readonly [bigint, number];

const V4_BLOCKED: readonly string[] = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // private
  '100.64.0.0/10', // CGNAT (also Alibaba metadata 100.100.100.200)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local + cloud metadata 169.254.169.254
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
];

const V6_BLOCKED: readonly string[] = [
  '2001::/23', // IETF protocol assignments incl. Teredo 2001::/32
  '2001:db8::/32', // documentation
  '3fff::/20', // documentation (RFC 9637)
  '64:ff9b:1::/48', // local-use NAT64
];

export function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) + BigInt(n);
  }
  return value;
}

/** Expands any valid IPv6 text form (incl. trailing dotted quad) to a 128-bit integer. */
export function ipv6ToBigInt(input: string): bigint | null {
  const ip = input.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (isIP(ip) !== 6) return null;
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    const hi = Number(v4 >> 16n).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const headParts = head ? head.split(':') : [];
  const restParts = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - headParts.length - restParts.length;
  if (rest === undefined && missing !== 0) return null;
  if (rest !== undefined && missing < 1) return null;
  const groups = [...headParts, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...restParts];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

function parseCidr(cidr: string, bits: 32 | 128): Cidr {
  const [addr = '', len = ''] = cidr.split('/');
  const value = bits === 32 ? ipv4ToBigInt(addr) : ipv6ToBigInt(addr);
  if (value === null) throw new Error(`bad CIDR in policy: ${cidr}`);
  return [value, Number(len)] as const;
}

function inCidr(value: bigint, [base, len]: Cidr, bits: 32 | 128): boolean {
  const shift = BigInt(bits - len);
  return value >> shift === base >> shift;
}

const V4_RANGES = V4_BLOCKED.map((c) => parseCidr(c, 32));
const V6_RANGES = V6_BLOCKED.map((c) => parseCidr(c, 128));
const V6_GLOBAL_UNICAST = parseCidr('2000::/3', 128);
const V6_MAPPED = parseCidr('::ffff:0:0/96', 128);
const V6_COMPAT = parseCidr('::/96', 128);
const V6_NAT64 = parseCidr('64:ff9b::/96', 128);
const V6_6TO4 = parseCidr('2002::/16', 128);

function isBlockedV4(value: bigint): boolean {
  return V4_RANGES.some((r) => inCidr(value, r, 32));
}

function isBlockedV6(value: bigint): boolean {
  if (inCidr(value, V6_MAPPED, 128) || inCidr(value, V6_COMPAT, 128) || inCidr(value, V6_NAT64, 128)) {
    // ::/96 includes :: and ::1, whose embedded "IPv4" (0.0.0.0 / 0.0.0.1) is blocked anyway.
    return isBlockedV4(value & 0xffffffffn);
  }
  if (inCidr(value, V6_6TO4, 128)) {
    return isBlockedV4((value >> 80n) & 0xffffffffn);
  }
  if (!inCidr(value, V6_GLOBAL_UNICAST, 128)) return true; // ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, ...
  return V6_RANGES.some((r) => inCidr(value, r, 128));
}

export function isBlockedIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const version = isIP(ip.split('%')[0] ?? '');
  if (version === 4) {
    const v = ipv4ToBigInt(ip);
    return v === null || isBlockedV4(v);
  }
  if (version === 6) {
    const v = ipv6ToBigInt(ip);
    return v === null || isBlockedV6(v);
  }
  return true;
}
