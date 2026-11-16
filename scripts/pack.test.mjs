// Publishing 0.2.5: the TypeScript packages pack as built ES modules + bundled types, and the SDK imports from a clean folder.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageLauncher } from './release/stage.mjs';
const madeDirs = [];
/** A temporary folder this test file removes when it finishes (engine builds here are ~100 MB each). */
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(d);
  return d;
};
afterAll(() => madeDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));


const PKGS = { protocol: '@velmlabs/unstuck-protocol', core: '@velmlabs/unstuck-core', 'sdk-ts': '@velmlabs/unstuck' };
const out = tmpDir('pack-');
const tarballs = {};
const listing = (tgz) => execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).trim().split('\n').map((f) => f.replace(/^package\//, '')).sort();

beforeAll(() => {
  for (const dir of Object.keys(PKGS)) {
    execFileSync('pnpm', ['--filter', PKGS[dir], 'run', 'build:dist'], { stdio: 'ignore' });
    const name = execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
    tarballs[dir] = path.isAbsolute(name) ? name : path.join(out, path.basename(name));
  }
}, 300_000);

describe('packed packages', () => {
  it('contain only the built files, README, LICENSE and package.json', () => {
    for (const dir of Object.keys(PKGS)) {
      const files = listing(tarballs[dir]);
      expect(files.filter((f) => !/^(dist\/.+\.(js|d\.ts)|README\.md|LICENSE|package\.json)$/.test(f)), dir).toEqual([]);
      expect(files, dir).toContain('dist/index.js');
      expect(files, dir).toContain('dist/index.d.ts');
    }
  });

  it('point main, types and exports at dist, with published dependencies and metadata', () => {
    for (const dir of Object.keys(PKGS)) {
      const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tarballs[dir], 'package/package.json'], { encoding: 'utf8' }));
      expect(pkg.name, dir).toBe(PKGS[dir]);
      expect(pkg.version, dir).toBe('0.2.5');
      expect(pkg.main, dir).toBe('./dist/index.js');
      expect(pkg.types, dir).toBe('./dist/index.d.ts');
      expect(JSON.stringify(pkg.exports), dir).not.toContain('src/');
      // A "default" condition, so require() (Node 22+) and CJS-mode TypeScript resolve it too.
      const node = { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' };
      // The SDK also ships an edge entry (no Node built-ins) for Workers and browsers, listed before the Node conditions.
      // Deno and Bun get the Node entry (binary mode works there; they opt in with mode: 'in-process').
      const edge = { types: './dist/edge.d.ts', default: './dist/edge.js' };
      const expected = dir === 'sdk-ts' ? { workerd: edge, worker: edge, browser: edge, ...node } : node;
      expect(pkg.exports['.'], dir).toEqual(expected);
      if (dir === 'sdk-ts') expect(Object.keys(pkg.exports['.']).slice(0, 3), dir).toEqual(['workerd', 'worker', 'browser']);
      expect(pkg.engines, dir).toEqual({ node: '>=20' });
      expect(JSON.stringify(pkg.dependencies ?? {}), dir).not.toContain('workspace:');
      expect(pkg.repository?.url, dir).toBe('git+https://github.com/velmlabs/unstuck.git');
      expect(pkg.homepage, dir).toBe('https://unstuck.sh/docs');
      expect(pkg.author, dir).toBe('Velm Labs');
    }
  });

  it('the SDK imports from a clean folder with only the packed tarballs', () => {
    const app = tmpDir('app-');
    fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
    // The SDK depends on core and the generated launcher package; the launcher's platform packages are optional (not packed here).
    const launcher = execFileSync('npm', ['pack', '--pack-destination', out], { cwd: stageLauncher(tmpDir('stage-'), '0.2.5'), encoding: 'utf8' }).trim().split('\n').pop();
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=optional', tarballs.protocol, tarballs.core, tarballs['sdk-ts'], path.join(out, launcher)], { cwd: app, stdio: 'ignore' });
    const r = execFileSync('node', ['-e', "import('@velmlabs/unstuck').then((m) => console.log(typeof m.Unstuck, typeof m.UnstuckEngineError))"], { cwd: app, encoding: 'utf8' });
    expect(r.trim()).toBe('function function');
  }, 300_000);
});
