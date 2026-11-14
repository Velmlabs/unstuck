// Publishing 0.1.0: the TypeScript packages pack as built ES modules + bundled types, and the SDK imports from a clean folder.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageLauncher } from './release/stage.mjs';

const PKGS = { protocol: '@velmlabs/unstuck-protocol', core: '@velmlabs/unstuck-core', 'sdk-ts': '@velmlabs/unstuck' };
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
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
      expect(pkg.version, dir).toBe('0.1.0');
      expect(pkg.main, dir).toBe('./dist/index.js');
      expect(pkg.types, dir).toBe('./dist/index.d.ts');
      expect(JSON.stringify(pkg.exports), dir).not.toContain('src/');
      expect(JSON.stringify(pkg.dependencies ?? {}), dir).not.toContain('workspace:');
      expect(pkg.repository?.url, dir).toBe('git+https://github.com/velmlabs/unstuck.git');
      expect(pkg.homepage, dir).toBe('https://unstuck.sh/docs');
      expect(pkg.author, dir).toBe('Velm Labs');
    }
  });

  it('the SDK imports from a clean folder with only the packed tarballs', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
    fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
    // The SDK depends on the generated launcher package; its platform packages are optional (not packed here).
    const launcher = execFileSync('npm', ['pack', '--pack-destination', out], { cwd: stageLauncher(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-')), '0.1.0'), encoding: 'utf8' }).trim().split('\n').pop();
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=optional', tarballs.protocol, tarballs['sdk-ts'], path.join(out, launcher)], { cwd: app, stdio: 'ignore' });
    const r = execFileSync('node', ['-e', "import('@velmlabs/unstuck').then((m) => console.log(typeof m.Unstuck, typeof m.UnstuckEngineError))"], { cwd: app, encoding: 'utf8' });
    expect(r.trim()).toBe('function function');
  }, 300_000);
});
