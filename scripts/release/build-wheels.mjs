// Builds the `unstuck` wheel once per platform: the engine binary goes into unstuck/_bin/, then the wheel is retagged
// for that platform. No sdist: it would lack the engine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sdk = path.join(root, 'sdk-py');

export function buildWheel(platform, binary, out) {
  const binDir = path.join(sdk, 'src/unstuck/_bin');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-'));
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
  try {
    fs.copyFileSync(binary, path.join(binDir, platform.exe));
    fs.chmodSync(path.join(binDir, platform.exe), 0o755);
    // Built from a clean copy of the sources (no __pycache__), so nothing from the workspace leaks in.
    execFileSync('uv', ['build', '--wheel', '--no-build-logs', '--out-dir', work, sdk], { stdio: 'ignore', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
  const pure = fs.readdirSync(work).find((f) => f.endsWith('-py3-none-any.whl'));
  execFileSync('uvx', ['wheel==0.45.1', 'tags', '--platform-tag', platform.wheel, '--remove', path.join(work, pure)], { stdio: 'ignore' });
  const tagged = fs.readdirSync(work).find((f) => f.endsWith(`-${platform.wheel}.whl`));
  fs.mkdirSync(out, { recursive: true });
  const dest = path.join(out, tagged);
  fs.copyFileSync(path.join(work, tagged), dest);
  return dest;
}
