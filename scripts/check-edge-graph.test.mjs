import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findEdgeViolations, KNOWN_EXTERNALS, main } from './check-edge-graph.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-graph-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
function write(rel, text) {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe('check-edge-graph', () => {
  it('passes for the edge entry', () => expect(findEdgeViolations('sdk-ts/src/edge.ts')).toEqual([]));
  it('flags the Node entry', () =>
    expect(findEdgeViolations('sdk-ts/src/index.ts').join('\n')).toMatch(/engine-process\.ts|node:child_process/));

  it('flags node:fs imported through a relative file', () => {
    const entry = write('a/entry.ts', "import { x } from './dep';\nexport { x };\n");
    const dep = write('a/dep.ts', "import fs from 'node:fs';\nexport const x = fs;\n");
    expect(findEdgeViolations(entry)).toEqual([`${dep} → node:fs`]);
  });

  it('flags bare built-ins, require, dynamic import and re-exports', () => {
    const entry = write(
      'b/entry.ts',
      "export * from './re';\nconst a = require('path');\nconst b = await import('os');\nimport './side';\nexport type { T } from './types';\n",
    );
    write('b/re.ts', "export const r = 1;\nimport 'fs/promises';\n");
    write('b/side.js', 'export {};\n');
    // './types' has no runtime file: a type-only re-export is erased, so it is not followed (nor an error).
    const found = findEdgeViolations(entry).map((v) => v.split(' → ')[1]);
    expect(found.sort()).toEqual(['fs/promises', 'os', 'path']);
  });

  it('resolves directory indexes and .js specifiers for .ts files, and survives cycles', () => {
    const entry = write('c/entry.ts', "import './lib';\nimport './x.js';\n");
    write('c/lib/index.ts', "import '../entry';\nimport 'node:net';\n");
    write('c/x.ts', 'export {};\n');
    expect(findEdgeViolations(entry)).toEqual([`${path.join(tmp, 'c/lib/index.ts')} → node:net`]);
  });

  it('fails closed: an unresolvable relative or @velmlabs import is an error', () => {
    const entry = write('c2/entry.ts', "import './missing';\nimport { a } from '@velmlabs/gone';\nexport { a };\n");
    expect(findEdgeViolations(entry)).toEqual([`${entry} → ./missing (unresolved)`, `${entry} → @velmlabs/gone (unresolved)`]);
  });

  it('fails closed on third-party packages outside the known externals; allowed ones (and their subpaths) pass unfollowed', () => {
    const entry = write('c3/entry.ts', "import 'left-pad';\nimport { x } from '@acme/thing/sub';\nimport 'tldts';\nimport { Type } from '@sinclair/typebox/value';\nexport { x, Type };\n");
    expect(findEdgeViolations(entry)).toEqual([
      `${entry} → left-pad (third-party package not in the known externals)`,
      `${entry} → @acme/thing/sub (third-party package not in the known externals)`,
    ]);
    expect(KNOWN_EXTERNALS).toEqual(['@sinclair/typebox', 'tldts']);
    expect(findEdgeViolations(entry, { externals: ['left-pad', '@acme/thing'] }).map((v) => v.split(' → ')[1])).toEqual([
      'tldts (third-party package not in the known externals)',
      '@sinclair/typebox/value (third-party package not in the known externals)',
    ]);
  });

  it('skips type-only imports and re-exports, but follows inline type modifiers (the import itself stays)', () => {
    const entry = write('c4/entry.ts', "import type { A } from './gone-a';\nexport type { B } from 'gone-b';\nimport { type C, d } from './d';\nexport { d };\n");
    write('c4/d.ts', "import 'node:vm';\nexport const d = 1;\nexport type C = 1;\n");
    expect(findEdgeViolations(entry)).toEqual([`${path.join(tmp, 'c4/d.ts')} → node:vm`]);
  });

  it('follows workspace packages through exports and honours the workerd condition', () => {
    const entry = write('d/pkg/entry.ts', "import '@velmlabs/unstuck-core';\n");
    const dir = path.join(tmp, 'd/pkg/node_modules/@velmlabs/unstuck-core');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ exports: { '.': { workerd: './edge.js', default: './node.js' }, './sub': './sub.js' } }),
    );
    fs.writeFileSync(path.join(dir, 'edge.js'), "import '@velmlabs/unstuck-core/sub';\n");
    fs.writeFileSync(path.join(dir, 'node.js'), "import 'node:fs';\n");
    fs.writeFileSync(path.join(dir, 'sub.js'), "import 'node:http';\n");
    expect(findEdgeViolations(entry)).toEqual([`${path.join(dir, 'sub.js')} → node:http`]);
  });

  it('resolves workspace packages by main or a string exports', () => {
    const entry = write('e/pkg/entry.ts', "import '@velmlabs/a';\nimport '@velmlabs/b';\nimport '@velmlabs/c';\n");
    const nm = path.join(tmp, 'e/pkg/node_modules/@velmlabs');
    for (const [name, pkg, file, body] of [
      ['a', { main: './m.js' }, 'm.js', "import 'node:os';\n"],
      ['b', { exports: './b.js' }, 'b.js', "import 'node:zlib';\n"],
      ['c', {}, 'index.js', "import 'node:dns';\n"],
    ]) {
      fs.mkdirSync(path.join(nm, name), { recursive: true });
      fs.writeFileSync(path.join(nm, name, 'package.json'), JSON.stringify(pkg));
      fs.writeFileSync(path.join(nm, name, file), body);
    }
    const found = findEdgeViolations(entry).map((v) => v.split(' → ')[1]);
    expect(found.sort()).toEqual(['node:dns', 'node:os', 'node:zlib']);
  });

  it('follows the exports key order, not a fixed condition order (first matching key wins, as in Node and bundlers)', () => {
    const entry = write('d2/pkg/entry.ts', "import '@velmlabs/first';\nimport '@velmlabs/nested';\nimport '@velmlabs/sub/x';\nimport '@velmlabs/none';\n");
    const nm = path.join(tmp, 'd2/pkg/node_modules/@velmlabs');
    const pkgs = {
      // `default` listed before `workerd`: a bundler takes `default`, so the Node file is what workerd gets.
      first: [{ exports: { '.': { types: './t.d.ts', default: './node.js', workerd: './edge.js' } } }, { 'node.js': "import 'node:fs';\n", 'edge.js': '' }],
      // A matching key whose nested target matches nothing falls through to the next key.
      nested: [{ exports: { '.': { worker: { node: './n.js' }, browser: './b.js', default: './d.js' } } }, { 'n.js': '', 'b.js': "import 'node:tls';\n", 'd.js': '' }],
      sub: [{ exports: { './x': { import: './x.js' }, '.': './i.js' } }, { 'x.js': "import 'node:url';\n", 'i.js': '' }],
      // Only conditions workerd never matches: unresolved.
      none: [{ exports: { '.': { node: './n.js', require: './r.cjs', types: './t.d.ts' } } }, { 'n.js': '' }],
    };
    for (const [name, [pkg, files]] of Object.entries(pkgs)) {
      fs.mkdirSync(path.join(nm, name), { recursive: true });
      fs.writeFileSync(path.join(nm, name, 'package.json'), JSON.stringify(pkg));
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(nm, name, f), body);
    }
    expect(findEdgeViolations(entry)).toEqual([
      `${path.join(nm, 'first/node.js')} → node:fs`,
      `${path.join(nm, 'nested/b.js')} → node:tls`,
      `${path.join(nm, 'sub/x.js')} → node:url`,
      `${entry} → @velmlabs/none (unresolved)`,
    ]);
  });

  it('flags the engine package and engine-process.ts', () => {
    const entry = write('f/entry.ts', "import '@velmlabs/unstuck-engine';\nimport './engine-process';\n");
    write('f/engine-process.ts', 'export {};\n');
    const out = findEdgeViolations(entry);
    expect(out).toContain(`${entry} → @velmlabs/unstuck-engine`);
    expect(out).toContain(`${entry} → ./engine-process (${path.join(tmp, 'f/engine-process.ts')})`);
  });

  it('main prints violations and returns 1, or returns 0 when clean', () => {
    const lines = [];
    const bad = write('g/entry.ts', "import 'node:fs';\n");
    expect(main([bad], (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toMatch(/node:fs/);
    expect(main(['sdk-ts/src/edge.ts'], (l) => lines.push(l))).toBe(0);
    expect(main([], (l) => lines.push(l))).toBe(2);
  });
});
