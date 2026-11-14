import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RCODESIGN, adhocSign, ensureRcodesign } from './rcodesign.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rcodesign-'));
/** A tarball laid out like the real release: <dir>/rcodesign, a shell script that records its arguments. */
function fakeArchive() {
  const src = tmp();
  const dir = path.join(src, path.dirname(RCODESIGN.member));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rcodesign'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\n', { mode: 0o755 });
  const archive = path.join(tmp(), 'rc.tgz');
  execFileSync('tar', ['-czf', archive, '-C', src, path.dirname(RCODESIGN.member)]);
  return { archive, sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
}

describe('rcodesign', () => {
  it('pins the official 0.29.0 Linux build and its checksum', () => {
    expect(RCODESIGN.url).toBe('https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz');
    expect(RCODESIGN.sha256).toBe('dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002');
    expect(RCODESIGN.member).toBe('apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign');
  });

  it('refuses a download whose checksum is not the pinned one, and keeps nothing', () => {
    const { archive } = fakeArchive();
    const cache = tmp();
    expect(() => ensureRcodesign(cache, archive)).toThrow(/rcodesign download has SHA-256 [0-9a-f]{64}, expected dbe85ced/);
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it('extracts the binary once, executable, then reuses the cached copy', () => {
    const { archive, sha256 } = fakeArchive();
    const cache = tmp();
    const bin = ensureRcodesign(cache, archive, { sha256 });
    expect(bin).toBe(path.join(cache, 'rcodesign'));
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(cache)).toEqual(['rcodesign']);
    fs.rmSync(archive);
    expect(ensureRcodesign(cache, archive, { sha256 })).toBe(bin);
  });

  it('downloads the pinned URL into the cache when no archive is given', () => {
    const { archive, sha256 } = fakeArchive();
    const cache = tmp();
    const asked = [];
    const bin = ensureRcodesign(cache, undefined, { sha256, download: (url, dest) => (asked.push(url), fs.copyFileSync(archive, dest)) });
    expect(asked).toEqual([RCODESIGN.url]);
    expect(bin).toBe(path.join(cache, 'rcodesign'));
    expect(fs.readdirSync(cache)).toEqual(['rcodesign']);
  });

  it('signs ad-hoc with the unstuck-engine identifier and nothing else', () => {
    const { archive, sha256 } = fakeArchive();
    const bin = ensureRcodesign(tmp(), archive, { sha256 });
    adhocSign('/x/unstuck-engine', bin);
    expect(fs.readFileSync(`${bin}.args`, 'utf8').trim().split('\n')).toEqual(['sign', '--binary-identifier', 'unstuck-engine', '/x/unstuck-engine']);
  });

  it('a signing failure stops the build', () => {
    const bad = path.join(tmp(), 'rcodesign');
    fs.writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(() => adhocSign('/x/unstuck-engine', bad)).toThrow();
  });
});
