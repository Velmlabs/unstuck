import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakePopups, FakeTransport } from '../src/testing';
import { createEngine, type LinkInfo } from '../src/engine';
import type { TakeoverResult } from '@unstuck/protocol';

const realSetTimeout = globalThis.setTimeout;
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((r) => realSetTimeout(r, 2));
}
const frame = (w: number) => ({ data: 'AQID', sessionId: 1, metadata: { deviceWidth: w, deviceHeight: 100 } });
const mouse = { t: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 } as const;
const realClicks = (c: FakeCdp) => c.calls.filter((x) => x.method === 'Input.dispatchMouseEvent' && (x.params as { type: string }).type === 'mousePressed').length;

function setup() {
  const transport = new FakeTransport();
  const page = new FakeCdp();
  const popups = new FakePopups();
  const links: LinkInfo[] = [];
  const engine = createEngine({ transport, onLink: (l) => links.push(l) });
  let result: TakeoverResult | undefined;
  void engine.takeover(page, { reason: 'r', popups }).then((r) => (result = r));
  const join = async () => {
    const v = transport.connect(links[0]!.sessionId);
    v.push({ t: 'hello', token: new URL(links[0]!.url).hash.slice(3) });
    await settle();
    return v;
  };
  return { page, popups, join, result: () => result };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('popup following (Review Focus 4)', () => {
  it('a popup takes over the stream and input; closing it returns both to the page', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    const popup = new FakeCdp();
    t.popups.open(popup);
    await settle();
    expect(popup.methods()).toContain('Page.startScreencast');
    expect(t.page.methods().filter((m) => m === 'Page.stopScreencast').length).toBeGreaterThanOrEqual(2); // probe + switch

    popup.emit('Page.screencastFrame', frame(300));
    expect(v.binary().at(-1)!.slice(1, 3)).toEqual(new Uint8Array([0x01, 0x2c])); // 300 wide
    v.push(mouse);
    await settle();
    expect(realClicks(popup)).toBe(1);
    expect(realClicks(t.page)).toBe(0);

    const pageStartsBefore = t.page.methods().filter((m) => m === 'Page.startScreencast').length;
    popup.close('target closed');
    await settle();
    expect(t.page.methods().filter((m) => m === 'Page.startScreencast').length).toBe(pageStartsBefore + 1);
    v.push(mouse);
    await settle();
    expect(realClicks(t.page)).toBe(1);
    expect(t.result()).toBeUndefined(); // a popup closing never ends the takeover
  });

  it('a popup opened before anyone joins is what the viewer sees first', async () => {
    const t = setup();
    await settle();
    const popup = new FakeCdp();
    t.popups.open(popup);
    await settle();
    await t.join();
    expect(popup.methods()).toContain('Page.startScreencast');
    expect(t.page.methods().filter((m) => m === 'Page.startScreencast')).toHaveLength(1); // only the probe
  });

  it('a popup without input support is ignored; the viewer stays on the page', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    const popup = new FakeCdp();
    popup.respond('Input.dispatchMouseEvent', () => Promise.reject(new Error('no input')));
    t.popups.open(popup);
    await settle();
    v.push(mouse);
    await settle();
    expect(realClicks(t.page)).toBe(1);
    expect(popup.methods().filter((m) => m === 'Page.startScreencast')).toHaveLength(1); // the probe only
  });

  it('a popup that closes while being probed is ignored', async () => {
    const t = setup();
    await settle();
    await t.join();
    const popup = new FakeCdp();
    popup.respond('Input.insertText', () => {
      popup.close('target closed');
      return {};
    });
    t.popups.open(popup);
    await settle();
    expect(popup.calls.filter((c) => c.method === 'Page.startScreencast')).toHaveLength(1); // the probe only
  });

  it('closing the original page still fails the takeover, even with a popup open', async () => {
    const t = setup();
    await settle();
    await t.join();
    t.popups.open(new FakeCdp());
    await settle();
    t.page.close('detached');
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'page_closed' });
  });

  it('stops listening for popups when the takeover ends', async () => {
    const t = setup();
    await settle();
    expect(t.popups.listenerCount).toBe(1);
    const v = await t.join();
    v.push({ t: 'done' });
    await settle();
    expect(t.popups.listenerCount).toBe(0);
  });
});
