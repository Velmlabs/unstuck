import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEngine, checkBinaryType, EXPECTED_TYPE, macosInfo } from './build-engines.mjs';
import { PLATFORMS } from './platforms.mjs';
import { adhocSign, ensureRcodesign } from './rcodesign.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
/** Where a SuperBlob's blobs and the CodeDirectory are in a signed Mach-O (the test edits them in place). */
function signatureLayout(bytes) {
  let off = 32;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(off) === 0x1d) {
      const sig = bytes.readUInt32LE(off + 8);
      const blobs = {};
      for (let j = 0; j < bytes.readUInt32BE(sig + 8); j++) blobs[bytes.readUInt32BE(sig + 12 + 8 * j)] = sig + bytes.readUInt32BE(sig + 16 + 8 * j);
      return { cd: blobs[0], blobs };
    }
    off += bytes.readUInt32LE(off + 4);
  }
}

describe('engine builds', () => {
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
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')), 'x');
    fs.writeFileSync(f, '#!/bin/sh\n');
    expect(() => checkBinaryType(f, PLATFORMS.find((p) => p.id === 'darwin-arm64'))).toThrow(/darwin-arm64 build is not a Mach-O 64-bit arm64 executable/);
  });
  it('builds a working linux-x64 engine', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
    const bin = buildEngine(PLATFORMS.find((p) => p.id === 'linux-x64'), out);
    checkBinaryType(bin, PLATFORMS.find((p) => p.id === 'linux-x64'));
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toBe('0.1.0');
  }, 300_000);
});

describe('macOS builds', () => {
  it('reads the minimum macOS version and checks the code signature page by page', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-'));
    const arm = buildEngine(PLATFORMS.find((p) => p.id === 'darwin-arm64'), out);
    expect(macosInfo(arm)).toMatchObject({ minos: '13.0', signature: 'valid' });
    const broken = path.join(out, 'broken');
    const bytes = fs.readFileSync(arm);
    bytes[1_000_000] ^= 0xff; // a byte inside a signed code page
    fs.writeFileSync(broken, bytes);
    expect(macosInfo(broken).signature).toBe('invalid');
  }, 300_000);

  describe('darwin-x64: Bun keeps its own signature, rcodesign replaces it with an ad-hoc one', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-x64-'));
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
