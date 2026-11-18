#!/usr/bin/env node
// Publishing (see the publish design in the private design notes).
//   pnpm release           dry run: build everything into release/, prove it works from a clean install, and record each
//                          artifact's SHA-256 with the commit in release/dry-run-passed.json
//   pnpm release:publish   publishes exactly those artifacts (scripts/publish.mjs)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildEngine, checkBinaryType, embedViewer, macosInfo } from './release/build-engines.mjs';
import { npmState, pypiState, sha1, sha256, writeManifest } from './release/manifest.mjs';
import { edgeSmoke } from './release/edge-smoke.mjs';
import { buildWheel } from './release/build-wheels.mjs';
import { tarballProblems, wheelProblems } from './release/checks.mjs';
import { PLATFORMS } from './release/platforms.mjs';
import { scrubbedEnv } from './release/env.mjs';
import { adhocSign, ensureRcodesign } from './release/rcodesign.mjs';
import { stageLauncher, stagePlatform } from './release/stage.mjs';

// The dry run needs no credentials, and it runs third-party code (npm install, Bun, uv, the packages under test).
// Drop every token/secret from this process first, so nothing it starts can inherit one (e.g. NPM_TOKEN, PYPI_TOKEN).
for (const k of Object.keys(process.env)) if (!(k in scrubbedEnv())) delete process.env[k];
// A token saved by `npm login` lives in ~/.npmrc, not the environment: point npm at an empty config instead.
const emptyNpmrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-npmrc-')), '.npmrc');
fs.writeFileSync(emptyNpmrc, '');
process.env.NPM_CONFIG_USERCONFIG = emptyNpmrc;
process.on('exit', () => fs.rmSync(path.dirname(emptyNpmrc), { recursive: true, force: true }));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'release');
const VERSION = '0.5.0';
const TS = [
  { dir: 'protocol', name: '@velmlabs/unstuck-protocol' },
  { dir: 'core', name: '@velmlabs/unstuck-core' },
  { dir: 'sdk-ts', name: '@velmlabs/unstuck' },
];
const step = (s) => console.log(`\n▸ ${s}`);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const host = PLATFORMS.find((p) => p.id === `${process.platform}-${process.arch}`);
if (!host) throw new Error(`the dry run needs to run a takeover; ${process.platform}-${process.arch} has no engine build`);

// ── 1. Versions ──────────────────────────────────────────────────────────────────────────────────────────────────────
step('versions');
for (const { dir } of TS) if (JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version !== VERSION) throw new Error(`${dir} is not ${VERSION}`);
if (!fs.readFileSync(path.join(root, 'sdk-py/pyproject.toml'), 'utf8').includes(`version = "${VERSION}"`)) throw new Error(`sdk-py is not ${VERSION}`);
// The relay's Docker image (ghcr.io/velmlabs/unstuck-relay) is tagged with relay-node's version: keep it the release's.
if (JSON.parse(fs.readFileSync(path.join(root, 'relay-node/package.json'), 'utf8')).version !== VERSION) throw new Error(`relay-node is not ${VERSION}`);
console.log(`all ${VERSION}`);

// ── 2. Build ─────────────────────────────────────────────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
const npmDir = path.join(OUT, 'npm');
const pypiDir = path.join(OUT, 'pypi');
fs.mkdirSync(npmDir, { recursive: true });

