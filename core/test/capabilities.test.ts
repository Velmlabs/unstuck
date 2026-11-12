import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeCdp } from '../src/testing';
import { probeCapabilities } from '../src/capabilities';

afterEach(() => vi.useRealTimers());

describe('probeCapabilities', () => {
  it('reports everything supported on a full browser, with side-effect-free probes', async () => {
    const cdp = new FakeCdp();
    await expect(probeCapabilities(cdp)).resolves.toEqual({ screencast: true, insertText: true, input: true });
    expect(cdp.calls).toEqual(
      expect.arrayContaining([
        { method: 'Page.startScreencast', params: expect.any(Object) },
        { method: 'Page.stopScreencast', params: undefined },
        { method: 'Input.insertText', params: { text: '' } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 0, y: 0 } },
      ]),
    );
  });

  it.each([
    ['Page.startScreencast', { screencast: false, insertText: true, input: true }],
    ['Input.insertText', { screencast: true, insertText: false, input: true }],
    ['Input.dispatchMouseEvent', { screencast: true, insertText: true, input: false }],
  ] as const)('a failing %s marks that capability unsupported', async (method, expected) => {
    const cdp = new FakeCdp();
    cdp.respond(method, () => Promise.reject(new Error(`'${method}' wasn't found`)));
    await expect(probeCapabilities(cdp)).resolves.toEqual(expected);
  });

  it('a probe that never answers counts as unsupported after the timeout', async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    cdp.respond('Input.insertText', () => new Promise(() => {}));
    const p = probeCapabilities(cdp, { timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ screencast: true, insertText: false, input: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
