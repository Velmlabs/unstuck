import { describe, it, expect, vi } from 'vitest';
import { createRpcPeer, Methods, type RpcPeer } from '@unstuck/protocol';
import { createTunneledCdp } from '../src/tunnel';

function pair(): { engine: RpcPeer; sdk: RpcPeer } {
  let engine!: RpcPeer;
  let sdk!: RpcPeer;
  engine = createRpcPeer((l) => queueMicrotask(() => sdk.receive(l)));
  sdk = createRpcPeer((l) => queueMicrotask(() => engine.receive(l)));
  return { engine, sdk };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createTunneledCdp', () => {
  it('forwards send() as cdp.send with the pageId', async () => {
    const { engine, sdk } = pair();
    sdk.handle(Methods.cdpSend, (p) => ({ echo: (p as { method: string }).method, page: (p as { pageId: string }).pageId }));
    const cdp = createTunneledCdp(engine, 'p1');
    await expect(cdp.send('Runtime.evaluate', { expression: '1' })).resolves.toEqual({ echo: 'Runtime.evaluate', page: 'p1' });
  });

  it('subscribes once per event name and dispatches matching cdp.event notifications', async () => {
    const { engine, sdk } = pair();
    const subs: unknown[] = [];
    sdk.handle(Methods.cdpSubscribe, (p) => void subs.push(p));
    const cdp = createTunneledCdp(engine, 'p1');
    const a = vi.fn();
    const b = vi.fn();
    cdp.on('Page.screencastFrame', a);
    const offB = cdp.on('Page.screencastFrame', b);
    await tick();
    expect(subs).toEqual([{ pageId: 'p1', events: ['Page.screencastFrame'] }]);

    sdk.notify(Methods.cdpEvent, { pageId: 'p1', method: 'Page.screencastFrame', params: { n: 1 } });
    sdk.notify(Methods.cdpEvent, { pageId: 'other', method: 'Page.screencastFrame', params: { n: 2 } });
    sdk.notify(Methods.cdpEvent, { pageId: 'p1', method: 'Page.loadEventFired', params: {} });
    await tick();
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ n: 1 });

    offB();
    sdk.notify(Methods.cdpEvent, { pageId: 'p1', method: 'Page.screencastFrame', params: { n: 3 } });
    await tick();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a failing subscribe does not throw', async () => {
    const { engine } = pair();
    const cdp = createTunneledCdp(engine, 'p1');
    expect(() => cdp.on('X', () => {})).not.toThrow();
    await tick();
  });

  it('cdp.closed for this page fires onClose handlers once with the reason', async () => {
    const { engine, sdk } = pair();
    const cdp = createTunneledCdp(engine, 'p1');
    const h = vi.fn();
    const off2 = cdp.onClose(() => {});
    cdp.onClose(h);
    off2();
    sdk.notify(Methods.cdpClosed, { pageId: 'other', reason: 'x' });
    sdk.notify(Methods.cdpClosed, { pageId: 'p1', reason: 'page closed' });
    sdk.notify(Methods.cdpClosed, { pageId: 'p1', reason: 'again' });
    await tick();
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith('page closed');
  });

  it('onClose registered after the page closed fires immediately', async () => {
    const { engine, sdk } = pair();
    const cdp = createTunneledCdp(engine, 'p1');
    sdk.notify(Methods.cdpClosed, { pageId: 'p1', reason: 'gone' });
    await tick();
    const h = vi.fn();
    cdp.onClose(h);
    expect(h).toHaveBeenCalledWith('gone');
  });
});
