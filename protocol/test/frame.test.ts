import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, withFrameSeq, FRAME_TYPE_JPEG, FRAME_TYPE_JPEG_SEQ, FRAME_SEQ_MAX } from '../src/frame';

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
    expect(decodeFrame(new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('rejects buffers shorter than the header', () => {
    expect(decodeFrame(new Uint8Array([1, 0, 0]))).toBeNull();
  });

  it('rejects dimensions that do not fit in u16', () => {
    expect(() => encodeFrame({ width: 70000, height: 1, jpeg: new Uint8Array() })).toThrow(RangeError);
  });

  describe('sequence-numbered frames (frame credit)', () => {
    it('round-trips a sequence number', () => {
      const f = { width: 390, height: 844, jpeg: new Uint8Array([9, 8, 7]) };
      expect(decodeFrame(encodeFrame(f, 42))).toEqual({ ...f, seq: 42 });
    });

    it('writes type 2, a big-endian u32 sequence number, then the type-1 layout', () => {
      const b = encodeFrame({ width: 0x0102, height: 0x0304, jpeg: new Uint8Array([5]) }, 0x0a0b0c0d);
      expect(Array.from(b)).toEqual([FRAME_TYPE_JPEG_SEQ, 0x0a, 0x0b, 0x0c, 0x0d, 1, 2, 3, 4, 5]);
      expect(FRAME_TYPE_JPEG_SEQ).toBe(2);
    });

    it('withFrameSeq turns an encoded type-1 frame into the same frame with a sequence number', () => {
      const f = { width: 10, height: 20, jpeg: new Uint8Array([1, 2, 3]) };
      expect(withFrameSeq(encodeFrame(f), 7)).toEqual(encodeFrame(f, 7));
    });

    it('withFrameSeq rejects a buffer that is not a type-1 frame', () => {
      expect(() => withFrameSeq(encodeFrame({ width: 1, height: 1, jpeg: new Uint8Array() }, 1), 2)).toThrow(RangeError);
      expect(() => withFrameSeq(new Uint8Array([1, 0]), 2)).toThrow(RangeError);
    });

    it('rejects sequence numbers outside 1..2^32-1', () => {
      const f = { width: 1, height: 1, jpeg: new Uint8Array() };
      expect(FRAME_SEQ_MAX).toBe(0xffffffff);
      for (const bad of [0, -1, 1.5, 0x1_0000_0000]) expect(() => encodeFrame(f, bad)).toThrow(RangeError);
      expect(decodeFrame(encodeFrame(f, FRAME_SEQ_MAX))?.seq).toBe(FRAME_SEQ_MAX);
    });

    it('rejects a type-2 buffer shorter than its header, and sequence number 0', () => {
      expect(decodeFrame(new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0]))).toBeNull();
      expect(decodeFrame(new Uint8Array([2, 0, 0, 0, 0, 0, 1, 0, 1]))).toBeNull();
    });
  });
});
