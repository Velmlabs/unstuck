#!/usr/bin/env node
// Publishing 0.1.0 (docs/superpowers/specs/2026-11-14-publish-design.md).
//   node scripts/release.mjs             dry run: build everything into release/ and prove it works from a clean install
//   node scripts/release.mjs --publish   the same dry run, then publish to npm (NPM_TOKEN) and PyPI (secure credential)
// Tokens are never printed or written into the repo.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildEngine, checkBinaryType, embedViewer } from './release/build-engines.mjs';
import { buildWheel } from './release/build-wheels.mjs';
import { tarballProblems, wheelProblems } from './release/checks.mjs';
import { PLATFORMS } from './release/platforms.mjs';
import { stageLauncher, stagePlatform } from './release/stage.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'release');
const VERSION = '0.1.0';
const TS = [
  { dir: 'protocol', name: '@velmlabs/unstuck-protocol' },
  { dir: 'core', name: '@velmlabs/unstuck-core' },
  { dir: 'sdk-ts', name: '@velmlabs/unstuck' },
];
const publish = process.argv.includes('--publish');
const step = (s) => console.log(`\n▸ ${s}`);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const host = PLATFORMS.find((p) => p.id === `${process.platform}-${process.arch}`);
if (!host) throw new Error(`the dry run needs to run a takeover; ${process.platform}-${process.arch} has no engine build`);

// ── 1. Versions ──────────────────────────────────────────────────────────────────────────────────────────────────────
step('versions');
for (const { dir } of TS) if (JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version !== VERSION) throw new Error(`${dir} is not ${VERSION}`);
if (!fs.readFileSync(path.join(root, 'sdk-py/pyproject.toml'), 'utf8').includes(`version = "${VERSION}"`)) throw new Error(`sdk-py is not ${VERSION}`);
console.log(`all ${VERSION}`);

// ── 2. Build ─────────────────────────────────────────────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
const npmDir = path.join(OUT, 'npm');
const pypiDir = path.join(OUT, 'pypi');
fs.mkdirSync(npmDir, { recursive: true });

step('engines (5 platforms)');
embedViewer();
const engines = {};
for (const p of PLATFORMS) {
  engines[p.id] = buildEngine(p, path.join(OUT, 'engines'));
  checkBinaryType(engines[p.id], p);
  console.log(`${p.id}: ${(fs.statSync(engines[p.id]).size / 1048576).toFixed(0)} MB`);
}

const pack = (cwd, tool = 'pnpm') => {
  const out = sh(tool, ['pack', '--pack-destination', npmDir], { cwd }).trim().split('\n').pop().trim();
  return path.isAbsolute(out) ? out : path.join(npmDir, path.basename(out));
};
const tarballs = {};
step('TypeScript packages');
for (const { dir, name } of TS) {
  sh('pnpm', ['--filter', name, 'run', 'build:dist'], { stdio: 'ignore' });
  tarballs[name] = pack(path.join(root, dir));
}
step('engine packages');
const stage = path.join(OUT, 'stage');
tarballs['@velmlabs/unstuck-engine'] = pack(stageLauncher(stage, VERSION), 'npm');
for (const p of PLATFORMS) tarballs[`@velmlabs/unstuck-engine-${p.id}`] = pack(stagePlatform(stage, p, engines[p.id], VERSION), 'npm');

step('Python wheels');
const wheels = PLATFORMS.map((p) => buildWheel(p, engines[p.id], pypiDir));
for (const w of wheels) console.log(path.basename(w));

