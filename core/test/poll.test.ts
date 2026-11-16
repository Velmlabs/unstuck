import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp } from '../src/testing';
import { startScreenshotPolling } from '../src/stream/poll';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fake() {
  const cdp = new FakeCdp();
  cdp.respond('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1280.4, clientHeight: 719.6 } }));
  cdp.respond('Page.captureScreenshot', () => ({ data: 'AQID' }));
  return cdp;
}

describe('startScreenshotPolling', () => {
  it('emits JPEG frames with CSS sizes at the requested rate (default 5 fps, quality 70)', async () => {
    const cdp = fake();
    const onFrame = vi.fn();
    const stop = await startScreenshotPolling(cdp, onFrame);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFrame.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(onFrame.mock.calls.length).toBeLessThanOrEqual(6);
    expect(onFrame).toHaveBeenCalledWith({ width: 1280, height: 720, jpeg: new Uint8Array([1, 2, 3]) });
    expect(cdp.calls).toContainEqual({ method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 70 } });
    await stop();
  });

  it('never overlaps two captures', async () => {
    const cdp = fake();
    let inFlight = 0;
    let maxInFlight = 0;
    cdp.respond('Page.captureScreenshot', async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 450));
      inFlight--;
      return { data: 'AQID' };
    });
    const stop = await startScreenshotPolling(cdp, () => {}, { fps: 10 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(maxInFlight).toBe(1);
    await stop();
  });

  it('stop() ends polling and leaves no timers', async () => {
    const cdp = fake();
    const onFrame = vi.fn();
    const stop = await startScreenshotPolling(cdp, onFrame, { fps: 2, quality: 50 });
    await stop();
    const n = onFrame.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onFrame.mock.calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a capture the tab never answers is given up after 5 s and polling continues (it never stalls)', async () => {
    for (const method of ['Page.captureScreenshot', 'Page.getLayoutMetrics']) {
      const cdp = fake();
      let n = 0;
      const original = method === 'Page.captureScreenshot' ? () => ({ data: 'AQID' }) : () => ({ cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } });
      cdp.respond(method, () => (n++ === 0 ? new Promise(() => {}) : original()));
      const onFrame = vi.fn();
      const stop = await startScreenshotPolling(cdp, onFrame);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(onFrame, method).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(onFrame, method).toHaveBeenCalled();
      expect(cdp.methods().filter((m) => m === method).length, method).toBeGreaterThan(1);
      await stop();
      expect(vi.getTimerCount(), method).toBe(0);
    }
  });

  it('a failing capture is skipped and polling continues', async () => {
    const cdp = fake();
    let n = 0;
    cdp.respond('Page.captureScreenshot', () => (n++ === 0 ? Promise.reject(new Error('busy')) : { data: 'AQID' }));
    const onFrame = vi.fn();
    const stop = await startScreenshotPolling(cdp, onFrame);
    await vi.advanceTimersByTimeAsync(600);
    expect(onFrame).toHaveBeenCalled();
    await stop();
  });
});
