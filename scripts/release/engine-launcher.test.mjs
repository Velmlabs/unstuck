import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binaryPath, run, SUPPORTED } from './engine-launcher.mjs';

describe('engine launcher', () => {
  it('lists the five supported platforms, Intel Macs included', () => {
    expect(SUPPORTED).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);
  });
  it('resolves the Intel Mac engine like any other platform', () => {
    expect(binaryPath('darwin', 'x64', (id) => `/nm/${id}`)).toBe('/nm/@velmlabs/unstuck-engine-darwin-x64/bin/unstuck-engine');
  });
  it('resolves the platform package binary (with .exe on Windows)', () => {
    const resolve = (id) => `/nm/${id}`;
    expect(binaryPath('linux', 'x64', resolve)).toBe('/nm/@velmlabs/unstuck-engine-linux-x64/bin/unstuck-engine');
    expect(binaryPath('win32', 'x64', resolve)).toBe('/nm/@velmlabs/unstuck-engine-win32-x64/bin/unstuck-engine.exe');
  });
  it('names the supported platforms for an unsupported one', () => {
    expect(() => binaryPath('freebsd', 'x64', () => '')).toThrow('Unstuck has no engine for freebsd-x64. Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64');
  });
  it('explains a missing platform package (optional dependencies skipped)', () => {
    const resolve = () => {
      throw new Error('MODULE_NOT_FOUND');
    };
    expect(() => binaryPath('linux', 'arm64', resolve)).toThrow('@velmlabs/unstuck-engine-linux-arm64 is not installed');
  });
  it('runs the binary with the same arguments and passes its exit code on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
    const bin = path.join(dir, 'fake');
    fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = "--mcp" ] && exit 3\nexit 9\n', { mode: 0o755 });
    expect(await run(['--mcp'], bin)).toBe(3);
    expect(await run(['--other'], bin)).toBe(9);
  });
});
