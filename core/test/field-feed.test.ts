import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EngineToViewer, Field, FieldKind, ViewerInput } from '@velmlabs/unstuck-protocol';
import { createFieldFeed } from '../src/session/field-feed';

const otp: Field = { x: 10, y: 20, w: 100, h: 40, kind: 'otp' };
const email: Field = { x: 10, y: 80, w: 100, h: 40, kind: 'email' };
const up: ViewerInput = { t: 'mouse', action: 'up', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 };
const move: ViewerInput = { t: 'mouse', action: 'move', x: 1, y: 1, button: 'none', clickCount: 0, modifiers: 0 };
const wheel: ViewerInput = { t: 'wheel', x: 1, y: 1, dx: 0, dy: 100 };
const key: ViewerInput = { t: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 };
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(fields: Field[] = [otp], focus: FieldKind | null = 'otp') {
  const sent: EngineToViewer[] = [];
  let map = fields;
  const scan = vi.fn(async () => map);
  const focusFn = vi.fn(async () => focus);
  const feed = createFieldFeed({ scan, focus: focusFn, send: (m) => sent.push(m) });
  return { feed, sent, scan, focusFn, setMap: (m: Field[]) => (map = m) };
}

beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => void vi.useRealTimers());

describe('field feed', () => {
  it('scans on the first frame and sends the map; frames within 500 ms do not rescan, a later one does', async () => {
    const t = setup();
    t.feed.onFrame();
    await flush();
    expect(t.sent).toEqual([{ t: 'fields', fields: [otp] }]);
    vi.advanceTimersByTime(300);
    t.feed.onFrame();
    await flush();
    expect(t.scan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    t.setMap([otp, email]);
    t.feed.onFrame();
    await flush();
    expect(t.scan).toHaveBeenCalledTimes(2);
    expect(t.sent.at(-1)).toEqual({ t: 'fields', fields: [otp, email] });
  });

  it('does not re-send an unchanged map, except every 5 s', async () => {
    const t = setup();
    t.feed.onFrame();
    await flush();
    vi.advanceTimersByTime(600);
    t.feed.onFrame();
    await flush();
    expect(t.sent).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(t.sent).toEqual([{ t: 'fields', fields: [otp] }, { t: 'fields', fields: [otp] }]);
  });

  it('rescans right after a wheel input, a key and a mouse up, but not a mouse move', async () => {
    const t = setup();
    t.feed.onFrame();
    await flush();
    for (const [msg, scans] of [[move, 1], [wheel, 2], [key, 3], [up, 4]] as const) {
      t.feed.onInput(msg);
      await flush();
      expect(t.scan).toHaveBeenCalledTimes(scans);
    }
  });

  it('a mouse up also reports what took focus', async () => {
    const t = setup([otp], 'email');
    t.feed.onInput(up);
    await flush();
    expect(t.focusFn).toHaveBeenCalledTimes(1);
    expect(t.sent).toContainEqual({ t: 'focus', kind: 'email' });
    const n = setup([otp], null);
    n.feed.onInput(up);
    await flush();
    expect(n.sent).toContainEqual({ t: 'focus', kind: null });
  });

  it('a target change rescans at once and always sends, even an unchanged map', async () => {
    const t = setup();
    t.feed.onFrame();
    await flush();
    t.feed.onTargetChanged();
    await flush();
    expect(t.scan).toHaveBeenCalledTimes(2);
    expect(t.sent).toHaveLength(2);
  });

  it('stop cancels the timers and drops results still in flight', async () => {
    const t = setup();
    t.feed.onFrame();
    t.feed.stop();
    await flush();
    vi.advanceTimersByTime(20_000);
    t.feed.onFrame();
    t.feed.onInput(up);
    await flush();
    expect(t.sent).toEqual([]);
  });

  it('a failing scan never fails the takeover: nothing sent, the next trigger scans again', async () => {
    const t = setup();
    t.scan.mockRejectedValueOnce(new Error('Execution context was destroyed'));
    t.focusFn.mockRejectedValueOnce(new Error('gone'));
    expect(() => t.feed.onInput(up)).not.toThrow();
    await flush();
    expect(t.sent).toEqual([]);
    t.feed.onInput(wheel);
    await flush();
    expect(t.sent).toEqual([{ t: 'fields', fields: [otp] }]);
  });
});
