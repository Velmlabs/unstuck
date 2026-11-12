/** Binary viewer frame: [type u8][width u16 BE][height u16 BE][JPEG bytes]. Width/height are page CSS pixels. */
export const FRAME_TYPE_JPEG = 0x01;
const HEADER = 5;

export interface Frame {
  width: number;
  height: number;
  jpeg: Uint8Array;
}

function checkU16(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`${name} must be an integer 0..65535, got ${v}`);
}

export function encodeFrame(f: Frame): Uint8Array {
  checkU16('width', f.width);
  checkU16('height', f.height);
  const out = new Uint8Array(HEADER + f.jpeg.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_TYPE_JPEG);
  view.setUint16(1, f.width);
  view.setUint16(3, f.height);
  out.set(f.jpeg, HEADER);
  return out;
}

export function decodeFrame(b: Uint8Array): Frame | null {
  if (b.length < HEADER || b[0] !== FRAME_TYPE_JPEG) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint16(1), height: view.getUint16(3), jpeg: b.slice(HEADER) };
}
