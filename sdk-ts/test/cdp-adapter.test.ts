import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AttachedPage } from '../src/attach';
import { startKeepAlive, toCdpClient } from '../src/cdp-adapter';

/** An AttachedPage whose CDP session is in memory. */
function fakePage(send: (method: string, params?: object) => Promise<unknown> = async () => ({})) {
  const subs = new Map<string, ((p: unknown) => void)[]>();
  const closeCbs: ((reason: string) => void)[] = [];
  const page: AttachedPage & { emit(e: string, p: unknown): void; close(reason: string): void; subscribeCalls: string[] } = {
    pageId: 'page-1',
    url: () => 'https://shop.example/',
    send: vi.fn(send),
    subscribeCalls: [],
    subscribe(event, cb) {
      page.subscribeCalls.push(event);
      subs.set(event, [...(subs.get(event) ?? []), cb]);
    },
    onClose: (cb) => void closeCbs.push(cb),
    detach: async () => {},
    emit: (e, p) => subs.get(e)?.forEach((cb) => cb(p)),
    close: (reason) => closeCbs.forEach((cb) => cb(reason)),
  };
  return page;
}

afterEach(() => vi.useRealTimers());

describe('toCdpClient', () => {
  it('forwards send to the page', async () => {
    const page = fakePage(async (m) => ({ echoed: m }));
    await expect(toCdpClient(page).send('Page.enable', { a: 1 })).resolves.toEqual({ echoed: 'Page.enable' });
    expect(page.send).toHaveBeenCalledWith('Page.enable', { a: 1 });
  });

  it('subscribes once per event for two handlers; the remover stops only its handler', () => {
    const page = fakePage();
    const cdp = toCdpClient(page);
    const a = vi.fn();
    const b = vi.fn();
    const offA = cdp.on('Page.screencastFrame', a);
    cdp.on('Page.screencastFrame', b);
    expect(page.subscribeCalls).toEqual(['Page.screencastFrame']);
    page.emit('Page.screencastFrame', { n: 1 });
    offA();
    page.emit('Page.screencastFrame', { n: 2 });
    expect(a.mock.calls).toEqual([[{ n: 1 }]]);
    expect(b.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    // A handler added again after removal reuses the existing subscription.
    cdp.on('Page.screencastFrame', a);
    expect(page.subscribeCalls).toEqual(['Page.screencastFrame']);
  });

  it('onClose fires handlers with the reason, and a removed handler is not called', () => {
    const page = fakePage();
    const cdp = toCdpClient(page);
    const kept = vi.fn();
    const removed = vi.fn();
    cdp.onClose(kept);
    cdp.onClose(removed)();
    page.close('page closed');
    expect(kept).toHaveBeenCalledWith('page closed');
    expect(removed).not.toHaveBeenCalled();
  });

  it('a handler added after close is called with the recorded reason on a microtask', async () => {
    const page = fakePage();
    const cdp = toCdpClient(page);
    page.close('page crashed');
    const late = vi.fn();
    cdp.onClose(late);
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledWith('page crashed');
    // Removed before the microtask runs: never called.
    const cancelled = vi.fn();
    cdp.onClose(cancelled)();
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('startKeepAlive', () => {
  it('evaluates a constant every 60 s, not before', async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const stop = startKeepAlive(toCdpClient(page));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(page.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.send).toHaveBeenCalledTimes(1);
    expect(page.send).toHaveBeenLastCalledWith('Runtime.evaluate', { expression: '0' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.send).toHaveBeenCalledTimes(2);
    stop();
  });

  it('swallows a rejecting ping', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const page = fakePage(() => Promise.reject(new Error('target closed')));
      const stop = startKeepAlive(toCdpClient(page), 1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(page.send).toHaveBeenCalledTimes(3);
      stop();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('stop clears the timer', async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const stop = startKeepAlive(toCdpClient(page));
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(page.send).not.toHaveBeenCalled();
  });
});
