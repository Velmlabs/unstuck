import { describe, it, expect } from 'vitest';
import { ipKey } from '../src/ip-key';

describe('ipKey: the unit per-IP limits count', () => {
  it('an IPv4 address is itself', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });
  it('IPv6 counts by /64 (one subscriber usually has a whole /64, so per-address limits are free to dodge)', () => {
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
  });
  it('IPv4-mapped IPv6 is the IPv4 address; anything unparsable is kept as it is', () => {
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('unknown')).toBe('unknown');
    expect(ipKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
  });
});
