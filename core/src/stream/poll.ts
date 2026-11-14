import type { Frame } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';

/** Fallback frame source for browsers without Page.startScreencast: periodic JPEG screenshots. */
export async function startScreenshotPolling(
  cdp: CdpClient,
  onFrame: (f: Frame) => void,
  opts: { fps?: number; quality?: number } = {},
): Promise<() => Promise<void>> {
  const intervalMs = 1000 / (opts.fps ?? 5);
  const quality = opts.quality ?? 70;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    const started = Date.now();
    try {
      const metrics = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
      const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality });
      if (!stopped) {
        const bin = atob(shot.data);
        onFrame({
          width: Math.round(metrics.cssVisualViewport.clientWidth),
          height: Math.round(metrics.cssVisualViewport.clientHeight),
          jpeg: Uint8Array.from(bin, (c) => c.charCodeAt(0)),
        });
      }
    } catch {
      // skip this frame; the next tick retries
    }
    // Schedule after the capture finishes so two captures never overlap.
    if (!stopped) timer = setTimeout(tick, Math.max(0, intervalMs - (Date.now() - started)));
  };
  timer = setTimeout(tick, 0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
  };
}
