import { describe, expect, it } from 'vitest';
import { ipv6ToBigInt, isBlockedIp } from '../src/net/ip-guard.ts';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.100.100.200', '100.64.0.1', '0.0.0.0', '255.255.255.255', '224.0.0.1',
    '198.18.0.1', '192.0.2.10',
  ])('blocks private/reserved IPv4 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '2002:7f00:1::',
    '2002:c0a8:0101::1', '2001:db8::1', '2001::1', '[::1]', 'fec0::1', '64:ff9b:1::1',
  ])('blocks special IPv6 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.215.14', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1'])(
    'allows public address %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it.each(['localhost', 'example.com', '', '999.1.1.1', '1.2.3', 'fe80::1::2'])('blocks non-IP input %s', (v) => {
    expect(isBlockedIp(v)).toBe(true);
  });

  it('expands IPv6 forms consistently', () => {
    expect(ipv6ToBigInt('::ffff:127.0.0.1')).toBe(ipv6ToBigInt('::ffff:7f00:1'));
    expect(ipv6ToBigInt('0:0:0:0:0:0:0:1')).toBe(1n);
  });
});
