// rcodesign (apple-codesign), pinned and checksum-checked, to ad-hoc sign the darwin-x64 engine on Linux. Bun keeps
// its own Developer ID signature on that build, which no longer matches the file once our code is appended.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RCODESIGN = {
  url: 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz',
  sha256: 'dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002',
  member: 'apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign',
};

const curl = (url, dest) => execFileSync('curl', ['-fsSL', '-o', dest, url], { stdio: 'ignore' });

/** Returns an executable rcodesign in `cacheDir`, fetching and checking the pinned archive the first time. */
export function ensureRcodesign(cacheDir, archive, { sha256 = RCODESIGN.sha256, download = curl } = {}) {
  const bin = path.join(cacheDir, 'rcodesign');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(cacheDir, { recursive: true });
  let fetched;
  if (!archive) download(RCODESIGN.url, (archive = fetched = path.join(cacheDir, 'rcodesign.tar.gz')));
  try {
    const got = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (got !== sha256) throw new Error(`rcodesign download has SHA-256 ${got}, expected ${sha256}`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rcodesign-'));
    execFileSync('tar', ['-xzf', archive, '-C', work, RCODESIGN.member]);
    fs.copyFileSync(path.join(work, RCODESIGN.member), bin);
    fs.chmodSync(bin, 0o755);
    fs.rmSync(work, { recursive: true, force: true });
    return bin;
  } finally {
    if (fetched) fs.rmSync(fetched, { force: true });
  }
}

/** Replaces `file`'s code signature with an ad-hoc one (no certificate); rcodesign keeps the existing flags and entitlements. */
export function adhocSign(file, rcodesign, identifier = 'unstuck-engine') {
  execFileSync(rcodesign, ['sign', '--binary-identifier', identifier, file], { stdio: 'ignore' });
}
