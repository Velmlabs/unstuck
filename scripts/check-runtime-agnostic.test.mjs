import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findViolations, main } from './check-runtime-agnostic.mjs';
const madeDirs = [];
/** A temporary folder this test file removes when it finishes (engine builds here are ~100 MB each). */
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(d);
  return d;
};
afterAll(() => madeDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));


function tmpDirWith(files) {
  const dir = tmpDir('rt-check-');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe('findViolations', () => {
  it('flags node: prefixed imports with file and specifier', () => {
    const dir = tmpDirWith({ 'a.ts': "import fs from 'node:fs';\n" });
    expect(findViolations([dir])).toEqual([{ file: path.join(dir, 'a.ts'), specifier: 'node:fs' }]);
  });

  it('flags bare built-in module names', () => {
    const dir = tmpDirWith({ 'a.ts': "import x from 'fs';\nexport { y } from \"path\";\n" });
    expect(findViolations([dir]).map((v) => v.specifier)).toEqual(['fs', 'path']);
  });

  it('flags dynamic imports and require calls of built-ins', () => {
    const dir = tmpDirWith({ 'sub/b.tsx': "await import('child_process'); require('os');\n" });
    expect(findViolations([dir]).map((v) => v.specifier)).toEqual(['child_process', 'os']);
  });

  it('flags built-in subpaths like fs/promises', () => {
    const dir = tmpDirWith({ 'a.ts': "import { readFile } from 'fs/promises';\n" });
    expect(findViolations([dir]).map((v) => v.specifier)).toEqual(['fs/promises']);
  });

  it('allows relative and package imports', () => {
    const dir = tmpDirWith({ 'a.ts': "import { a } from './a';\nimport { Type } from '@sinclair/typebox';\n" });
    expect(findViolations([dir])).toEqual([]);
  });

  it('ignores non-source files and node_modules', () => {
    const dir = tmpDirWith({ 'a.md': "import fs from 'fs'", 'node_modules/x/i.js': "import fs from 'fs'" });
    expect(findViolations([dir])).toEqual([]);
  });

  it('skips directories that do not exist', () => {
    expect(findViolations(['/definitely/not/here'])).toEqual([]);
  });
});

describe('main', () => {
  it('returns 1 and reports each violation', () => {
    const dir = tmpDirWith({ 'a.ts': "import fs from 'node:fs';\n" });
    const lines = [];
    expect(main([dir], (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('node:fs');
    expect(lines.join('\n')).toContain('a.ts');
  });

  it('returns 0 when clean', () => {
    const dir = tmpDirWith({ 'a.ts': "import { a } from './a';\n" });
    const lines = [];
    expect(main([dir], (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain('no Node built-ins');
  });
});
