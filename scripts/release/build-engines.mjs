// Cross-compiles the engine (viewer embedded) for every platform with Bun, and checks each is the right executable type.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const EXPECTED_TYPE = {
  'darwin-arm64': /^Mach-O 64-bit arm64 executable/,
  'darwin-x64': /^Mach-O 64-bit x86_64 executable/,
  'linux-x64': /^ELF 64-bit LSB executable, x86-64/,
  'linux-arm64': /^ELF 64-bit LSB executable, ARM aarch64/,
  'win32-x64': /^PE32\+ executable \(console\) x86-64/,
};

/** Builds the viewer and embeds it into the engine sources (once, before compiling any target). */
export function embedViewer() {
  execFileSync('pnpm', ['--filter', '@velmlabs/unstuck-viewer', 'build'], { cwd: root, stdio: 'ignore' });
  execFileSync('node', ['engine/scripts/embed-viewer.mjs'], { cwd: root, stdio: 'ignore' });
}

/** Compiles the engine for one platform into `out/<id>/<exe>`; returns the path. */
export function buildEngine(platform, out) {
  const file = path.join(out, platform.id, platform.exe);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('bun', ['build', path.join(root, 'engine/src/bin.ts'), '--compile', '--minify', `--target=${platform.bun}`, '--outfile', file], { cwd: root, stdio: 'ignore' });
  return file;
}

export function checkBinaryType(file, platform) {
  const type = execFileSync('file', ['-b', file], { encoding: 'utf8' });
  if (!EXPECTED_TYPE[platform.id].test(type)) throw new Error(`${platform.id} build is not a ${EXPECTED_TYPE[platform.id].source.replace(/^\^/, '').replace(/\\/g, '')}: ${type.trim()}`);
}

/**
 * A Mach-O binary's minimum macOS (LC_BUILD_VERSION), its code signature flags, and whether the signature matches the
 * file: every code page hashes to its slot, the signed code reaches the signature itself (nothing appended after
 * signing goes unsigned), and the requirements and entitlements blobs hash to their special slots. macOS refuses to
 * run a binary whose signature doesn't match.
 */
export function macosInfo(file) {
  const d = fs.readFileSync(file);
  const ncmds = d.readUInt32LE(16);
  let off = 32;
  let minos;
  let sig;
  for (let i = 0; i < ncmds; i++) {
    const cmd = d.readUInt32LE(off);
    const size = d.readUInt32LE(off + 4);
    if (cmd === 0x32) {
      const v = d.readUInt32LE(off + 12);
      minos = `${v >>> 16}.${(v >>> 8) & 0xff}`;
    }
    if (cmd === 0x1d) sig = { off: d.readUInt32LE(off + 8), size: d.readUInt32LE(off + 12) };
    off += size;
  }
  if (!sig) return { minos, signature: 'missing' };
  const blob = d.subarray(sig.off, sig.off + sig.size);
  const blobs = {};
  for (let i = 0; i < blob.readUInt32BE(8); i++) blobs[blob.readUInt32BE(12 + 8 * i)] = blob.readUInt32BE(16 + 8 * i);
  if (blobs[0] === undefined) return { minos, signature: 'missing' };
  const cd = blob.subarray(blobs[0]); // CodeDirectory: flags 12, hashOffset 16, nSpecialSlots 24, nCodeSlots 28, codeLimit 32
  const flags = cd.readUInt32BE(12);
  const hashOffset = cd.readUInt32BE(16);
  const nSpecial = cd.readUInt32BE(24);
  const nCode = cd.readUInt32BE(28);
  const codeLimit = cd.readUInt32BE(32);
  const [hashSize, hashType, , pageShift] = [cd[36], cd[37], cd[38], cd[39]];
  const pageSize = 2 ** pageShift;
  const hash = (b) => createHash(hashType === 2 ? 'sha256' : 'sha1').update(b).digest().subarray(0, hashSize);
  const slot = (i) => cd.subarray(hashOffset + i * hashSize, hashOffset + (i + 1) * hashSize);
  const result = (ok) => ({ minos, signature: ok ? 'valid' : 'invalid', flags });
  if (codeLimit !== sig.off || nCode !== Math.ceil(codeLimit / pageSize)) return result(false);
  for (let p = 0; p < nCode; p++) if (!hash(d.subarray(p * pageSize, Math.min((p + 1) * pageSize, codeLimit))).equals(slot(p))) return result(false);
  // Special slot -n holds the hash of the blob of type n (2 requirements, 5 entitlements, 7 DER entitlements).
  for (const n of [2, 5, 7]) {
    if (n > nSpecial || blobs[n] === undefined) continue;
    const stored = slot(-n);
    if (stored.every((b) => b === 0)) continue;
    const b = blob.subarray(blobs[n], blobs[n] + blob.readUInt32BE(blobs[n] + 4));
    if (!hash(b).equals(stored)) return result(false);
  }
  return result(true);
}
