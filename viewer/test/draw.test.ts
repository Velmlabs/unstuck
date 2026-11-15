import { describe, it, expect, vi, afterEach } from 'vitest';
import { drawFrameOnCanvas } from '../src/draw';

afterEach(() => vi.unstubAllGlobals());

describe('drawFrameOnCanvas', () => {
  it('decodes the JPEG and draws it at its natural size', async () => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    const bitmap = { width: 800, height: 450, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    await drawFrameOnCanvas(canvas, { width: 1280, height: 720, jpeg: new Uint8Array([1]) });
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(450);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('skips frames that arrive while one is decoding, then draws the newest', async () => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const decode = vi.fn(async (b: Blob) => {
      await gate;
      return { width: b.size, height: 1, close() {} };
    });
    vi.stubGlobal('createImageBitmap', decode);
    const a = drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(1) });
    void drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(2) });
    const c = drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(3) });
    release();
    await a;
    await c;
    await new Promise((r) => setTimeout(r, 0));
    expect(decode).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(3);
  });

  it('ignores decode failures and canvases without a 2D context', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('bad jpeg'))));
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    await expect(drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(1) })).resolves.toBeUndefined();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })));
    await expect(drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(1) })).resolves.toBeUndefined();
  });

  it('reports each drawn frame after it is on the canvas (frame credit acks); a skipped frame is covered by the newer one', async () => {
    const order: string[] = [];
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (b: { width: number }) => order.push(`draw ${b.width}`) }) } as unknown as HTMLCanvasElement;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('createImageBitmap', vi.fn(async (b: Blob) => {
      await gate;
      return { width: b.size, height: 1, close() {} };
    }));
    const drawn = (f: { jpeg: Uint8Array }) => order.push(`drawn ${f.jpeg.length}`);
    const a = drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(1), seq: 1 }, drawn);
    void drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(2), seq: 2 }, drawn);
    void drawFrameOnCanvas(canvas, { width: 1, height: 1, jpeg: new Uint8Array(3), seq: 3 }, drawn);
    expect(order).toEqual([]);
    release();
    await a;
    expect(order).toEqual(['draw 1', 'drawn 1', 'draw 3', 'drawn 3']);
  });

  it('reports a frame that failed to decode too, so the engine is not left waiting for it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('bad jpeg'))));
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    const drawn = vi.fn();
    const f = { width: 1, height: 1, jpeg: new Uint8Array(1), seq: 4 };
    await drawFrameOnCanvas(canvas, f, drawn);
    expect(drawn).toHaveBeenCalledWith(f);
  });
});
