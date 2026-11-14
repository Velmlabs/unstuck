// Cross-compiles the engine (viewer embedded) for every platform with Bun, and checks each is the right executable type.
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
