import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmState, pypiState, sha1, sha256, verifyManifest, writeManifest } from './manifest.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
const json = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });

describe('hashes', () => {
  it('sha1 and sha256 of a file, hex', () => {
    const f = path.join(tmp(), 'a');
    fs.writeFileSync(f, 'hello');
    expect(sha1(f)).toBe(crypto.createHash('sha1').update('hello').digest('hex'));
    expect(sha256(f)).toBe(crypto.createHash('sha256').update('hello').digest('hex'));
  });
});

describe('the dry-run record', () => {
  const setup = () => {
    const out = tmp();
    fs.mkdirSync(path.join(out, 'npm'));
    fs.writeFileSync(path.join(out, 'npm/a.tgz'), 'a');
    fs.writeFileSync(path.join(out, 'b.whl'), 'b');
    writeManifest(out, ['npm/a.tgz', 'b.whl'], 'c0ffee');
    return out;
  };
  it('records the commit and each file hash, and verifies against them', () => {
    const out = setup();
    const rec = JSON.parse(fs.readFileSync(path.join(out, 'dry-run-passed.json'), 'utf8'));
    expect(rec.commit).toBe('c0ffee');
    expect(rec.files['b.whl']).toBe(sha256(path.join(out, 'b.whl')));
    expect(verifyManifest(out, 'c0ffee')).toEqual(['npm/a.tgz', 'b.whl']);
  });
  it('refuses with no dry run, another commit, a changed or a missing file', () => {
    expect(() => verifyManifest(tmp(), 'c0ffee')).toThrow(/run pnpm release first/);
    const out = setup();
    expect(() => verifyManifest(out, 'beef')).toThrow(/dry run passed for c0ffee, but HEAD is beef/);
    fs.writeFileSync(path.join(out, 'b.whl'), 'changed');
    expect(() => verifyManifest(out, 'c0ffee')).toThrow(/b.whl changed since the dry run/);
    fs.rmSync(path.join(out, 'npm/a.tgz'));
    expect(() => verifyManifest(out, 'c0ffee')).toThrow(/npm\/a.tgz is missing/);
  });
});

describe('npm registry state', () => {
  it('free when the package or version does not exist', async () => {
    expect(await npmState('@velmlabs/unstuck', '0.1.0', 'x', json(404, {}))).toBe('free');
    expect(await npmState('@velmlabs/unstuck', '0.1.0', 'x', json(200, { versions: { '0.0.1': {} }, time: {} }))).toBe('free');
  });
  it('same or different by the tarball sha1', async () => {
    const body = { versions: { '0.1.0': { dist: { shasum: 'abc' } } }, time: { '0.1.0': 't' } };
    expect(await npmState('@velmlabs/unstuck', '0.1.0', 'abc', json(200, body))).toBe('same');
    expect(await npmState('@velmlabs/unstuck', '0.1.0', 'def', json(200, body))).toBe('different');
  });
  it('a version published then unpublished can never be reused', async () => {
    expect(await npmState('@velmlabs/unstuck', '0.1.0', 'abc', json(200, { versions: {}, time: { '0.1.0': 't' } }))).toBe('different');
  });
  it('asks for the scoped name escaped, and fails loudly on a registry error', async () => {
    let url;
    await npmState('@velmlabs/unstuck-core', '0.1.0', 'x', async (u) => ((url = u), { status: 404, ok: false }));
    expect(url).toBe('https://registry.npmjs.org/@velmlabs%2funstuck-core');
    await expect(npmState('@velmlabs/unstuck', '0.1.0', 'x', json(500, {}))).rejects.toThrow(/npm registry answered 500/);
  });
});

describe('PyPI state', () => {
  const release = { urls: [{ filename: 'u.whl', digests: { sha256: 'abc' } }] };
  it('free when the project, the release or that file is not there', async () => {
    expect(await pypiState('unstuck', '0.1.0', 'u.whl', 'abc', json(404, {}))).toBe('free');
    expect(await pypiState('unstuck', '0.1.0', 'v.whl', 'abc', json(200, release))).toBe('free');
  });
  it('same or different by the file sha256', async () => {
    expect(await pypiState('unstuck', '0.1.0', 'u.whl', 'abc', json(200, release))).toBe('same');
    expect(await pypiState('unstuck', '0.1.0', 'u.whl', 'def', json(200, release))).toBe('different');
  });
  it('asks for that release, and fails loudly on an error', async () => {
    let url;
    await pypiState('unstuck', '0.1.0', 'u.whl', 'abc', async (u) => ((url = u), { status: 404, ok: false }));
    expect(url).toBe('https://pypi.org/pypi/unstuck/0.1.0/json');
    await expect(pypiState('unstuck', '0.1.0', 'u.whl', 'abc', json(503, {}))).rejects.toThrow(/PyPI answered 503/);
  });
});
