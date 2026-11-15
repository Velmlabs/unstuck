import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { edgeSmoke } from './edge-smoke.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-smoke-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (rel, text) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
/** A folder with `@velmlabs/unstuck` installed as a fixture package. */
const fixture = (name, exports, files) => {
  write(`${name}/package.json`, '{"type":"module"}');
  write(`${name}/node_modules/@velmlabs/unstuck/package.json`, JSON.stringify({ name: '@velmlabs/unstuck', type: 'module', exports }));
  for (const [f, text] of Object.entries(files)) write(`${name}/node_modules/@velmlabs/unstuck/${f}`, text);
  return path.join(tmp, name);
};

describe('edgeSmoke', () => {
  // Self-contained: builds the SDK into its own temp folder, so it neither needs nor races the gitignored sdk-ts/dist.
  const pkg = path.join(tmp, 'sdk-pkg');
  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'tsup', '--out-dir', path.join(pkg, 'dist')], { cwd: path.join(root, 'sdk-ts'), stdio: 'ignore' });
    // The manifest as `pnpm pack` publishes it: publishConfig (dist exports) laid over the workspace one (src exports).
    const { publishConfig, ...manifest } = JSON.parse(fs.readFileSync(path.join(root, 'sdk-ts/package.json'), 'utf8'));
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ ...manifest, ...publishConfig }));
    fs.symlinkSync(path.join(root, 'sdk-ts/node_modules'), path.join(pkg, 'node_modules'));
  }, 120_000);

  it('passes on the real built SDK, installed the way a clean folder gets it', async () => {
    const app = path.join(tmp, 'real');
    fs.mkdirSync(path.join(app, 'node_modules/@velmlabs'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(pkg, path.join(app, 'node_modules/@velmlabs/unstuck'));
    const r = await edgeSmoke(app);
    expect(fs.existsSync(path.join(pkg, 'dist/edge.js'))).toBe(true);
    expect(r.bytes).toBeGreaterThan(1000);
    expect(r.bytes).toBeLessThan(1048576);
  });

  it('fails on a node: import behind the workerd condition', async () => {
    const app = fixture('node-import', { '.': { workerd: './w.js', default: './w.js' } }, { 'w.js': "import cp from 'node:child_process';\nexport const Unstuck = cp;\n" });
    await expect(edgeSmoke(app)).rejects.toThrow(/node:child_process/);
  });

  it('fails on a bare built-in pulled in by a third-party dependency', async () => {
    const app = fixture('dep', { '.': { workerd: './w.js' } }, { 'w.js': "import { x } from 'dep';\nexport const Unstuck = x;\n" });
    write('dep/node_modules/@velmlabs/unstuck/node_modules/dep/package.json', '{"name":"dep","type":"module","exports":"./i.js"}');
    write('dep/node_modules/@velmlabs/unstuck/node_modules/dep/i.js', "import fs from 'fs';\nexport const x = fs;\n");
    await expect(edgeSmoke(app)).rejects.toThrow(/Node built-ins: fs \(imported by .*i\.js\)/);
  });

  it('fails on other bundling errors', async () => {
    const app = fixture('missing', { '.': { workerd: './w.js' } }, { 'w.js': "import './nope.js';\nexport const Unstuck = 1;\n" });
    await expect(edgeSmoke(app)).rejects.toThrow(/does not bundle for workerd/);
  });

  it('fails when the bundle is over 1 MiB', async () => {
    const app = fixture('big', { '.': { workerd: './w.js' } }, { 'w.js': `export const Unstuck = ${JSON.stringify('x'.repeat(1100000))};\n` });
    await expect(edgeSmoke(app)).rejects.toThrow(/limit 1024 KiB/);
  });
});
