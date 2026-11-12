import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, FRAME_TYPE_JPEG } from '../src/frame';

describe('frame codec', () => {
  it('round-trips width, height and JPEG bytes', () => {
    const f = { width: 1280, height: 720, jpeg: new Uint8Array([9, 8, 7]) };
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
  });

  it('writes the frame type in byte 0 and big-endian u16 dimensions', () => {
    const b = encodeFrame({ width: 0x0102, height: 0x0304, jpeg: new Uint8Array() });
    expect(Array.from(b)).toEqual([FRAME_TYPE_JPEG, 1, 2, 3, 4]);
    expect(FRAME_TYPE_JPEG).toBe(1);
  });

  it('rejects unknown frame types', () => {
    expect(decodeFrame(new Uint8Array([2, 0, 0, 0, 0]))).toBeNull();
  });

  it('rejects buffers shorter than the header', () => {
    expect(decodeFrame(new Uint8Array([1, 0, 0]))).toBeNull();
  });

  it('rejects dimensions that do not fit in u16', () => {
    expect(() => encodeFrame({ width: 70000, height: 1, jpeg: new Uint8Array() })).toThrow(RangeError);
  });
});
