import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageLauncher, stagePlatform } from './stage.mjs';
import { PLATFORMS } from './platforms.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));

describe('staging the engine packages', () => {
  it('the launcher package: manifest, bin, README, LICENSE', () => {
    const dir = stageLauncher(tmp(), '0.1.0');
    expect(fs.readdirSync(dir).sort()).toEqual(['LICENSE', 'README.md', 'bin', 'package.json']);
    expect(fs.readdirSync(path.join(dir, 'bin'))).toEqual(['unstuck-engine.mjs']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name).toBe('@velmlabs/unstuck-engine');
    expect(fs.statSync(path.join(dir, 'bin/unstuck-engine.mjs')).mode & 0o111).not.toBe(0);
  });
  it('a platform package: its binary (executable) under bin/', () => {
    const out = tmp();
    const bin = path.join(out, 'built-engine');
    fs.writeFileSync(bin, 'binary');
    const dir = stagePlatform(out, PLATFORMS[4], bin, '0.1.0');
    expect(fs.readdirSync(path.join(dir, 'bin'))).toEqual(['unstuck-engine.exe']);
    expect(fs.statSync(path.join(dir, 'bin/unstuck-engine.exe')).mode & 0o111).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).os).toEqual(['win32']);
    expect(fs.readdirSync(dir).sort()).toEqual(['LICENSE', 'README.md', 'bin', 'package.json']);
  });
});
