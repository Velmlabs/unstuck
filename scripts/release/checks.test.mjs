import { describe, it, expect } from 'vitest';
import { tarballProblems, wheelProblems } from './checks.mjs';

const base = ['package.json', 'README.md', 'LICENSE'];

describe('npm tarball contents', () => {
  it('a TypeScript package: compiled JS and .d.ts under dist/ only', () => {
    expect(tarballProblems('@velmlabs/unstuck', [...base, 'dist/index.js', 'dist/index.d.ts', 'dist/chunk-1.js'])).toEqual([]);
    expect(tarballProblems('@velmlabs/unstuck-core', [...base, 'dist/index.js', 'dist/testing/index.js', 'dist/testing/index.d.ts'])).toEqual([]);
  });
  it('flags sources, maps, tests, secrets and anything outside dist/', () => {
    const p = tarballProblems('@velmlabs/unstuck-protocol', [...base, 'dist/index.js', 'dist/index.js.map', 'src/index.ts', 'dist/a.test.js', '.env', 'dist/x.css']);
    expect(p).toEqual([
      '@velmlabs/unstuck-protocol: unexpected file dist/index.js.map',
      '@velmlabs/unstuck-protocol: unexpected file src/index.ts',
      '@velmlabs/unstuck-protocol: unexpected file dist/a.test.js',
      '@velmlabs/unstuck-protocol: unexpected file .env',
      '@velmlabs/unstuck-protocol: unexpected file dist/x.css',
    ]);
  });
  it('requires package.json, README.md, LICENSE and some code', () => {
    expect(tarballProblems('@velmlabs/unstuck', ['package.json'])).toEqual([
      '@velmlabs/unstuck: missing README.md',
      '@velmlabs/unstuck: missing LICENSE',
      '@velmlabs/unstuck: missing dist/index.js',
    ]);
  });
  it('the launcher: only bin/unstuck-engine.mjs', () => {
    expect(tarballProblems('@velmlabs/unstuck-engine', [...base, 'bin/unstuck-engine.mjs'])).toEqual([]);
    expect(tarballProblems('@velmlabs/unstuck-engine', [...base, 'bin/unstuck-engine.mjs', 'bin/other.js'])).toEqual(['@velmlabs/unstuck-engine: unexpected file bin/other.js']);
    expect(tarballProblems('@velmlabs/unstuck-engine', base)).toEqual(['@velmlabs/unstuck-engine: missing bin/unstuck-engine.mjs']);
  });
  it('a platform package: its binary and the Apache licence, nothing else', () => {
    const plat = base;
    expect(tarballProblems('@velmlabs/unstuck-engine-win32-x64', [...plat, 'bin/unstuck-engine.exe'])).toEqual([]);
    expect(tarballProblems('@velmlabs/unstuck-engine-darwin-x64', [...plat, 'bin/unstuck-engine'])).toEqual([]);
    expect(tarballProblems('@velmlabs/unstuck-engine-linux-x64', [...base, 'bin/unstuck-engine.exe'])).toEqual([
      '@velmlabs/unstuck-engine-linux-x64: missing bin/unstuck-engine',
      '@velmlabs/unstuck-engine-linux-x64: unexpected file bin/unstuck-engine.exe',
    ]);
    // The viewer is Apache-2.0 now: the old AGPL files must not ship again.
    expect(tarballProblems('@velmlabs/unstuck-engine-linux-x64', [...base, 'LICENSE-AGPL', 'NOTICE', 'bin/unstuck-engine'])).toEqual([
      '@velmlabs/unstuck-engine-linux-x64: unexpected file LICENSE-AGPL',
      '@velmlabs/unstuck-engine-linux-x64: unexpected file NOTICE',
    ]);
  });
  it('an unknown package is a problem', () => {
    expect(tarballProblems('@velmlabs/unstuck-relay', base)).toEqual(['@velmlabs/unstuck-relay: not a package this release publishes']);
  });
});

describe('wheel contents', () => {
  const name = (tag) => `unstuck-0.1.3-py3-none-${tag}.whl`;
  const meta = ['METADATA', 'WHEEL', 'RECORD', 'licenses/LICENSE'].map((f) => `unstuck-0.1.3.dist-info/${f}`);
  const py = ['unstuck/__init__.py', 'unstuck/_engine.py', 'unstuck/py.typed'];
  it('the package, its engine for that platform and the licences', () => {
    expect(wheelProblems(name('manylinux_2_17_x86_64'), [...py, 'unstuck/_bin/unstuck-engine', ...meta])).toEqual([]);
    expect(wheelProblems(name('win_amd64'), [...py, 'unstuck/_bin/unstuck-engine.exe', ...meta])).toEqual([]);
    expect(wheelProblems(name('macosx_13_0_x86_64'), [...py, 'unstuck/_bin/unstuck-engine', ...meta])).toEqual([]);
  });
  it('flags a missing engine or licence, bytecode, tests and the wrong binary', () => {
    const w = name('macosx_13_0_arm64');
    expect(wheelProblems(w, [...py, 'unstuck/__pycache__/x.cpython-313.pyc', 'tests/test_a.py', 'unstuck/_bin/unstuck-engine.exe', ...meta.slice(0, 3), 'unstuck-0.1.3.dist-info/licenses/NOTICE'])).toEqual([
      `${w}: missing unstuck/_bin/unstuck-engine`,
      `${w}: missing unstuck-0.1.3.dist-info/licenses/LICENSE`,
      `${w}: unexpected file unstuck/__pycache__/x.cpython-313.pyc`,
      `${w}: unexpected file tests/test_a.py`,
      `${w}: unexpected file unstuck/_bin/unstuck-engine.exe`,
      `${w}: unexpected file unstuck-0.1.3.dist-info/licenses/NOTICE`,
    ]);
  });
  it('a wheel for a platform this release does not build', () => {
    expect(wheelProblems('unstuck-0.1.3-py3-none-any.whl', py)).toEqual(['unstuck-0.1.3-py3-none-any.whl: not a platform this release builds']);
  });
});
