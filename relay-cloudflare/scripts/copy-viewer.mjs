// Copies the viewer build into ./public (Worker static assets). Build the viewer first if needed.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const viewer = path.dirname(createRequire(import.meta.url).resolve('@velmlabs/unstuck-viewer/package.json'));
const dist = path.join(viewer, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) execSync('pnpm --filter @velmlabs/unstuck-viewer build', { stdio: 'inherit' });
const out = path.join(here, '..', 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(dist, out, { recursive: true });
console.log(`copied the viewer into ${path.relative(process.cwd(), out) || '.'}`);
