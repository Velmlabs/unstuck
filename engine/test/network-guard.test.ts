import { describe, it, expect } from 'vitest';
import { blockedHost, guardNetwork, isPrivateAddress } from '../src/browser/network-guard';

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

describe('guardNetwork', () => {
  function fakeCdp() {
    let paused: ((p: { requestId: string; request: { url: string } }) => void) | undefined;
    const sent: [string, unknown][] = [];
    const cdp = {
      on: (event: string, fn: typeof paused) => {
        if (event === 'Fetch.requestPaused') paused = fn;
      },
      send: async (method: string, params?: unknown) => {
        sent.push([method, params]);
        return {};
      },
    };
    const pause = async (requestId: string, url: string) => {
      paused!({ requestId, request: { url } });
      await new Promise((r) => setTimeout(r, 0));
    };
    return { cdp: cdp as never, sent, pause };
  }

  it('pauses every request, fails the private ones (onBlock gets the host) and continues the rest', async () => {
    const { cdp, sent, pause } = fakeCdp();
    const blocked: string[] = [];
    await guardNetwork(cdp, { isBlocked: async (u) => u.hostname === 'intranet.corp', onBlock: (h) => blocked.push(h) });
    expect(sent[0]).toEqual(['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }]);
    await pause('1', 'https://intranet.corp/admin');
    await pause('2', 'https://shop.example/');
    await pause('3', 'data:text/plain,hi'); // not http(s)/ws(s): the browser's own
    await pause('4', 'not a url');
    expect(blocked).toEqual(['intranet.corp']);
    expect(sent.slice(1)).toEqual([
      ['Fetch.failRequest', { requestId: '1', errorReason: 'BlockedByClient' }],
      ['Fetch.continueRequest', { requestId: '2' }],
      ['Fetch.continueRequest', { requestId: '3' }],
      ['Fetch.continueRequest', { requestId: '4' }],
    ]);
  });

  it('by default blocks localhost and private IPs, with no lookup needed', async () => {
    const { cdp, sent, pause } = fakeCdp();
    const blocked: string[] = [];
    await guardNetwork(cdp, { onBlock: (h) => blocked.push(h) });
    await pause('1', 'http://localhost:8080/');
    await pause('2', 'ws://127.0.0.1:9222/devtools');
    expect(blocked).toEqual(['localhost', '127.0.0.1']);
    expect(sent.filter(([m]) => m === 'Fetch.failRequest')).toHaveLength(2);
  });

  it('without a lookup, a name is resolved by DNS (a name that does not exist is let through)', async () => {
    expect(await blockedHost('unstuck-test.invalid')).toBe(false);
  });

  it('a continue that fails (the tab closed) is ignored too', async () => {
    const { cdp, pause } = fakeCdp();
    (cdp as unknown as { send: (m: string) => Promise<unknown> }).send = async (m: string) => {
      if (m !== 'Fetch.enable') throw new Error('Target closed');
      return {};
    };
    await guardNetwork(cdp, { isBlocked: async () => false, onBlock: () => {} });
    await expect(pause('1', 'https://a.example/')).resolves.toBeUndefined();
  });

  it('a send that fails (the tab closed) is ignored', async () => {
    const { cdp, pause } = fakeCdp();
    (cdp as unknown as { send: (m: string) => Promise<unknown> }).send = async (m: string) => {
      if (m !== 'Fetch.enable') throw new Error('Target closed');
      return {};
    };
    await guardNetwork(cdp, { isBlocked: async () => true, onBlock: () => {} });
    await expect(pause('1', 'https://a.example/')).resolves.toBeUndefined();
  });
});
