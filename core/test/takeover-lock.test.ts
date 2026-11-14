// A takeover is locked to its page: a link holder can't take the agent's browser to other sites (spec: page lock).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakePopups, FakeTransport } from '../src/testing';
import { createEngine, type LinkInfo } from '../src/engine';
import { MemoryEventLog } from '../src/events';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { settle } from './settle';

function setup(opts: { allowedSites?: string[]; prepare?: (cdp: FakeCdp) => void } = {}) {
  const transport = new FakeTransport();
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN', url: 'https://shop.example.com/login' } } }));
  opts.prepare?.(cdp);
  const popups = new FakePopups();
  const log = new MemoryEventLog();
  const links: LinkInfo[] = [];
  const order: string[] = [];
  const engine = createEngine({ transport, log, onLink: (l) => (links.push(l), order.push('link')) });
  const orig = cdp.send.bind(cdp);
  cdp.send = (m: string, p?: object) => (order.push(m), orig(m, p)) as never;
  let result: TakeoverResult | undefined;
  void engine.takeover(cdp, { reason: 'Solve it', popups, timeoutS: 60, ...(opts.allowedSites ? { allowedSites: opts.allowedSites } : {}) }).then((r) => (result = r));
  const join = async () => {
    const token = new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token });
    await settle();
    return v;
  };
  return { cdp, popups, log, links, order, join, result: () => result };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('page lock during a takeover', () => {
  it('the page is locked before any link exists, and unlocked when the takeover ends', async () => {
    const t = setup();
    await settle();
    expect(t.order.indexOf('Fetch.enable')).toBeGreaterThan(-1);
    expect(t.order.indexOf('Fetch.enable')).toBeLessThan(t.order.indexOf('link'));
    const v = await t.join();
    v.push({ t: 'done' });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'resolved' });
    expect(t.cdp.methods()).toContain('Fetch.disable');
  });

  it('a navigation off the site is stopped and logged by host only (never the full URL)', async () => {
    const t = setup({ allowedSites: ['accounts.google.com'] });
    await settle();
    t.cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'MAIN', request: { url: 'https://mail.google.com/mail/u/0/#inbox?secret=1' } });
    t.cdp.emit('Fetch.requestPaused', { requestId: 'r2', frameId: 'MAIN', request: { url: 'https://accounts.google.com/x' } });
    await settle();
    expect(t.cdp.calls.filter((c) => c.method === 'Fetch.failRequest')).toHaveLength(1);
    const blocked = t.log.events.filter((e) => e.type === 'navigation_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.data).toEqual({ host: 'mail.google.com' });
    expect(JSON.stringify(blocked[0])).not.toContain('secret');
  });

  it('fails closed: if the page cannot be locked, no link is made', async () => {
    const t = setup({ prepare: (cdp) => cdp.respond('Fetch.enable', () => Promise.reject(new Error('Fetch not supported'))) });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(t.links).toHaveLength(0);
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'page_lock_unavailable' });
  });

  it('middle and right clicks never reach the page; modifier-clicks arrive as plain clicks', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    const click = (button: string, modifiers: number) => v.push({ t: 'mouse', action: 'down', x: 1, y: 1, button, clickCount: 1, modifiers });
    click('middle', 0);
    click('right', 0);
    click('left', 2);
    await settle();
    const presses = t.cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && (c.params as { type: string }).type === 'mousePressed');
    expect(presses.map((c) => c.params)).toEqual([{ type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 }]);
  });

  it('popups the page opens are locked too, and unlocked at the end', async () => {
    const t = setup();
    await settle();
    const popup = new FakeCdp();
    popup.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'P', url: 'about:blank' } } }));
    t.popups.open(popup);
    await settle();
    expect(popup.methods()).toContain('Fetch.enable');
    const v = await t.join();
    v.push({ t: 'done' });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(popup.methods()).toContain('Fetch.disable');
  });
});

describe('page lock and an unresponsive page', () => {
  it('a takeover still finishes when unlocking never gets an answer (SDK gone)', async () => {
    const t = setup({ prepare: (cdp) => cdp.respond('Fetch.disable', () => new Promise(() => {})) });
    await settle();
    const v = await t.join();
    v.push({ t: 'done' });
    await settle(); // 'done' is decrypted on a real thread: let it reach the engine before moving the clock
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'resolved' });
  });
});
