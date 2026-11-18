import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { newDeviceKeyPair, exportDevicePublicKey } from '@velmlabs/unstuck-protocol';
import { browseConfig, cloudAlerterFor, main, parseRescueKinds, USAGE } from '../src/cli';
import { VERSION } from '../src/version';
import type { AssetMap } from '../src/embedded';

const assets: AssetMap = { '/index.html': { type: 'text/html', body: '' } };
function io(stdinText?: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  if (stdinText !== undefined) stdin.end(stdinText);
  return { stdin, stdout, stderr: { write: (s: string) => ((err += s), true) }, env: {}, assets, out: () => out, err: () => err };
}

describe('main', () => {
  it('USAGE lists every shell flag', () => {
    const shell = USAGE.slice(USAGE.indexOf('unstuck-engine rescue'), USAGE.indexOf('unstuck-engine --version'));
    for (const f of ['--profile', '--max-rescues-per-hour', '--relay', '--agent-key', '--url', '--max-wait']) expect(shell, f).toContain(f);
  });

  it('the shell commands dispatch before the MCP flags (usage problems are exit 2 with one JSON line)', async () => {
    for (const argv of [['rescue'], ['takeover'], ['ask'], ['wait'], ['cancel']]) {
      const x = { ...io(), env: { UNSTUCK_HOME: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'unstuck-cli-')) } };
      await expect(main(argv, x)).resolves.toBe(2);
      expect(JSON.parse(x.out()).error).toMatch(/^(usage|no_cdp)$/);
    }
  });

  it('--version prints the version', async () => {
    const x = io();
    await expect(main(['--version'], x)).resolves.toBe(0);
    expect(x.out().trim()).toBe(VERSION);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help prints usage', async () => {
    const x = io();
    await expect(main(['--help'], x)).resolves.toBe(0);
    expect(x.out()).toBe(USAGE);
  });

  it.each([[['--bogus']], [[]], [['--stdio', '--port', 'abc']]])('bad arguments %j exit 2 with usage on stderr', async (argv) => {
    const x = io();
    await expect(main(argv, x)).resolves.toBe(2);
    expect(x.err()).toContain('Usage: unstuck-engine');
  });

  it('--stdio answers hello on stdout only and exits 0 when stdin closes', async () => {
    const x = io();
    const lines: string[] = [];
    readline.createInterface({ input: x.stdout }).on('line', (l) => lines.push(l));
    const run = main(['--stdio', '--host', '127.0.0.1', '--port', '0'], x);
    x.stdin.write(JSON.stringify({ id: 1, method: 'engine.hello', params: { sdk: 'ts', sdkVersion: '0', protocolVersion: 1 } }) + '\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 4_000 });
    x.stdin.end();
    await expect(run).resolves.toBe(0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ id: 1, result: { engineVersion: VERSION, protocolVersion: 1, protocolMinor: 2, capabilities: ['guard', 'paintCheck', 'ask'] } }]);
    expect(x.err()).toMatch(/viewer server listening on http:\/\/127\.0\.0\.1:\d+/);
  });

  it('--stdio on a network-reachable host prints a warning', async () => {
    const x = io('');
    await expect(main(['--stdio', '--host', '0.0.0.0'], x)).resolves.toBe(0);
    expect(x.err()).toContain('reachable from your network');
  });

  it('--mcp serves MCP over stdio: initialize and tools/list, then exits 0 when stdin closes', async () => {
    const x = io();
    const lines: any[] = [];
    readline.createInterface({ input: x.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
    const run = main(['--mcp'], x);
    const send = (m: object) => x.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await vi.waitFor(() => expect(lines.some((l) => l.id === 2)).toBe(true), { timeout: 4_000 });
    x.stdin.end();
    await expect(run).resolves.toBe(0);
    expect(lines.find((l) => l.id === 1).result.serverInfo).toMatchObject({ name: 'unstuck', version: VERSION });
    expect(lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(['request_human_takeover', 'start_human_takeover', 'wait_for_human_takeover', 'cancel_human_takeover', 'ask_question', 'resume_after_human']);
    expect(x.err()).toMatch(/MCP server ready \(tools: request_human_takeover, start_human_takeover, wait_for_human_takeover, cancel_human_takeover, ask_question, resume_after_human\)/);
  });

  it('relay mode: the startup line names the relay and never the key', async () => {
    const x = io('');
    (x as { env: Record<string, string> }).env = { UNSTUCK_RELAY_URL: 'ws://127.0.0.1:9', UNSTUCK_AGENT_KEY: 'secret-key' };
    await expect(main(['--stdio'], x)).resolves.toBe(0);
    expect(x.err()).toContain('[unstuck] engine');
    expect(x.err()).toContain('relay ws://127.0.0.1:9');
    expect(x.err()).not.toContain('secret-key');
  });

  it('--relay and --agent-key flags pick relay mode', async () => {
    const x = io('');
    await expect(main(['--stdio', '--relay', 'ws://127.0.0.1:9', '--agent-key', 'k'], x)).resolves.toBe(0);
    expect(x.err()).toContain('relay ws://127.0.0.1:9');
  });

  it('--open without --mcp is a usage error', async () => {
    const x = io();
    await expect(main(['--stdio', '--open'], x)).resolves.toBe(2);
  });

  it('--stdio reports a port that is already taken and exits 1', async () => {
    const x = io();
    const blocker = await new Promise<import('node:net').Server>((r) => {
      const s = require('node:net').createServer().listen(0, '127.0.0.1', () => r(s));
    });
    const port = (blocker.address() as import('node:net').AddressInfo).port;
    await expect(main(['--stdio', '--port', String(port)], x)).resolves.toBe(1);
    expect(x.err()).toContain('EADDRINUSE');
    blocker.close();
  });
});

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'unstuck-engine');
// Starting a ~115 MB binary can take seconds on a loaded machine, so these tests get more time than the default.
describe.skipIf(!fs.existsSync(bin))('compiled binary', { timeout: 20_000 }, () => {
  it('--version works', async () => {
    const out = await new Promise<string>((resolve) => {
      let s = '';
      const p = spawn(bin, ['--version']);
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    expect(out.trim()).toBe(VERSION);
  });

  it('--stdio answers hello and exits 0 within 2 s of stdin closing', async () => {
    const p = spawn(bin, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    readline.createInterface({ input: p.stdout }).on('line', (l) => lines.push(l));
    p.stdin.write(JSON.stringify({ id: 1, method: 'engine.hello', params: { sdk: 'ts', sdkVersion: '0', protocolVersion: 1 } }) + '\n');
    // The compiled binary's start-up time depends on the machine's load: wait for its answer, not a fixed time.
    await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 15_000 });
    const t0 = Date.now();
    p.stdin.end();
    const code = await new Promise<number | null>((r) => p.on('close', r));
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
  });

  it('serves the embedded viewer page for a published session URL', async () => {
    const p = spawn(bin, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    await vi.waitFor(() => expect(err).toMatch(/127\.0\.0\.1:\d+/), { timeout: 15_000 });
    const port = /127\.0\.0\.1:(\d+)/.exec(err)?.[1];
    const res = await fetch(`http://127.0.0.1:${port}/s/unknown`);
    expect(res.status).toBe(404);
    p.stdin.end();
    await new Promise((r) => p.on('close', r));
  });
});

describe('browse flags', () => {
  const env = { UNSTUCK_HOME: '/u' };
  it('--browser (bare) is chrome; profile mcp, remember on, 10 an hour by default', () => {
    expect(browseConfig(['--mcp', '--browser'], env)).toEqual({ browse: { source: { kind: 'chrome' }, profile: 'mcp', remember: true, maxRescuesPerHour: 10, home: '/u' } });
    expect(browseConfig(['--mcp', '--browser=chrome', '--profile', 'work', '--no-remember', '--max-rescues-per-hour', '3'], env)).toEqual({
      browse: { source: { kind: 'chrome' }, profile: 'work', remember: false, maxRescuesPerHour: 3, home: '/u' },
    });
  });

  it('--browser=obscura takes --obscura-path, else OBSCURA_PATH, else obscura on PATH', () => {
    expect(browseConfig(['--mcp', '--browser=obscura', '--obscura-path', '/o/obscura'], env)).toMatchObject({ browse: { source: { kind: 'obscura', path: '/o/obscura' } } });
    expect(browseConfig(['--mcp', '--browser=obscura'], { ...env, OBSCURA_PATH: '/env/obscura' })).toMatchObject({ browse: { source: { kind: 'obscura', path: '/env/obscura' } } });
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'bin-'));
    fs.writeFileSync(path.join(dir, 'obscura'), '#!/bin/sh\n', { mode: 0o755 });
    expect(browseConfig(['--mcp', '--browser=obscura'], { ...env, PATH: `/nope:${dir}` })).toMatchObject({ browse: { source: { kind: 'obscura', path: path.join(dir, 'obscura') } } });
    expect(browseConfig(['--mcp', '--browser=obscura'], { ...env, PATH: '/nope' })).toEqual({ error: 'Obscura not found: pass --obscura-path <path to the obscura binary> or set OBSCURA_PATH.' });
  });

  it('--tools browser wraps UNSTUCK_CDP_URL, and needs it without --browser', () => {
    expect(browseConfig(['--mcp', '--tools', 'browser'], { ...env, UNSTUCK_CDP_URL: 'http://127.0.0.1:9222' })).toMatchObject({ browse: { source: { kind: 'cdp', url: 'http://127.0.0.1:9222' } } });
    expect(browseConfig(['--mcp', '--tools', 'browser'], env)).toEqual({ error: '--tools browser wraps the browser at UNSTUCK_CDP_URL; set it, or use --browser to let Unstuck start its own' });
    expect(browseConfig(['--mcp', '--tools', 'browser', '--browser'], env)).toMatchObject({ browse: { source: { kind: 'chrome' } } });
  });

  it('--allow-private-network lets the browser open local and intranet addresses (blocked by default)', () => {
    expect(browseConfig(['--mcp', '--browser'], env).browse).not.toHaveProperty('allowPrivateNetwork');
    expect(browseConfig(['--mcp', '--browser', '--allow-private-network'], env)).toMatchObject({ browse: { allowPrivateNetwork: true } });
    expect(browseConfig(['--mcp', '--allow-private-network'], env)).toHaveProperty('error');
  });

  it('UNSTUCK_IN_TOOL_WAIT_S sets how long a browsing tool waits for a person (1–110 s)', () => {
    expect(browseConfig(['--mcp', '--browser'], { ...env, UNSTUCK_IN_TOOL_WAIT_S: '5' })).toMatchObject({ browse: { inToolWaitMs: 5000 } });
    expect(browseConfig(['--mcp', '--browser'], env).browse).not.toHaveProperty('inToolWaitMs');
    for (const bad of ['0', '111', 'x']) expect(browseConfig(['--mcp', '--browser'], { ...env, UNSTUCK_IN_TOOL_WAIT_S: bad })).toEqual({ error: 'UNSTUCK_IN_TOOL_WAIT_S is a whole number of seconds from 1 to 110' });
  });

  it('--rescue sets the browsing scope (absent: the MCP default applies in the session); a bad kind is an error', () => {
    expect(browseConfig(['--mcp', '--browser', '--rescue', 'challenge, approval'], env)).toMatchObject({ browse: { rescue: ['challenge', 'approval'] } });
    expect(browseConfig(['--mcp', '--browser'], env).browse).not.toHaveProperty('rescue');
    expect(browseConfig(['--mcp', '--browser', '--rescue', 'soup'], env)).toEqual({ error: expect.stringContaining('unknown --rescue kind "soup"') });
  });

  it('--tools takeover (or no flag) is the four takeover tools; usage errors for the rest', () => {
    expect(browseConfig(['--mcp', '--tools', 'takeover'], env)).toEqual({});
    expect(browseConfig(['--mcp'], env)).toEqual({});
    for (const argv of [
      ['--mcp', '--browser', '--tools', 'takeover'],
      ['--stdio', '--browser'],
      ['--stdio', '--profile', 'x'],
      ['--mcp', '--browser=firefox'],
      ['--mcp', '--tools', 'all'],
      ['--mcp', '--browser', '--max-rescues-per-hour', '0'],
      ['--mcp', '--browser', '--profile', '../x'],
      ['--mcp', '--no-remember'],
    ])
      expect(browseConfig(argv, env), argv.join(' ')).toHaveProperty('error');
  });

  it('main: --mcp ends cleanly on SIGTERM, SIGINT or SIGHUP (closing the server, and the browser it started)', async () => {
    const { EventEmitter } = await import('node:events');
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const x = io();
      const signals = new EventEmitter();
      const run = main(['--mcp', '--browser'], { ...x, signals });
      await vi.waitFor(() => expect(x.err()).toContain('MCP server ready'));
      signals.emit(sig);
      await expect(run).resolves.toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    }
  });

  it('main: a browse usage error exits 2 with its line', async () => {
    const x = io('');
    await expect(main(['--mcp', '--tools', 'browser'], x)).resolves.toBe(2);
    expect(x.err()).toContain('--tools browser wraps the browser at UNSTUCK_CDP_URL; set it, or use --browser to let Unstuck start its own');
  });

  it('main: --mcp --browser lists the browse tools and starts no browser; --tools takeover lists the takeover tools, ask_question and resume_after_human', async () => {
    for (const [argv, count] of [[['--mcp', '--browser'], 19], [['--mcp', '--tools', 'takeover'], 6]] as const) {
      const x = io();
      const lines: any[] = [];
      readline.createInterface({ input: x.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
      const run = main([...argv], x);
      const send = (m: object) => x.stdin.write(JSON.stringify(m) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await vi.waitFor(() => expect(lines.some((l) => l.id === 2)).toBe(true), { timeout: 4_000 });
      x.stdin.end();
      await expect(run).resolves.toBe(0);
      const names = lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name);
      expect(names).toHaveLength(count);
      expect(x.err()).toContain(`MCP server ready (tools: ${names.join(', ')})`);
      if (count === 19) expect(names).toEqual(expect.arrayContaining(['fetch_page', 'open', 'ask_human']));
      expect(x.err()).not.toMatch(/DevTools/);
    }
  });
});

describe('--rescue', () => {
  it('parseRescueKinds reads a comma list', () => {
    expect(parseRescueKinds('challenge')).toEqual(['challenge']);
    expect(parseRescueKinds('challenge, approval,login,2fa,login')).toEqual(['challenge', 'approval', 'login', '2fa']);
  });

  it.each(['bogus', 'challenge,nope', ''])('rejects %j with the usage message', (v) => {
    expect(() => parseRescueKinds(v)).toThrow(/^unknown --rescue kind ".*" \(use challenge, approval, login, 2fa\)$/);
  });

  it('--rescue rejects an unknown kind (exit 2) and accepts a good list', async () => {
    const x = io('');
    await expect(main(['--stdio', '--rescue', 'challenge,soup'], x)).resolves.toBe(2);
    expect(x.err()).toContain('unknown --rescue kind "soup" (use challenge, approval, login, 2fa)');
    const y = io('');
    await expect(main(['--stdio', '--rescue', 'challenge,approval'], y)).resolves.toBe(0);
  });
});

describe('--mcp wiring', () => {
  it('a bad UNSTUCK_IN_TOOL_WAIT_S is a usage error even without a browser (ask_question waits by it too)', async () => {
    const bad = io();
    (bad as { env: Record<string, string> }).env = { UNSTUCK_IN_TOOL_WAIT_S: '999' };
    await expect(main(['--mcp'], bad)).resolves.toBe(2);
    expect(bad.err()).toContain('UNSTUCK_IN_TOOL_WAIT_S is a whole number of seconds from 1 to 110');
  });
});

describe('--agent-name', () => {
  async function notifyBody(flags: { agentName?: string }, env: Record<string, string>) {
    const pair = await newDeviceKeyPair();
    const publicKey = await exportDevicePublicKey(pair.publicKey);
    const bodies: any[] = [];
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
      if (String(url).endsWith('/devices')) return new Response(JSON.stringify({ devices: [{ id: 'd1', publicKey }] }), { status: 200 });
      bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }) as never);
    try {
      const alerter = cloudAlerterFor(flags, { UNSTUCK_API_KEY: 'k', ...env }, () => {});
      const out = await alerter!({ sessionId: 's1', url: 'https://v.example/#t=a&k=b', reason: 'r', expiresAt: 1, kind: 'approval' }, undefined);
      expect(out).toEqual({ delivered: 1 });
      return bodies[0];
    } finally {
      stub.mockRestore();
    }
  }
  it('--agent-name beats UNSTUCK_AGENT_NAME and reaches the notify body (cleaned), with the kind', async () => {
    const body = await notifyBody({ agentName: ' Flag\u200b Bot ' }, { UNSTUCK_AGENT_NAME: 'Env Bot' });
    expect(body).toMatchObject({ agentName: 'Flag Bot', kind: 'approval' });
  });
  it('UNSTUCK_AGENT_NAME is used without the flag; neither means no name', async () => {
    expect(await notifyBody({}, { UNSTUCK_AGENT_NAME: 'Env Bot' })).toMatchObject({ agentName: 'Env Bot' });
    expect(await notifyBody({}, {})).not.toHaveProperty('agentName');
  });
  it('no UNSTUCK_API_KEY, no alerter', () => {
    expect(cloudAlerterFor({ agentName: 'x' }, {}, () => {})).toBeUndefined();
  });
});
