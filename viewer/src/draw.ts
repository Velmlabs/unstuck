import type { Frame } from '@unstuck/protocol';

const state = new WeakMap<HTMLCanvasElement, { busy: boolean; pending: Frame | null }>();

/** Decodes and draws a JPEG frame. Newest-frame-only: frames arriving mid-decode replace each other. */
export async function drawFrameOnCanvas(canvas: HTMLCanvasElement, frame: Frame): Promise<void> {
  const s = state.get(canvas) ?? { busy: false, pending: null };
  state.set(canvas, s);
  if (s.busy) {
    s.pending = frame;
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
  const next = s.pending;
  s.pending = null;
  if (next) await drawFrameOnCanvas(canvas, next);
}
