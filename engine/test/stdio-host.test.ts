import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createRpcPeer, Methods, PROTOCOL_VERSION, type RpcPeer } from '@unstuck/protocol';
import { FakeTransport, FakeCdp } from '@unstuck/core/testing';
import { MemoryEventLog } from '@unstuck/core';
import { runStdioHost } from '../src/stdio-host';

function start() {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new FakeTransport();
  const log = new MemoryEventLog();
  const raw: string[] = [];
  const sdk: RpcPeer = createRpcPeer((l) => input.write(l + '\n'));
  readline.createInterface({ input: output }).on('line', (l) => {
    raw.push(l);
    sdk.receive(l);
  });
  const done = runStdioHost({ input, output, transport, log, version: '9.9.9' });
  return { input, output, transport, sdk, done, raw, log };
}

describe('runStdioHost', () => {
  it('answers engine.hello with versions', async () => {
    const h = start();
    await expect(h.sdk.request(Methods.hello, { sdk: 'ts', sdkVersion: '0', protocolVersion: PROTOCOL_VERSION })).resolves.toEqual({
      engineVersion: '9.9.9',
      protocolVersion: 1,
    });
    h.input.end();
    await h.done;
  });

  it('rejects a protocol version mismatch with protocol_mismatch', async () => {
    const h = start();
    await expect(h.sdk.request(Methods.hello, { sdk: 'ts', sdkVersion: '0', protocolVersion: 2 })).rejects.toMatchObject({ code: 'protocol_mismatch' });
    h.input.end();
    await h.done;
  });

  it('runs a takeover over the tunnel: link notification, then the result', async () => {
    const h = start();
    const cdp = new FakeCdp();
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const links: any[] = [];
    h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));

    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'CAPTCHA', timeoutS: 30 });
    await new Promise((r) => setTimeout(r, 50));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ pageId: 'p1', reason: 'CAPTCHA' });
    expect(links[0].url).toContain('#t=');

    const viewer = h.transport.connect(links[0].sessionId);
    viewer.push({ t: 'hello', token: new URL(links[0].url).hash.slice(3) });
    await new Promise((r) => setTimeout(r, 50));
    expect(cdp.methods()).toContain('Page.startScreencast');
    viewer.push({ t: 'done' });
    await expect(result).resolves.toMatchObject({ status: 'resolved', sessionId: links[0].sessionId });
    h.input.end();
    await h.done;
  });

  it('cdp.closed from the SDK fails the takeover with page_closed', async () => {
    const h = start();
    h.sdk.handle(Methods.cdpSend, () => ({}));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'x' });
    await new Promise((r) => setTimeout(r, 30));
    h.sdk.notify(Methods.cdpClosed, { pageId: 'p1', reason: 'page closed' });
    await expect(result).resolves.toMatchObject({ status: 'failed', detail: 'page_closed' });
    h.input.end();
    await h.done;
  });

  it('shutdown closes the engine and the transport, then the host resolves', async () => {
    const h = start();
    await expect(h.sdk.request(Methods.shutdown, {})).resolves.toEqual({});
    await h.done;
    expect(h.transport.closed).toBe(true);
  });

  it('ending stdin (SDK exited) cancels running takeovers and resolves', async () => {
    const h = start();
    h.sdk.handle(Methods.cdpSend, () => ({}));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    void h.sdk.request(Methods.takeover, { pageId: 'p1', reason: 'x' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    h.input.end();
    await h.done;
    expect(h.transport.closed).toBe(true);
    expect(h.log.events.at(-1)).toMatchObject({ type: 'finished', data: { status: 'cancelled', detail: 'engine_closed' } });
  });

  it('writes only valid JSON lines to stdout', async () => {
    const h = start();
    await h.sdk.request(Methods.hello, { sdk: 'ts', sdkVersion: '0', protocolVersion: 1 });
    h.input.write('garbage that is not json\n');
    await h.sdk.request(Methods.shutdown, {});
    await h.done;
    for (const l of h.raw) expect(() => JSON.parse(l)).not.toThrow();
  });
});
