import { describe, it, expect, vi } from 'vitest';
import { FakeCdp } from '../src/testing';
import { startScreencast } from '../src/stream/screencast';

const frameEvent = { data: 'AQID', sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 720 } };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startScreencast', () => {
  it('starts a JPEG screencast with the default quality and size limits', async () => {
    const cdp = new FakeCdp();
    await startScreencast(cdp, () => {});
    expect(cdp.calls).toContainEqual({ method: 'Page.startScreencast', params: { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1600 } });
  });

  it('honours custom options', async () => {
    const cdp = new FakeCdp();
    await startScreencast(cdp, () => {}, { quality: 40, maxWidth: 800, maxHeight: 600 });
    expect(cdp.calls[0]).toEqual({ method: 'Page.startScreencast', params: { format: 'jpeg', quality: 40, maxWidth: 800, maxHeight: 600 } });
  });

  it('decodes frames with CSS-pixel dimensions and acks each one', async () => {
    const cdp = new FakeCdp();
    const onFrame = vi.fn();
    await startScreencast(cdp, onFrame);
    cdp.emit('Page.screencastFrame', frameEvent);
    await tick();
    expect(onFrame).toHaveBeenCalledWith({ width: 1280, height: 720, jpeg: new Uint8Array([1, 2, 3]) });
    expect(cdp.calls).toContainEqual({ method: 'Page.screencastFrameAck', params: { sessionId: 7 } });
  });

  it('rounds fractional device sizes', async () => {
    const cdp = new FakeCdp();
    const onFrame = vi.fn();
    await startScreencast(cdp, onFrame);
    cdp.emit('Page.screencastFrame', { ...frameEvent, metadata: { deviceWidth: 390.4, deviceHeight: 844.6 } });
    expect(onFrame.mock.calls[0]![0]).toMatchObject({ width: 390, height: 845 });
  });

  it('stop() stops the screencast and ignores later frames', async () => {
    const cdp = new FakeCdp();
    const onFrame = vi.fn();
    const stop = await startScreencast(cdp, onFrame);
    await stop();
    cdp.emit('Page.screencastFrame', frameEvent);
    expect(onFrame).not.toHaveBeenCalled();
    expect(cdp.methods()).toContain('Page.stopScreencast');
    expect(cdp.listenerCount('Page.screencastFrame')).toBe(0);
  });

  it('stop() tolerates a page that is already gone', async () => {
    const cdp = new FakeCdp();
    const stop = await startScreencast(cdp, () => {});
    cdp.close('detached');
    await expect(stop()).resolves.toBeUndefined();
  });

  it('a failing ack does not throw out of the event handler', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Page.screencastFrameAck', () => Promise.reject(new Error('gone')));
    const onFrame = vi.fn();
    await startScreencast(cdp, onFrame);
    expect(() => cdp.emit('Page.screencastFrame', frameEvent)).not.toThrow();
    await tick();
    expect(onFrame).toHaveBeenCalledOnce();
  });

  describe('one screenshot at the start, so a page that never repaints is not left black', () => {
    const metrics = { cssVisualViewport: { pageX: 0, pageY: 40, clientWidth: 1280.4, clientHeight: 720 }, visualViewport: { clientWidth: 1280.4, clientHeight: 720 } };
    const shooting = () => {
      const cdp = new FakeCdp();
      cdp.respond('Page.getLayoutMetrics', () => metrics);
      cdp.respond('Page.captureScreenshot', () => ({ data: 'BAUG' }));
      return cdp;
    };

    it('is sent through the frame callback, after the screencast started, with the screencast format and quality', async () => {
      const cdp = shooting();
      const onFrame = vi.fn();
      await startScreencast(cdp, onFrame, { quality: 40 });
      await tick();
      expect(cdp.methods().slice(0, 3)).toEqual(['Page.startScreencast', 'Page.getLayoutMetrics', 'Page.captureScreenshot']);
      expect(cdp.calls[2]!.params).toEqual({ format: 'jpeg', quality: 40 });
      expect(onFrame.mock.calls).toEqual([[{ width: 1280, height: 720, jpeg: new Uint8Array([4, 5, 6]) }]]);
    });

    it('a page larger than the size limit is scaled down to it, like screencast frames (device pixels)', async () => {
      const cdp = shooting();
      cdp.respond('Page.getLayoutMetrics', () => ({ cssVisualViewport: { pageX: 0, pageY: 40, clientWidth: 1000, clientHeight: 500 }, visualViewport: { clientWidth: 2000, clientHeight: 1000 } }));
      const onFrame = vi.fn();
      await startScreencast(cdp, onFrame, { maxWidth: 800, maxHeight: 1600 });
      await tick();
      expect(cdp.calls[2]!.params).toEqual({ format: 'jpeg', quality: 70, clip: { x: 0, y: 40, width: 1000, height: 500, scale: 0.4 } });
      expect(onFrame.mock.calls[0]![0]).toMatchObject({ width: 1000, height: 500 });
    });

    it('is skipped when a screencast frame came first', async () => {
      const cdp = shooting();
      let answer!: (v: unknown) => void;
      cdp.respond('Page.captureScreenshot', () => new Promise((r) => (answer = r)));
      const onFrame = vi.fn();
      await startScreencast(cdp, onFrame);
      await tick();
      cdp.emit('Page.screencastFrame', frameEvent);
      answer({ data: 'BAUG' });
      await tick();
      expect(onFrame.mock.calls).toEqual([[{ width: 1280, height: 720, jpeg: new Uint8Array([1, 2, 3]) }]]);
    });

    it('is skipped when stopped meanwhile', async () => {
      const cdp = shooting();
      const onFrame = vi.fn();
      const stop = await startScreencast(cdp, onFrame);
      await stop();
      await tick();
      expect(onFrame).not.toHaveBeenCalled();
    });

    it('errors and odd answers are ignored', async () => {
      for (const setup of [
        (c: FakeCdp) => c.respond('Page.captureScreenshot', () => Promise.reject(new Error('gone'))),
        (c: FakeCdp) => c.respond('Page.captureScreenshot', () => ({})),
        (c: FakeCdp) => c.respond('Page.getLayoutMetrics', () => ({})),
        (c: FakeCdp) => c.respond('Page.getLayoutMetrics', () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 0, clientHeight: 0 } })),
      ]) {
        const cdp = shooting();
        setup(cdp);
        const onFrame = vi.fn();
        await expect(startScreencast(cdp, onFrame)).resolves.toBeTypeOf('function');
        await tick();
        expect(onFrame).not.toHaveBeenCalled();
      }
    });

    it('a screenshot the tab never answers is given up after 5 s: no late frame, no timer left behind', async () => {
      vi.useFakeTimers();
      try {
        const cdp = shooting();
        let answer!: (v: unknown) => void;
        cdp.respond('Page.captureScreenshot', () => new Promise((r) => (answer = r)));
        const onFrame = vi.fn();
        await startScreencast(cdp, onFrame);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(vi.getTimerCount()).toBe(0);
        answer({ data: 'BAUG' }); // the hidden tab answers much later: too late to be the first frame
        await vi.advanceTimersByTimeAsync(10);
        expect(onFrame).not.toHaveBeenCalled();
        cdp.emit('Page.screencastFrame', frameEvent); // the screencast itself is unaffected
        expect(onFrame).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a screenshot that answers in time clears its timeout', async () => {
      vi.useFakeTimers();
      try {
        const cdp = shooting();
        const onFrame = vi.fn();
        await startScreencast(cdp, onFrame);
        await vi.advanceTimersByTimeAsync(0);
        expect(onFrame).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('without the deprecated device-pixel metrics, CSS pixels are used', async () => {
      const cdp = shooting();
      cdp.respond('Page.getLayoutMetrics', () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 3200, clientHeight: 800 } }));
      await startScreencast(cdp, () => {});
      await tick();
      expect(cdp.calls[2]!.params).toEqual({ format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width: 3200, height: 800, scale: 0.5 } });
    });
  });
});
