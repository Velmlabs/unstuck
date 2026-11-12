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
});
