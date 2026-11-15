import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCdp } from '@velmlabs/unstuck-core/testing';
import { Unstuck, UnstuckConfigError, type TakeoverLink } from '@velmlabs/unstuck';
import { FetchWs, viewerFor, waitFor } from '../../relay-cloudflare/test/helpers';

/** A Puppeteer-shaped page whose CDP session is a FakeCdp. */
function fakePuppeteerPage(cdp: FakeCdp) {
  return {
    url: () => 'https://shop.example/cart',
    isClosed: () => false,
    createCDPSession: async () => ({ send: (m: string, p?: object) => cdp.send(m, p), on: (e: string, cb: (p: unknown) => void) => cdp.on(e, cb), detach: async () => {} }),
    on: () => {},
    off: () => {},
  };
}

beforeEach(() => {
  FetchWs.all = [];
  // No real network inside workerd tests: the engine's relay socket goes to the relay Worker in this miniflare.
  vi.stubGlobal('WebSocket', FetchWs);
});
afterEach(() => vi.unstubAllGlobals());

describe('Unstuck in workerd (edge entry)', () => {
  it('resolves a takeover inside workerd', async () => {
    const links: TakeoverLink[] = [];
    const u = new Unstuck({ relay: 'wss://relay.test', agentKey: 'K', onLink: (l) => links.push(l) });
    const result = u.takeover(fakePuppeteerPage(new FakeCdp()), { reason: 'Solve the CAPTCHA', timeoutS: 60 });
    await waitFor(() => links.length > 0);
    expect(links[0]).toMatchObject({ reason: 'Solve the CAPTCHA', url: expect.stringMatching(/^https:\/\/relay\.test\/s\//) });
    const viewer = await viewerFor(links[0]!.url);
    await viewer.send({ t: 'hello', token: viewer.token });
    await waitFor(() => viewer.json.some((m) => m.t === 'ready'));
    await viewer.send({ t: 'done' });
    expect(await result).toMatchObject({ status: 'resolved', sessionId: links[0]!.sessionId });
    await u.close();
  });

  it('the workerd build picked the edge entry', async () => {
    // Only the edge/in-process path throws this; the Node entry would try to spawn the engine process instead.
    const p = new Unstuck({}).takeover(fakePuppeteerPage(new FakeCdp()), { reason: 'x' });
    await expect(p).rejects.toThrow(UnstuckConfigError);
    await expect(p).rejects.toThrow('in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey');
  });

  it('a wrong agent key ends in failed/relay_unauthorized, not a hang', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = new Unstuck({ relay: 'wss://relay.test', agentKey: 'WRONG', onLink: () => {} });
    expect(await u.takeover(fakePuppeteerPage(new FakeCdp()), { reason: 'x', timeoutS: 30 })).toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
    expect(error.mock.calls.flat().join()).not.toContain('WRONG');
    await u.close();
  });
});