step(`engines (${PLATFORMS.length} platforms)`);
embedViewer();
const engines = {};
const rcodesign = PLATFORMS.some((p) => p.resign) ? ensureRcodesign(path.join(OUT, 'tools')) : undefined;
for (const p of PLATFORMS) {
  engines[p.id] = buildEngine(p, path.join(OUT, 'engines'));
  // Bun keeps its own Developer ID signature on the Intel Mac build; it no longer matches, so sign it ad-hoc.
  if (p.resign) adhocSign(engines[p.id], rcodesign);
  checkBinaryType(engines[p.id], p);
  if (p.os === 'darwin') {
    // The wheel tag must not claim an older macOS than the binary runs on, and the signature must match its pages.
    const mac = macosInfo(engines[p.id]);
    if (mac.minos !== p.minMacos) throw new Error(`${p.id}: built for macOS ${mac.minos}, but tagged for ${p.minMacos}`);
    if (mac.signature !== 'valid') throw new Error(`${p.id}: code signature is ${mac.signature}`);
  }
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
  await page.getByRole('button', { name: 'Start takeover' }).click(); // the page connects only on this tap
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
// The clean-install folders hold an engine (~100 MB) and a Python venv: removed when the dry run exits, pass or fail.
const scratch = [app];
process.on('exit', () => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
sh('npm', ['init', '-y'], { cwd: app, stdio: 'ignore' });
sh('npm', ['pkg', 'set', 'type=module'], { cwd: app, stdio: 'ignore' });
sh('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...hostTarballs, 'playwright@1.63.0', 'tsx@4.23.15'], { cwd: app, stdio: 'ignore', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
step('Edge entry: bundles for workerd with no Node built-in');
const edge = await edgeSmoke(app);
console.log(`@velmlabs/unstuck edge entry: ${(edge.bytes / 1024).toFixed(0)} KiB, ${edge.inputs} modules, no Node built-ins`);
fs.copyFileSync(path.join(root, 'examples/playwright-ts/index.ts'), path.join(app, 'index.ts'));
const tsStatus = await takeover('npx', ['tsx', 'index.ts', siteUrl], app, noEngineOverride);
if (tsStatus !== 'resolved') throw new Error(`TypeScript takeover: ${tsStatus}`);
console.log('resolved (engine found through @velmlabs/unstuck-engine, no UNSTUCK_ENGINE_PATH)');

/** Starts the installed MCP server with `args`, asks tools/list, and returns the tool names (and its stderr). */
async function mcpTools(args) {
  const mcp = spawn(path.join(app, 'node_modules/.bin/unstuck-engine'), args, { cwd: app, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = (msg) => mcp.stdin.write(JSON.stringify(msg) + '\n');
  let mcpOut = '';
  let mcpErr = '';
  mcp.stderr.on('data', (d) => (mcpErr += d));
  const names = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP server (${args.join(' ')}) didn't answer:\n${mcpOut}\n${mcpErr}`)), 30_000);
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
  return { names, stderr: mcpErr };
}

step('MCP: npx @velmlabs/unstuck-engine --mcp answers tools/list');
const tools = (await mcpTools(['--mcp'])).names;
if (!tools.includes('request_human_takeover')) throw new Error(`MCP tools: ${tools}`);
console.log(`tools: ${tools.join(', ')}`);

step('MCP: --mcp --browser lists fetch_page and starts no browser');
const browse = await mcpTools(['--mcp', '--browser']);
if (!browse.names.includes('fetch_page') || !browse.names.includes('resume_after_human')) throw new Error(`MCP --browser tools: ${browse.names}`);
if (/DevTools listening/.test(browse.stderr)) throw new Error('MCP --browser started a browser before any tool call');
console.log(`tools: ${browse.names.join(', ')}`);

step('Python: fresh venv, pip install, Playwright takeover');
const venvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-py-'));
scratch.push(venvRoot);
const venv = path.join(venvRoot, 'venv');
sh('uv', ['venv', '-q', venv]);
const pyWheel = wheels.find((w) => w.endsWith(`${host.wheel}.whl`));
sh('uv', ['pip', 'install', '-q', '--python', path.join(venv, 'bin/python'), pyWheel, 'playwright==1.63.0']);
const pyStatus = await takeover(path.join(venv, 'bin/python'), ['-I', path.join(root, 'examples/playwright-py/main.py'), siteUrl], path.dirname(venv), noEngineOverride);
if (pyStatus !== 'resolved') throw new Error(`Python takeover: ${pyStatus}`);
console.log('resolved (engine bundled in the wheel)');
site.close();

// ── 5. Registries: free, or (resuming) already published with exactly these bytes ─────────────────────────────────
step(`registries: ${VERSION}`);
const clash = [];
let resumed = 0;
for (const [name, tgz] of Object.entries(tarballs)) {
  const state = await npmState(name, VERSION, sha1(tgz));
  if (state === 'different') clash.push(`npm ${name}@${VERSION} is already published with different contents`);
  if (state === 'same') resumed++;
}
for (const w of wheels) {
  const state = await pypiState('unstuck', VERSION, path.basename(w), sha256(w));
  if (state === 'different') clash.push(`PyPI ${path.basename(w)} is already published with different contents`);
  if (state === 'same') resumed++;
}
if (clash.length) throw new Error(clash.join('\n'));
console.log(resumed ? `free, except ${resumed} already published with these exact bytes (they'll be skipped)` : 'free');

// ── 6. Record what passed ───────────────────────────────────────────────────────────────────────────────────────────
const head = sh('git', ['rev-parse', 'HEAD']).trim();
const dirty = sh('git', ['status', '--porcelain', '--', '.', ':!release']).trim();
if (dirty) {
  console.log('\n✓ dry run passed, but the working tree has uncommitted changes: commit them and run it again before publishing');
  process.exit(0);
}
writeManifest(OUT, [...Object.values(tarballs), ...wheels].map((f) => path.relative(OUT, f)), head);
console.log(`\n✓ dry run passed for ${head.slice(0, 7)}; publish these exact files with: pnpm release:publish`);
