// Builds the viewer for its own origin: https://view.unstuck.sh/v/<version>/ — one immutable folder per release,
// matching the engine version that links to it, with integrity on each page's script and stylesheet and a SHA-256 list of
// every file so anyone can compare what is served with this source.
//   node scripts/build-hosted.mjs  →  dist-hosted/v/<version>/
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinPages } from './integrity.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const base = `/v/${version}/`;
const out = path.join(root, 'dist-hosted', 'v', version);
fs.rmSync(out, { recursive: true, force: true });
// index.html, pair.html and the service worker (sw.js) are separate builds into the same folder.
for (const mode of ['production', 'pair', 'sw']) {
  execFileSync('npx', ['vite', 'build', '--mode', mode, '--base', base, '--outDir', out, ...(mode === 'production' ? ['--emptyOutDir'] : [])], { cwd: root, stdio: 'ignore' });
}
pinPages(out, base);
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(out);
const hashes = Object.fromEntries(files.sort().map((f) => [path.relative(out, f), createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync(path.join(out, 'SHA256SUMS.json'), JSON.stringify({ version, files: hashes }, null, 2) + '\n');
console.log(`viewer ${version} → ${path.relative(root, out)}`);
