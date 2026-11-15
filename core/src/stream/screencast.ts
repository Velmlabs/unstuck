import type { Frame } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';

export interface ScreencastOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { deviceWidth: number; deviceHeight: number };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

interface Viewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

/**
 * One JPEG of the visible page, in the screencast's format, quality and size limit (the limit is in device pixels, like
 * the screencast's). Null when the page doesn't answer as expected.
 */
async function captureFrame(cdp: CdpClient, quality: number, maxWidth: number, maxHeight: number): Promise<Frame | null> {
  const m = await cdp.send<{ cssVisualViewport?: Viewport; visualViewport?: { clientWidth: number } }>('Page.getLayoutMetrics');
  const css = m.cssVisualViewport;
  if (!css?.clientWidth || !css.clientHeight) return null;
  // The deprecated visualViewport is in device pixels: their ratio is the device scale factor.
  const dpr = m.visualViewport?.clientWidth ? m.visualViewport.clientWidth / css.clientWidth : 1;
  const scale = Math.min(1, maxWidth / (css.clientWidth * dpr), maxHeight / (css.clientHeight * dpr));
  const clip = { x: css.pageX, y: css.pageY, width: css.clientWidth, height: css.clientHeight, scale };
  const shot = await cdp.send<{ data?: unknown }>('Page.captureScreenshot', { format: 'jpeg', quality, ...(scale < 1 ? { clip } : {}) });
  if (typeof shot.data !== 'string') return null;
  return { width: Math.round(css.clientWidth), height: Math.round(css.clientHeight), jpeg: b64ToBytes(shot.data) };
}

/**
 * Starts a JPEG screencast. Frames carry page CSS-pixel dimensions. Returns a stop function.
 * Chrome only sends a screencast frame when the page repaints, so one screenshot goes out first through `onFrame`,
 * unless a screencast frame beats it: a static page is shown at once.
 */
export async function startScreencast(
  cdp: CdpClient,
  onFrame: (f: Frame) => void,
  opts: ScreencastOptions = {},
): Promise<() => Promise<void>> {
  let stopped = false;
  let framed = false;
  const off = cdp.on('Page.screencastFrame', (e: ScreencastFrameEvent) => {
    if (stopped) return;
    framed = true;
    cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    onFrame({
      width: Math.round(e.metadata.deviceWidth),
      height: Math.round(e.metadata.deviceHeight),
      jpeg: b64ToBytes(e.data),
    });
  });
  const quality = opts.quality ?? 70;
  const maxWidth = opts.maxWidth ?? 1600;
  const maxHeight = opts.maxHeight ?? 1600;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight });
  void captureFrame(cdp, quality, maxWidth, maxHeight).then(
    (f) => {
      if (f && !framed && !stopped) onFrame(f);
    },
    () => {}, // only a head start: the screencast's own frames follow
  );
  return async () => {
    stopped = true;
    off();
    await cdp.send('Page.stopScreencast').catch(() => {});
  };
}
