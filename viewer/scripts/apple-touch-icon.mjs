// Draws the PNG twins of public/icon.svg: apple-touch-icon.png (180×180), which iPhone wants for the Home Screen (it
// ignores SVG touch icons), and icon-192.png / icon-512.png, the manifest icons Chrome needs to offer an install.
// Full bleed: iOS and Android round or mask the corners themselves (the mark sits well inside the maskable safe zone).
// Run by hand when icon.svg changes:
//   node scripts/apple-touch-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SS = 4; // 4×4 samples per pixel
const BG = [0x0f, 0x17, 0x2a];
const FG = [0x22, 0xc5, 0x5e];

/** Distance from (x, y) in icon.svg's 512 units to its stroke's centre line: M168 150 v132 a88 88 0 0 0 176 0 V150. */
function dist(x, y) {
  const seg = (sx) => Math.hypot(x - sx, y - Math.min(282, Math.max(150, y)));
  const arc = y >= 282 ? Math.abs(Math.hypot(x - 256, y - 282) - 88) : Infinity;
  return Math.min(seg(168), seg(344), arc);
}

export function iconPng(SIZE = 180) {
  const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  for (let py = 0; py < SIZE; py++) {
    raw[py * (SIZE * 3 + 1)] = 0; // filter: none
    for (let px = 0; px < SIZE; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) * 512) / SIZE;
          const y = ((py + (sy + 0.5) / SS) * 512) / SIZE;
          if (dist(x, y) <= 26) hit++;
        }
      const a = hit / (SS * SS);
      const o = py * (SIZE * 3 + 1) + 1 + px * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    fs.writeFileSync(path.join(pub, name), iconPng(size));
    console.log(`wrote ${name}`);
  }
}
