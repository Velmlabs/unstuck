import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWheel } from './build-wheels.mjs';
import { PLATFORMS } from './platforms.mjs';

const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whl-'));
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const workDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wheel-'));
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' }).trim();
const ZIP_LIST = 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nfor i in z.infolist(): print(i.filename, oct((i.external_attr >> 16) & 0o777))';

describe('platform wheels', () => {
  it('a wheel per platform: the right tag, the engine inside and executable, nothing from the workspace', () => {
    const fake = path.join(tmp(), 'engine');
    fs.writeFileSync(fake, '#!/bin/sh\necho 0.1.4\n', { mode: 0o755 });
    for (const p of PLATFORMS.filter((x) => ['linux-x64', 'win32-x64'].includes(x.id))) {
      const whl = buildWheel(p, fake, tmp());
      expect(path.basename(whl)).toBe(`unstuck-0.1.4-py3-none-${p.wheel}.whl`);
      const files = py(ZIP_LIST, whl).split('\n');
      expect(files).toContain(`unstuck/_bin/${p.exe} 0o755`);
      expect(files.filter((f) => /__pycache__|\.pyc|test|\.venv/.test(f))).toEqual([]);
      const meta = py("import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(z.read('unstuck-0.1.4.dist-info/METADATA').decode())", whl);
      expect(meta).toContain('Project-URL: Homepage, https://unstuck.sh/docs');
      expect(meta).toContain('Project-URL: Repository, https://github.com/velmlabs/unstuck');
      expect(meta).toContain('Author: Velm Labs');
      expect(meta).toContain('License-Expression: Apache-2.0');
      expect(meta).not.toContain('AGPL');
      expect(files).toContain('unstuck-0.1.4.dist-info/licenses/LICENSE 0o644');
      expect(files.filter((f) => f.includes('dist-info/licenses/'))).toHaveLength(1);
      expect(files).toContain('unstuck/py.typed 0o644');
      // A platform wheel isn't pure Python: installers must put it in platlib.
      const wheelFile = py("import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(z.read('unstuck-0.1.4.dist-info/WHEEL').decode())", whl);
      expect(wheelFile).toContain('Root-Is-Purelib: false');
      expect(wheelFile).toContain(`Tag: py3-none-${p.wheel}`);
    }
    expect(fs.existsSync('sdk-py/src/unstuck/_bin')).toBe(false); // the workspace is left clean
  }, 300_000);

  it('installed in a fresh venv, the SDK finds its bundled engine', () => {
    const fake = path.join(tmp(), 'engine');
    fs.writeFileSync(fake, '#!/bin/sh\necho 0.1.4\n', { mode: 0o755 });
    const whl = buildWheel(PLATFORMS.find((x) => x.id === 'linux-x64'), fake, tmp());
    const venv = path.join(tmp(), 'venv');
    execFileSync('uv', ['venv', '-q', venv]);
    execFileSync('uv', ['pip', 'install', '-q', '--python', path.join(venv, 'bin/python'), whl]);
    const found = execFileSync(path.join(venv, 'bin/python'), ['-I', '-c', 'from unstuck._engine import resolve_engine_path; import subprocess; p = resolve_engine_path(None, {}); print(subprocess.check_output([p]).decode().strip())'], { encoding: 'utf8' }).trim();
    expect(found).toBe('0.1.4');
  }, 300_000);

  it('leaves no work folder behind (each held a ~50 MB wheel)', () => {
    const fake = path.join(tmp(), 'engine');
    fs.writeFileSync(fake, '#!/bin/sh\necho 0.1.4\n', { mode: 0o755 });
    const before = workDirs();
    buildWheel(PLATFORMS.find((x) => x.id === 'linux-x64'), fake, tmp());
    expect(workDirs()).toEqual(before);
  });
});
