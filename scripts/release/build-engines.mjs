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
  if (blob.readUInt32BE(0) !== 0xfade0cc0) return { minos, signature: 'invalid' }; // embedded signature SuperBlob
  const blobs = {};
  for (let i = 0; i < blob.readUInt32BE(8); i++) blobs[blob.readUInt32BE(12 + 8 * i)] = blob.readUInt32BE(16 + 8 * i);
  if (blobs[0] === undefined) return { minos, signature: 'missing' };
  const flags = blob.readUInt32BE(blobs[0] + 12);
  // macOS checks the strongest CodeDirectory, so every one present (slot 0 and alternates 0x1000-0x1004) must hold.
  const cds = [0, 0x1000, 0x1001, 0x1002, 0x1003, 0x1004].filter((t) => blobs[t] !== undefined);
  const ok = cds.every((t) => codeDirectoryMatches(d, blob, blobs, blob.subarray(blobs[t]), sig.off));
  return { minos, signature: ok ? 'valid' : 'invalid', flags };
}

/**
 * One CodeDirectory (flags 12, hashOffset 16, nSpecialSlots 24, nCodeSlots 28, codeLimit 32, hashSize 36, hashType 37,
 * pageShift 39) matches the file: it covers all code up to the signature, every page hashes to its slot, and each of
 * the requirements (2), entitlements (5) and DER entitlements (7) blobs is covered by its special slot -n and hashes to
 * it; a special slot with no blob must be empty.
 */
function codeDirectoryMatches(d, blob, blobs, cd, sigOff) {
  if (cd.readUInt32BE(0) !== 0xfade0c02) return false;
  const hashOffset = cd.readUInt32BE(16);
  const nSpecial = cd.readUInt32BE(24);
  const nCode = cd.readUInt32BE(28);
  const codeLimit = cd.readUInt32BE(32);
  const [hashSize, hashType, , pageShift] = [cd[36], cd[37], cd[38], cd[39]];
  const algo = { 1: 'sha1', 2: 'sha256', 3: 'sha256', 4: 'sha384' }[hashType];
  if (!algo) return false;
  const pageSize = 2 ** pageShift;
  const hash = (b) => createHash(algo).update(b).digest().subarray(0, hashSize);
  const slot = (i) => cd.subarray(hashOffset + i * hashSize, hashOffset + (i + 1) * hashSize);
  if (codeLimit !== sigOff || nCode !== Math.ceil(codeLimit / pageSize)) return false;
  for (let p = 0; p < nCode; p++) if (!hash(d.subarray(p * pageSize, Math.min((p + 1) * pageSize, codeLimit))).equals(slot(p))) return false;
  for (const n of [2, 5, 7]) {
    if (blobs[n] !== undefined) {
      if (n > nSpecial) return false;
      if (!hash(blob.subarray(blobs[n], blobs[n] + blob.readUInt32BE(blobs[n] + 4))).equals(slot(-n))) return false;
    } else if (n <= nSpecial && !slot(-n).every((b) => b === 0)) return false;
  }
  return true;
}