// ── 3. Contents ──────────────────────────────────────────────────────────────────────────────────────────────────────
step('contents');
const problems = [];
for (const [name, tgz] of Object.entries(tarballs)) {
  const files = sh('tar', ['-tzf', tgz]).trim().split('\n').map((f) => f.replace(/^package\//, ''));
  problems.push(...tarballProblems(name, files));
  const manifest = JSON.parse(sh('tar', ['-xzOf', tgz, 'package/package.json']));
  if (manifest.version !== VERSION) problems.push(`${name}: version ${manifest.version}`);
  if (JSON.stringify(manifest).includes('workspace:')) problems.push(`${name}: workspace: dependency left in`);
}
for (const w of wheels) {
  const files = sh('python3', ['-I', '-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', w]).trim().split('\n');
  problems.push(...wheelProblems(path.basename(w), files));
  const mb = fs.statSync(w).size / 1048576;
  if (mb > 95) problems.push(`${path.basename(w)}: ${mb.toFixed(0)} MB (PyPI's limit is 100 MB)`);
}
if (problems.length) throw new Error(`package contents:\n  ${problems.join('\n  ')}`);
console.log(`${Object.keys(tarballs).length} npm packages, ${wheels.length} wheels: contents ok`);

// ── 4. Clean installs, real takeovers ────────────────────────────────────────────────────────────────────────────────
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const fixture = fs.readFileSync(path.join(root, 'e2e/fixtures/fake-captcha.html'));
const site = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(fixture));
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

/** Runs an example the way a user would, plays the person on a phone, and returns its printed outcome. */
async function takeover(cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const link = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no link within 120 s:\n${out}`)), 120_000);
    const onData = (d) => {
      out += d;
      const m = /Open this link:\s*\n\s*(\S+)/.exec(out);
      if (m) (clearTimeout(timer), resolve(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => (clearTimeout(timer), reject(new Error(`example exited (${c}) before printing a link:\n${out}`))));
  });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  await page.goto(link);
  await page.waitForFunction(() => (document.querySelector('canvas')?.width ?? 0) > 300, null, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await new Promise((r) => child.on('exit', r));
  await browser.close();
  return /Takeover (\w+)/.exec(out)?.[1] ?? `none:\n${out}`;
}
// Only the engine for this machine is installed, as npm would; the other four are skipped like any foreign optional dependency.
const hostTarballs = Object.entries(tarballs).filter(([n]) => !n.startsWith('@velmlabs/unstuck-engine-') || n === `@velmlabs/unstuck-engine-${host.id}`).map(([, t]) => t);
const noEngineOverride = { UNSTUCK_ENGINE_PATH: '', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers' };

step('TypeScript: clean folder, npm install, Quickstart takeover');
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-app-'));
sh('npm', ['init', '-y'], { cwd: app, stdio: 'ignore' });
sh('npm', ['pkg', 'set', 'type=module'], { cwd: app, stdio: 'ignore' });
sh('npm', ['install', '--no-audit', '--no-fund', ...hostTarballs, 'playwright@1.63.0', 'tsx@4'], { cwd: app, stdio: 'ignore', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
fs.copyFileSync(path.join(root, 'examples/playwright-ts/index.ts'), path.join(app, 'index.ts'));
const tsStatus = await takeover('npx', ['tsx', 'index.ts', siteUrl], app, noEngineOverride);
if (tsStatus !== 'resolved') throw new Error(`TypeScript takeover: ${tsStatus}`);
console.log('resolved (engine found through @velmlabs/unstuck-engine, no UNSTUCK_ENGINE_PATH)');

step('MCP: npx @velmlabs/unstuck-engine --mcp answers tools/list');
const mcp = spawn(path.join(app, 'node_modules/.bin/unstuck-engine'), ['--mcp'], { cwd: app, stdio: ['pipe', 'pipe', 'inherit'] });
const rpc = (msg) => mcp.stdin.write(JSON.stringify(msg) + '\n');
let mcpOut = '';
const tools = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`MCP server didn't answer:\n${mcpOut}`)), 30_000);
  mcp.stdout.on('data', (d) => {
    mcpOut += d;
    for (const line of mcpOut.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.id === 2) (clearTimeout(timer), resolve(m.result.tools.map((t) => t.name)));
      } catch {}
    }
  });
  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check', version: '0' } } });
  rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
});
mcp.kill();
if (!tools.includes('request_human_takeover')) throw new Error(`MCP tools: ${tools}`);
console.log(`tools: ${tools.join(', ')}`);

step('Python: fresh venv, pip install, Playwright takeover');
const venv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-py-')), 'venv');
sh('uv', ['venv', '-q', venv]);
const pyWheel = wheels.find((w) => w.endsWith(`${host.wheel}.whl`));
sh('uv', ['pip', 'install', '-q', '--python', path.join(venv, 'bin/python'), pyWheel, 'playwright==1.63.0']);
const pyStatus = await takeover(path.join(venv, 'bin/python'), ['-I', path.join(root, 'examples/playwright-py/main.py'), siteUrl], path.dirname(venv), noEngineOverride);
if (pyStatus !== 'resolved') throw new Error(`Python takeover: ${pyStatus}`);
console.log('resolved (engine bundled in the wheel)');
site.close();

// ── 5. Not yet published? ────────────────────────────────────────────────────────────────────────────────────────────
step(`registries: ${VERSION} must be free`);
const taken = [];
for (const name of Object.keys(tarballs)) if ((await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${VERSION}`)).status !== 404) taken.push(`npm ${name}@${VERSION}`);
if ((await fetch(`https://pypi.org/pypi/unstuck/${VERSION}/json`)).status !== 404) taken.push(`PyPI unstuck ${VERSION}`);
if (taken.length) throw new Error(`already published: ${taken.join(', ')}`);
console.log('free');

console.log('\n✓ dry run passed');
if (!publish) process.exit(0);

// ── 6. Publish ───────────────────────────────────────────────────────────────────────────────────────────────────────
if (!process.env.NPM_TOKEN) throw new Error('NPM_TOKEN is not set');
const npmrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npmrc-')), '.npmrc');
fs.writeFileSync(npmrc, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', { mode: 0o600 }); // npm expands it; the value never lands on disk
const order = ['@velmlabs/unstuck-protocol', '@velmlabs/unstuck-core', ...PLATFORMS.map((p) => `@velmlabs/unstuck-engine-${p.id}`), '@velmlabs/unstuck-engine', '@velmlabs/unstuck'];
step('npm');
for (const name of order) {
  sh('npm', ['publish', tarballs[name], '--access', 'public'], { env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc }, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`published ${name}@${VERSION}`);
}
fs.rmSync(path.dirname(npmrc), { recursive: true, force: true });
step('PyPI');
// The proxy adds the real credential for upload.pypi.org; uv needs some value to send.
sh('uv', ['publish', '--username', '__token__', '--password', 'injected-by-proxy', ...wheels], { stdio: ['ignore', 'inherit', 'inherit'] });
console.log(`\n✓ published ${VERSION}`);
