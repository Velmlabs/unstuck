import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findEdgeViolations, main } from './check-edge-graph.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-graph-'));
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
    write('b/types.d.ts', 'export type T = 1;\n');
    const found = findEdgeViolations(entry).map((v) => v.split(' → ')[1]);
    expect(found.sort()).toEqual(['fs/promises', 'os', 'path']);
  });

  it('resolves directory indexes, .js specifiers for .ts files, and survives cycles and missing files', () => {
    const entry = write('c/entry.ts', "import './lib';\nimport './x.js';\nimport './missing';\n");
    write('c/lib/index.ts', "import '../entry';\nimport 'node:net';\n");
    write('c/x.ts', 'export {};\n');
    expect(findEdgeViolations(entry)).toEqual([`${path.join(tmp, 'c/lib/index.ts')} → node:net`]);
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

  it('resolves workspace packages by main, a string exports, or not at all', () => {
    const entry = write('e/pkg/entry.ts', "import '@velmlabs/a';\nimport '@velmlabs/b';\nimport '@velmlabs/c';\nimport '@velmlabs/gone';\nimport 'tldts';\n");
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
