#!/usr/bin/env node
// Compiles the engine into one self-contained executable (current platform; the cross-target matrix is Plan 6).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('bun is required to compile the engine binary. Install it with: npm i -g bun');
  process.exit(1);
}
const out = path.join(root, 'dist', 'unstuck-engine');
const r = spawnSync('bun', ['build', path.join(root, 'src', 'bin.ts'), '--compile', '--minify', '--outfile', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`built ${path.relative(process.cwd(), out)}`);
