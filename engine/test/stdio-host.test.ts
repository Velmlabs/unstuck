import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createRpcPeer, Methods, PROTOCOL_VERSION, type RpcPeer } from '@velmlabs/unstuck-protocol';
import { FakeTransport, FakeCdp } from '@velmlabs/unstuck-core/testing';
import { MemoryEventLog } from '@velmlabs/unstuck-core';
import { runStdioHost } from '../src/stdio-host';

function start(alerter?: (info: any, site: string | undefined) => Promise<void>) {
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
  const done = runStdioHost({ input, output, transport, log, version: '9.9.9', alerter });
  return { input, output, transport, sdk, done, raw, log };
}

describe('runStdioHost alerts', () => {
  async function run(alerter: ((info: any, site: string | undefined) => Promise<void>) | undefined, params: object) {
    const h = start(alerter);
    const cdp = new FakeCdp();
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const links: any[] = [];
    h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'CAPTCHA', timeoutS: 30, site: 'news.example.com', ...params });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    const viewer = h.transport.connect(links[0].url);
    viewer.push({ t: 'hello', token: new URLSearchParams(new URL(links[0].url).hash.slice(1)).get('t') });
    await new Promise((r) => setTimeout(r, 30));
    viewer.push({ t: 'done' });
    await result;
    h.input.end();
    await h.done;
    return links;
  }

  it('sends an alert with the link and the takeover site by default (the link notification is unchanged)', async () => {
    const alerter = vi.fn<(info: any, site: string | undefined) => Promise<void>>(async () => {});
    const links = await run(alerter, {});
    expect(alerter).toHaveBeenCalledTimes(1);
    expect(alerter.mock.calls[0]![0]).toMatchObject({ sessionId: links[0].sessionId, url: links[0].url, reason: 'CAPTCHA' });
    expect(alerter.mock.calls[0]![1]).toBe('news.example.com');
  });

  it('alerts: false skips the alerter, and the link notification still arrives', async () => {
    const alerter = vi.fn<(info: any, site: string | undefined) => Promise<void>>(async () => {});
    const links = await run(alerter, { alerts: false });
    expect(alerter).not.toHaveBeenCalled();
    expect(links[0].url).toContain('#t=');
  });

  it('alerts: true sends, and no alerter configured is fine', async () => {
    const alerter = vi.fn<(info: any, site: string | undefined) => Promise<void>>(async () => {});
    await run(alerter, { alerts: true });
    expect(alerter).toHaveBeenCalledTimes(1);
    await run(undefined as any, {});
  });
});

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

    const viewer = h.transport.connect(links[0].url);
    viewer.push({ t: 'hello', token: new URLSearchParams(new URL(links[0].url).hash.slice(1)).get('t') });
    await new Promise((r) => setTimeout(r, 50));
    expect(cdp.methods()).toContain('Page.startScreencast');
    viewer.push({ t: 'done' });
    await expect(result).resolves.toMatchObject({ status: 'resolved', sessionId: links[0].sessionId });
    h.input.end();
    await h.done;
  });

  it('passes the agent\'s allowedSites to the page lock: a listed site is let through, another is stopped', async () => {
    const h = start();
    const cdp = new FakeCdp();
    cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN', url: 'https://shop.example.com/' } } }));
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const links: any[] = [];
    h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'x', allowedSites: ['accounts.google.com'] });
    await new Promise((r) => setTimeout(r, 50));
    const paused = (requestId: string, url: string) =>
      h.sdk.notify(Methods.cdpEvent, { pageId: 'p1', method: 'Fetch.requestPaused', params: { requestId, frameId: 'MAIN', request: { url } } });
    paused('r1', 'https://accounts.google.com/signin');
    paused('r2', 'https://mail.google.com/');
    await new Promise((r) => setTimeout(r, 50));
    expect(cdp.calls.filter((c) => c.method === 'Fetch.continueRequest' || c.method === 'Fetch.failRequest').map((c) => c.method)).toEqual(['Fetch.continueRequest', 'Fetch.failRequest']);
    const viewer = h.transport.connect(links[0].url);
    viewer.push({ t: 'hello', token: new URLSearchParams(new URL(links[0].url).hash.slice(1)).get('t') });
    await new Promise((r) => setTimeout(r, 50));
    viewer.push({ t: 'done' });
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    h.input.end();
    await h.done;
  });

  it('page.popup moves the stream to the popup the SDK attached (Review Focus 4)', async () => {
    const h = start();
    const page = new FakeCdp();
    const popup = new FakeCdp();
    const byId: Record<string, FakeCdp> = { p1: page, pop1: popup };
    h.sdk.handle(Methods.cdpSend, (p) => byId[(p as { pageId: string }).pageId]!.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const links: any[] = [];
    h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'x' });
    // Wait for each step itself, not a fixed time: on a loaded machine a step can take longer than any guess.
    await vi.waitFor(() => expect(links).toHaveLength(1));
    const viewer = h.transport.connect(links[0].url);
    viewer.push({ t: 'hello', token: new URLSearchParams(new URL(links[0].url).hash.slice(1)).get('t') });
    await vi.waitFor(() => expect(page.methods().filter((m) => m === 'Page.startScreencast').length).toBe(2)); // probe + stream
    h.sdk.notify(Methods.pagePopup, { pageId: 'p1', popupPageId: 'pop1' });
    h.sdk.notify(Methods.pagePopup, { pageId: 'unknown', popupPageId: 'pop2' });
    await vi.waitFor(() => expect(popup.methods().filter((m) => m === 'Page.startScreencast').length).toBe(2)); // probe + stream
    viewer.push({ t: 'done' });
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
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

describe('hostnames', () => {
  it('keeps plausible hostnames only, at most 20', async () => {
    const { hostnames } = await import('../src/stdio-host');
    expect(hostnames(['accounts.google.com', '*.okta.com', 'localhost', 'https://x.com', 'a b', 7, '', 'x'.repeat(300)])).toEqual(['accounts.google.com', '*.okta.com', 'localhost']);
    expect(hostnames('example.com')).toEqual([]);
    // A bare public suffix would allow a whole TLD or platform (a prompt-injected agent could be talked into it).
    expect(hostnames(['com', 'co.uk', 'github.io', '*.co.uk', 'me.github.io', 'example.co.uk'])).toEqual(['me.github.io', 'example.co.uk']);
    expect(hostnames(undefined)).toEqual([]);
    expect(hostnames(Array.from({ length: 30 }, (_, i) => `s${i}.com`))).toHaveLength(20);
  });
});
