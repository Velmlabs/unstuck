import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEngine, checkBinaryType, EXPECTED_TYPE, macosInfo, BUN_VERSION, checkBunVersion } from './build-engines.mjs';
import { PLATFORMS } from './platforms.mjs';
import { adhocSign, ensureRcodesign } from './rcodesign.mjs';
const madeDirs = [];
/** A temporary folder this test file removes when it finishes (engine builds here are ~100 MB each). */
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(d);
  return d;
};
afterAll(() => madeDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));


const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
/** Where a SuperBlob's blobs and the CodeDirectory are in a signed Mach-O (the test edits them in place). */
function signatureLayout(bytes) {
  let off = 32;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(off) === 0x1d) {
      const sig = bytes.readUInt32LE(off + 8);
      const blobs = {};
      const indexOf = {};
      for (let j = 0; j < bytes.readUInt32BE(sig + 8); j++) {
        blobs[bytes.readUInt32BE(sig + 12 + 8 * j)] = sig + bytes.readUInt32BE(sig + 16 + 8 * j);
        indexOf[bytes.readUInt32BE(sig + 12 + 8 * j)] = sig + 12 + 8 * j; // where the entry's type is
      }
      return { cd: blobs[0], blobs, indexOf };
    }
    off += bytes.readUInt32LE(off + 4);
  }
}

describe('engine builds', () => {
  it('builds only with the pinned Bun (its runtime ships inside every engine)', () => {
    expect(BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => checkBunVersion(`${BUN_VERSION}\n`)).not.toThrow();
    expect(() => checkBunVersion('0.0.1')).toThrow(`engines must be built with Bun ${BUN_VERSION}, found 0.0.1`);
    expect(() => checkBunVersion()).not.toThrow(); // the Bun on this machine
  });
  it('knows the executable type each platform must produce', () => {
    expect(EXPECTED_TYPE).toEqual({
      'darwin-arm64': /^Mach-O 64-bit arm64 executable/,
      'darwin-x64': /^Mach-O 64-bit x86_64 executable/,
      'linux-x64': /^ELF 64-bit LSB executable, x86-64/,
      'linux-arm64': /^ELF 64-bit LSB executable, ARM aarch64/,
      'win32-x64': /^PE32\+ executable \(console\) x86-64/,
    });
  });
  it('rejects a binary of the wrong type', () => {
    const f = path.join(tmpDir('bt-'), 'x');
    fs.writeFileSync(f, '#!/bin/sh\n');
    expect(() => checkBinaryType(f, PLATFORMS.find((p) => p.id === 'darwin-arm64'))).toThrow(/darwin-arm64 build is not a Mach-O 64-bit arm64 executable/);
  });
  it('builds a working linux-x64 engine', () => {
    const out = tmpDir('eng-');
    const bin = buildEngine(PLATFORMS.find((p) => p.id === 'linux-x64'), out);
    checkBinaryType(bin, PLATFORMS.find((p) => p.id === 'linux-x64'));
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toBe('0.2.3');
  }, 300_000);
});

describe('macOS builds', () => {
  it('reads the minimum macOS version and checks the code signature page by page', () => {
    const out = tmpDir('mac-');
    const arm = buildEngine(PLATFORMS.find((p) => p.id === 'darwin-arm64'), out);
    expect(macosInfo(arm)).toMatchObject({ minos: '13.0', signature: 'valid' });
    const broken = path.join(out, 'broken');
    const bytes = fs.readFileSync(arm);
    bytes[1_000_000] ^= 0xff; // a byte inside a signed code page
    fs.writeFileSync(broken, bytes);
    expect(macosInfo(broken).signature).toBe('invalid');
  }, 300_000);

  describe('darwin-x64: Bun keeps its own signature, rcodesign replaces it with an ad-hoc one', () => {
    const out = tmpDir('mac-x64-');
    let raw;
    let signed;
    it('Bun\'s raw build is invalid: its signature no longer matches the file', () => {
      raw = buildEngine({ id: 'darwin-x64', bun: 'bun-darwin-x64-baseline', exe: 'unstuck-engine' }, out);
      expect(macosInfo(raw).signature).toBe('invalid');
    }, 300_000);
    it('after an ad-hoc re-sign it is valid, for macOS 13.0, with the ad-hoc flag', () => {
      signed = path.join(out, 'signed');
      fs.copyFileSync(raw, signed);
      adhocSign(signed, ensureRcodesign(path.join(root, 'release/tools')));
      const info = macosInfo(signed);
      expect(info).toMatchObject({ minos: '13.0', signature: 'valid' });
      expect(info.flags & 0x2).toBe(0x2);
    }, 300_000);
    it('a signature that stops a page short of its own start is invalid, even if every page it covers matches', () => {
      const bytes = fs.readFileSync(signed);
      const { cd } = signatureLayout(bytes);
      // Drop the last (partial) page: the limit lands on a page boundary, so every page still covered matches.
      const pages = bytes.readUInt32BE(cd + 28) - 1;
      bytes.writeUInt32BE(pages, cd + 28); // nCodeSlots
      bytes.writeUInt32BE(pages * 4096, cd + 32); // codeLimit
      const short = path.join(out, 'short');
      fs.writeFileSync(short, bytes);
      expect(macosInfo(short).signature).toBe('invalid');
    });
    /** A copy of the signed binary after `edit(bytes, layout)`; returns its signature verdict. */
    const verdictAfter = (name, edit) => {
      const bytes = fs.readFileSync(signed);
      edit(bytes, signatureLayout(bytes));
      const f = path.join(out, name);
      fs.writeFileSync(f, bytes);
      return macosInfo(f).signature;
    };
    const slotAt = (bytes, cd, n) => cd + bytes.readUInt32BE(cd + 16) - n * bytes[cd + 36]; // special slot -n
    it('changed requirements are invalid', () => {
      expect(verdictAfter('req', (b, { blobs }) => (b[blobs[2] + 10] ^= 0xff))).toBe('invalid');
    });
    it('an entitlements blob whose slot hash was zeroed is invalid, changed or not', () => {
      expect(verdictAfter('zeroed', (b, { cd }) => b.fill(0, slotAt(b, cd, 5), slotAt(b, cd, 5) + 32))).toBe('invalid');
      expect(verdictAfter('zeroed-changed', (b, { cd, blobs }) => (b.fill(0, slotAt(b, cd, 5), slotAt(b, cd, 5) + 32), (b[blobs[5] + 100] ^= 0xff)))).toBe('invalid');
    });
    it('a slot hash with its blob gone from the index is invalid', () => {
      expect(verdictAfter('dropped', (b, { indexOf }) => b.writeUInt32BE(0x99, indexOf[5]))).toBe('invalid');
    });
    it('entitlements not covered by the special slots are invalid', () => {
      expect(verdictAfter('uncovered', (b, { cd }) => b.writeUInt32BE(4, cd + 24))).toBe('invalid');
    });
    it('every CodeDirectory is checked: an alternate one that is not a CodeDirectory is invalid', () => {
      expect(verdictAfter('alternate', (b, { indexOf }) => b.writeUInt32BE(0x1000, indexOf[0x10000]))).toBe('invalid');
    });
    it('changed entitlements are invalid', () => {
      const bytes = fs.readFileSync(signed);
      const { blobs } = signatureLayout(bytes);
      bytes[blobs[5] + 100] ^= 0xff;
      const tampered = path.join(out, 'tampered');
      fs.writeFileSync(tampered, bytes);
      expect(macosInfo(tampered).signature).toBe('invalid');
    });
  });
});
