import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEngine, checkBinaryType, EXPECTED_TYPE, macosInfo } from './build-engines.mjs';
import { PLATFORMS } from './platforms.mjs';

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
    expect(() => checkBinaryType(f, PLATFORMS[0])).toThrow(/darwin-arm64 build is not a Mach-O 64-bit arm64 executable/);
  });
  it('builds a working linux-x64 engine', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
    const bin = buildEngine(PLATFORMS.find((p) => p.id === 'linux-x64'), out);
    checkBinaryType(bin, PLATFORMS[2]);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toBe('0.1.0');
  }, 300_000);
});

describe('macOS builds', () => {
  it('reads the minimum macOS version and checks the code signature page by page', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-'));
    const arm = buildEngine(PLATFORMS[0], out);
    expect(macosInfo(arm)).toEqual({ minos: '13.0', signature: 'valid' });
    const broken = path.join(out, 'broken');
    const bytes = fs.readFileSync(arm);
    bytes[1_000_000] ^= 0xff; // a byte inside a signed code page
    fs.writeFileSync(broken, bytes);
    expect(macosInfo(broken).signature).toBe('invalid');
  }, 300_000);
});
