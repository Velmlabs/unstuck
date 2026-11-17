#!/usr/bin/env node
// Publishes the artifacts a dry run (pnpm release) proved, byte for byte. PyPI first: its token can't be checked
// beforehand, so a bad one stops the release before anything is on npm. Anything already published with the same
// bytes is skipped, so a release that stopped halfway is finished by running this again. Tokens are never printed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmState, pypiState, sha1, sha256, verifyManifest } from './release/manifest.mjs';
import { PLATFORMS } from './release/platforms.mjs';
import { publishCredentials, scrubbedEnv } from './release/env.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'release');
const VERSION = '0.3.0';
// Every command gets a credential-free environment unless it is given exactly the one secret it needs.
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', env: scrubbedEnv(), ...opts });

if (sh('git', ['status', '--porcelain', '--', '.', ':!release']).trim()) throw new Error('uncommitted changes: commit, run the dry run, then publish');
const files = verifyManifest(OUT, sh('git', ['rev-parse', 'HEAD']).trim()).map((f) => path.join(OUT, f));
const creds = publishCredentials();
console.log(`credentials: ${creds.mode === 'trusted' ? 'GitHub OIDC (trusted publishing, provenance)' : 'NPM_TOKEN / PYPI_TOKEN'}`);

const npmrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npmrc-')), '.npmrc');
fs.writeFileSync(npmrc, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', { mode: 0o600 }); // npm expands it; the value never lands on disk
process.on('exit', () => fs.rmSync(path.dirname(npmrc), { recursive: true, force: true })); // pass or fail
const npmEnv = creds.mode === 'token' ? { ...creds.npmEnv, NPM_CONFIG_USERCONFIG: npmrc } : creds.npmEnv;
if (creds.mode === 'token') console.log(`npm account: ${sh('npm', ['whoami'], { env: npmEnv }).trim() ? 'ok' : '?'}`);

console.log('\n▸ PyPI');
const wheels = files.filter((f) => f.endsWith('.whl'));
const toUpload = [];
for (const w of wheels) {
  const state = await pypiState('unstuck', VERSION, path.basename(w), sha256(w));
  if (state === 'different') throw new Error(`${path.basename(w)} is already on PyPI with different contents`);
  if (state === 'same') console.log(`already there: ${path.basename(w)}`);
  else toUpload.push(w);
}
// uv reads the token from UV_PUBLISH_TOKEN; it is never on the command line or printed.
if (toUpload.length) sh('uv', ['publish', ...creds.uvArgs, ...toUpload], { env: creds.uvEnv, stdio: ['ignore', 'inherit', 'inherit'] });

console.log('\n▸ npm');
const byName = Object.fromEntries(files.filter((f) => f.endsWith('.tgz')).map((f) => [JSON.parse(sh('tar', ['-xzOf', f, 'package/package.json'])).name, f]));
const order = ['@velmlabs/unstuck-protocol', '@velmlabs/unstuck-core', ...PLATFORMS.map((p) => `@velmlabs/unstuck-engine-${p.id}`), '@velmlabs/unstuck-engine', '@velmlabs/unstuck'];
for (const name of order) {
  const tgz = byName[name];
  const state = await npmState(name, VERSION, sha1(tgz));
  if (state === 'different') throw new Error(`${name}@${VERSION} is already on npm with different contents`);
  if (state === 'same') {
    console.log(`already there: ${name}@${VERSION}`);
    continue;
  }
  sh('npm', ['publish', tgz, '--access', 'public', ...creds.npmArgs], { env: npmEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`published ${name}@${VERSION}`);
}
console.log(`\n✓ ${VERSION} is on npm and PyPI`);
