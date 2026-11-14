import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, USAGE } from '../src/cli';
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
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ id: 1, result: { engineVersion: VERSION, protocolVersion: 1 } }]);
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
    expect(lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(['request_human_takeover']);
    expect(x.err()).toMatch(/MCP server ready/);
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
