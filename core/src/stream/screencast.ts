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

/** Starts a JPEG screencast. Frames carry page CSS-pixel dimensions. Returns a stop function. */
export async function startScreencast(
  cdp: CdpClient,
  onFrame: (f: Frame) => void,
  opts: ScreencastOptions = {},
): Promise<() => Promise<void>> {
  let stopped = false;
  const off = cdp.on('Page.screencastFrame', (e: ScreencastFrameEvent) => {
    if (stopped) return;
    cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    onFrame({
      width: Math.round(e.metadata.deviceWidth),
      height: Math.round(e.metadata.deviceHeight),
      jpeg: b64ToBytes(e.data),
    });
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: opts.quality ?? 70,
    maxWidth: opts.maxWidth ?? 1600,
    maxHeight: opts.maxHeight ?? 1600,
  });
  return async () => {
    stopped = true;
    off();
    await cdp.send('Page.stopScreencast').catch(() => {});
  };
}
