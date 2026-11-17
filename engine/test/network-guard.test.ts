import { describe, it, expect } from 'vitest';
import { blockedHost, isPrivateAddress } from '../src/browser/network-guard';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::5', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])(
    '%s is private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('blockedHost', () => {
  const lookup = (map: Record<string, string[]>) => async (host: string) => (map[host] ?? []).map((address) => ({ address }));
  it('blocks local names and IP literals without a lookup', async () => {
    const none = async () => {
      throw new Error('no lookup expected');
    };
    for (const h of ['localhost', 'foo.localhost', 'metadata.google.internal', '127.0.0.1', '[::1]', '169.254.169.254']) expect(await blockedHost(h, none), h).toBe(true);
    expect(await blockedHost('8.8.8.8', none)).toBe(false);
  });
  it('blocks a name that resolves to any private address, and lets public ones and lookup failures through', async () => {
    const l = lookup({ 'intranet.corp': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'], 'shop.example': ['93.184.216.34'] });
    expect(await blockedHost('intranet.corp', l)).toBe(true);
    expect(await blockedHost('mixed.example', l)).toBe(true);
    expect(await blockedHost('shop.example', l)).toBe(false);
    expect(
      await blockedHost('nx.example', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toBe(false);
  });
});
