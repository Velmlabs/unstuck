/**
 * Binary viewer frames. Width/height are page CSS pixels.
 * - type 1: [0x01][width u16 BE][height u16 BE][JPEG bytes]
 * - type 2: [0x02][seq u32 BE][width u16 BE][height u16 BE][JPEG bytes] — only sent to a viewer that opted in to frame
 *   credit (`{ t: 'credit', v: 1 }`), which acks each drawn frame by its sequence number.
 */
export const FRAME_TYPE_JPEG = 0x01;
export const FRAME_TYPE_JPEG_SEQ = 0x02;
export const FRAME_SEQ_MAX = 0xffffffff;
const HEADER = 5;
const SEQ_BYTES = 4;

export interface Frame {
  width: number;
  height: number;
  jpeg: Uint8Array;
  /** Set on type-2 frames: the number the viewer acks once it has drawn the frame. */
  seq?: number;
}

function checkU16(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`${name} must be an integer 0..65535, got ${v}`);
}

function checkSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq < 1 || seq > FRAME_SEQ_MAX) throw new RangeError(`seq must be an integer 1..${FRAME_SEQ_MAX}, got ${seq}`);
}

/** Encodes a type-1 frame, or a type-2 frame when `seq` is given. */
export function encodeFrame(f: Pick<Frame, 'width' | 'height' | 'jpeg'>, seq?: number): Uint8Array {
  checkU16('width', f.width);
  checkU16('height', f.height);
  const out = new Uint8Array(HEADER + f.jpeg.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_TYPE_JPEG);
  view.setUint16(1, f.width);
  view.setUint16(3, f.height);
  out.set(f.jpeg, HEADER);
  return seq === undefined ? out : withFrameSeq(out, seq);
}

/** The same frame as type 2 with this sequence number, from an encoded type-1 frame (the engine caches those). */
export function withFrameSeq(type1: Uint8Array, seq: number): Uint8Array {
  if (type1.length < HEADER || type1[0] !== FRAME_TYPE_JPEG) throw new RangeError('not a type-1 frame');
  checkSeq(seq);
  const out = new Uint8Array(type1.length + SEQ_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_TYPE_JPEG_SEQ);
  view.setUint32(1, seq);
  out.set(type1.subarray(1), 1 + SEQ_BYTES);
  return out;
}

export function decodeFrame(b: Uint8Array): Frame | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === FRAME_TYPE_JPEG && b.length >= HEADER) {
    return { width: view.getUint16(1), height: view.getUint16(3), jpeg: b.slice(HEADER) };
  }
  if (b[0] === FRAME_TYPE_JPEG_SEQ && b.length >= HEADER + SEQ_BYTES) {
    const seq = view.getUint32(1);
    if (seq === 0) return null;
    return { width: view.getUint16(5), height: view.getUint16(7), jpeg: b.slice(HEADER + SEQ_BYTES), seq };
  }
  return null;
}
