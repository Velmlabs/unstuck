import type { Frame } from '@velmlabs/unstuck-protocol';

type Drawn = (f: Frame) => void;
const state = new WeakMap<HTMLCanvasElement, { busy: boolean; pending: { frame: Frame; onDrawn?: Drawn } | null }>();

/**
 * Decodes and draws a JPEG frame. Newest-frame-only: frames arriving mid-decode replace each other.
 * `onDrawn` runs once the frame is on the canvas (or failed to decode), never for a frame a newer one replaced:
 * the newer frame's report covers it (frame credit acks are cumulative).
 */
export async function drawFrameOnCanvas(canvas: HTMLCanvasElement, frame: Frame, onDrawn?: Drawn): Promise<void> {
  const s = state.get(canvas) ?? { busy: false, pending: null };
  state.set(canvas, s);
  if (s.busy) {
    s.pending = { frame, onDrawn };
    return;
  }
  s.busy = true;
  try {
    const bitmap = await createImageBitmap(new Blob([frame.jpeg as BlobPart], { type: 'image/jpeg' }));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
    }
    bitmap.close();
  } catch {
    // A corrupt frame is skipped; the next one repaints.
  } finally {
    s.busy = false;
  }
  try {
    onDrawn?.(frame);
  } catch {
    // A failing report must not leave the newest frame undrawn.
  }
  const next = s.pending;
  s.pending = null;
  if (next) await drawFrameOnCanvas(canvas, next.frame, next.onDrawn);
}
