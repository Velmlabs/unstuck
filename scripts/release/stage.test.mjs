import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageLauncher, stagePlatform } from './stage.mjs';
import { PLATFORMS } from './platforms.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));

describe('staging the engine packages', () => {
  it('the launcher package: manifest, bin, README, LICENSE', () => {
    const dir = stageLauncher(tmp(), '0.1.1');
    expect(fs.readdirSync(dir).sort()).toEqual(['LICENSE', 'README.md', 'bin', 'package.json']);
    expect(fs.readdirSync(path.join(dir, 'bin'))).toEqual(['unstuck-engine.mjs']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name).toBe('@velmlabs/unstuck-engine');
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('macOS (Apple silicon or Intel)');
    expect(readme).not.toContain('Intel Macs come in a later version');
    expect(fs.statSync(path.join(dir, 'bin/unstuck-engine.mjs')).mode & 0o111).not.toBe(0);
  });
  it('a platform package: its binary (executable) under bin/', () => {
    const out = tmp();
    const bin = path.join(out, 'built-engine');
    fs.writeFileSync(bin, 'binary');
    const dir = stagePlatform(out, PLATFORMS.find((p) => p.id === 'win32-x64'), bin, '0.1.1');
    expect(fs.readdirSync(path.join(dir, 'bin'))).toEqual(['unstuck-engine.exe']);
    expect(fs.statSync(path.join(dir, 'bin/unstuck-engine.exe')).mode & 0o111).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).os).toEqual(['win32']);
    // The binary embeds the AGPL viewer: both licences and the notice with the source offer ship with it.
    expect(fs.readdirSync(dir).sort()).toEqual(['LICENSE', 'LICENSE-AGPL', 'NOTICE', 'README.md', 'bin', 'package.json']);
    expect(fs.readFileSync(path.join(dir, 'LICENSE-AGPL'), 'utf8')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    const notice = fs.readFileSync(path.join(dir, 'NOTICE'), 'utf8');
    expect(notice).toContain('AGPL-3.0-only');
    expect(notice).toContain('support@unstuck.sh');
    expect(notice).toContain('0.1.1');
  });
});
