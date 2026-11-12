import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { WebSocket } from 'ws';
import type { ViewerConnection } from '@unstuck/core';
import { createEmbeddedTransport, EXPIRED_HTML_MARKER, type AssetMap } from '../src/embedded';

const ASSETS: AssetMap = {
  '/index.html': { type: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><p>viewer</p>').toString('base64') },
  '/assets/app.js': { type: 'text/javascript', body: Buffer.from('console.log(1)').toString('base64') },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function make(opts: Partial<Parameters<typeof createEmbeddedTransport>[0]> = {}) {
  const t = await createEmbeddedTransport({ ...opts, assets: ASSETS });
  cleanups.push(() => t.close());
  return t;
}
function openWs(url: string): Promise<{ ws: WebSocket; ok: boolean; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve({ ws, ok: true }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, ok: false, status: res.statusCode }));
    ws.once('error', () => resolve({ ws, ok: false }));
  });
}

describe('createEmbeddedTransport', () => {
  it('binds 127.0.0.1 on a free port by default', async () => {
    const t = await make();
    expect(t.host).toBe('127.0.0.1');
    expect(t.port).toBeGreaterThan(0);
  });

  it('warns when bound to a host reachable from the network', async () => {
    const warnings: string[] = [];
    await make({ host: '0.0.0.0', warn: (m) => warnings.push(m) });
    expect(warnings.join(' ')).toContain('reachable from your network');
  });

  it('does not warn for loopback hosts', async () => {
    const warnings: string[] = [];
    await make({ host: 'localhost', warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it('reads UNSTUCK_HOST and UNSTUCK_PORT from env', async () => {
    const free = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const t = await make({ env: { UNSTUCK_HOST: '127.0.0.1', UNSTUCK_PORT: String(free) } });
    expect(t.port).toBe(free);
  });

  it('publish returns a /s/<id> base URL; a public URL override is honoured', async () => {
    const t = await make();
    expect((await t.publish('abc')).baseUrl).toBe(`http://127.0.0.1:${t.port}/s/abc`);
    const t2 = await make({ publicUrl: 'https://box.example.com/' });
    expect((await t2.publish('abc')).baseUrl).toBe('https://box.example.com/s/abc');
  });

  it('serves the viewer for a published session with security headers', async () => {
    const t = await make();
    await t.publish('abc');
    const res = await fetch(`http://127.0.0.1:${t.port}/s/abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('viewer');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves static assets with their content type and 404s unknown paths', async () => {
    const t = await make();
    const js = await fetch(`http://127.0.0.1:${t.port}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(await js.text()).toBe('console.log(1)');
    expect((await fetch(`http://127.0.0.1:${t.port}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${t.port}/whatever`)).status).toBe(404);
  });

  it('an unknown or unpublished session gets a 404 "expired or is invalid" page', async () => {
    const t = await make();
    const res = await fetch(`http://127.0.0.1:${t.port}/s/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(EXPIRED_HTML_MARKER);
    expect(EXPIRED_HTML_MARKER).toBe('expired or is invalid');
    // The page styles itself inline, so its CSP must allow inline styles (and nothing else).
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    await t.publish('abc');
    await t.unpublish('abc');
    expect((await fetch(`http://127.0.0.1:${t.port}/s/abc`)).status).toBe(404);
  });

  it('WebSocket to a published session reaches onConnection; text and binary flow both ways', async () => {
    const t = await make();
    await t.publish('abc');
    const conn = new Promise<ViewerConnection>((r) => t.onConnection('abc', r));
    const { ws, ok } = await openWs(`ws://127.0.0.1:${t.port}/ws/abc`);
    expect(ok).toBe(true);
    const c = await conn;
    const got = new Promise<string | Uint8Array>((r) => c.onMessage(r));
    ws.send('{"t":"ping"}');
    expect(await got).toBe('{"t":"ping"}');

    const bin = new Promise<Buffer>((r) => ws.once('message', (d, isBinary) => isBinary && r(d as Buffer)));
    c.send(new Uint8Array([1, 2]));
    expect(Array.from(await bin)).toEqual([1, 2]);
    const txt = new Promise<string>((r) => ws.once('message', (d, isBinary) => !isBinary && r(d.toString())));
    c.send('hi');
    expect(await txt).toBe('hi');
    expect(c.bufferedAmount).toBeGreaterThanOrEqual(0);

    const gotBin = new Promise<string | Uint8Array>((r) => c.onMessage(r));
    ws.send(Buffer.from([9]));
    expect(await gotBin).toEqual(new Uint8Array([9]));

    const closed = new Promise<void>((r) => c.onClose(r));
    c.close(1000, 'bye');
    await closed;
  });

  it('refuses WebSockets for unpublished sessions and unknown paths', async () => {
    const t = await make();
    expect((await openWs(`ws://127.0.0.1:${t.port}/ws/nope`)).status).toBe(404);
    expect((await openWs(`ws://127.0.0.1:${t.port}/elsewhere`)).status).toBe(404);
  });

  it('a published session with no connection handler yet still accepts and drops the socket', async () => {
    const t = await make();
    await t.publish('abc');
    const { ws, ok } = await openWs(`ws://127.0.0.1:${t.port}/ws/abc`);
    expect(ok).toBe(true);
    await new Promise<void>((r) => ws.once('close', () => r()));
  });

  it('close() frees the port and closes open sockets', async () => {
    const t = await createEmbeddedTransport({ assets: ASSETS });
    await t.publish('abc');
    t.onConnection('abc', () => {});
    const { ws } = await openWs(`ws://127.0.0.1:${t.port}/ws/abc`);
    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    await t.close();
    await closed;
    const again = await createEmbeddedTransport({ assets: ASSETS, port: t.port });
    expect(again.port).toBe(t.port);
    await again.close();
  });

  it('rejects when the port is taken', async () => {
    const t = await make();
    await expect(createEmbeddedTransport({ assets: ASSETS, port: t.port })).rejects.toThrow(/EADDRINUSE/);
  });
});
