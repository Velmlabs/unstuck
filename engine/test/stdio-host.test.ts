import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createRpcPeer, Methods, PROTOCOL_VERSION, type RpcPeer } from '@velmlabs/unstuck-protocol';
import { FakeTransport, FakeCdp } from '@velmlabs/unstuck-core/testing';
import { MemoryEventLog } from '@velmlabs/unstuck-core';
import { REQUIRED_WITHOUT_CLOUD, runStdioHost } from '../src/stdio-host';

function start(alerter?: (info: any, site: string | undefined) => Promise<any>, agentName?: string) {
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
  const done = runStdioHost({ input, output, transport, log, version: '9.9.9', alerter, agentName });
  return { input, output, transport, sdk, done, raw, log };
}

describe('runStdioHost alerts', () => {
  async function run(alerter: ((info: any, site: string | undefined) => Promise<any>) | undefined, params: object) {
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

  it('the alert goes out even if passing the link on throws, and the takeover still ends normally', async () => {
    const alerter = vi.fn(async () => ({ delivered: 0 as const, problem: 'no_devices' as const }));
    const h = start(alerter);
    const write = h.output.write.bind(h.output);
    h.output.write = ((chunk: unknown, ...rest: never[]) => {
      if (String(chunk).includes(Methods.takeoverLink)) throw new Error('EPIPE');
      return write(chunk as never, ...rest);
    }) as typeof h.output.write;
    const cdp = new FakeCdp();
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'CAPTCHA', timeoutS: 30, alerts: 'required' });
    await expect(result).resolves.toMatchObject({ status: 'failed', detail: 'alert_failed' });
    expect(alerter).toHaveBeenCalledTimes(1);
    h.input.end();
    await h.done;
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

  describe("alerts: 'required'", () => {
    async function required(alerter: ((info: any, site: string | undefined) => Promise<any>) | undefined) {
      const h = start(alerter);
      const cdp = new FakeCdp();
      h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
      h.sdk.handle(Methods.cdpSubscribe, () => ({}));
      const links: any[] = [];
      h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));
      const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'CAPTCHA', timeoutS: 30, site: 'news.example.com', alerts: 'required' });
      return { h, links, result };
    }
    const end = async (h: { input: PassThrough; done: Promise<void> }) => {
      h.input.end();
      await h.done;
    };

    it('the link reached no phone → failed/alert_failed within 1 s', async () => {
      for (const problem of ['no_devices', 'notify_failed', 'alerts_not_allowed']) {
        const t = await required(async () => ({ delivered: 0, problem }));
        const started = Date.now();
        await expect(t.result).resolves.toMatchObject({ status: 'failed', detail: 'alert_failed' });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(t.links).toHaveLength(1);
        await end(t.h);
      }
    });

    it('delivered to one phone → the takeover goes on', async () => {
      const t = await required(async () => ({ delivered: 1 }));
      await vi.waitFor(() => expect(t.links).toHaveLength(1));
      const settled = vi.fn();
      void t.result.then(settled, settled);
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).not.toHaveBeenCalled();
      await end(t.h);
      await expect(t.result).resolves.toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    });

    it('no Cloud alerter (self-hosted relay, local server) → config_error before any takeover starts', async () => {
      const t = await required(undefined);
      await expect(t.result).rejects.toMatchObject({ code: 'config_error', message: REQUIRED_WITHOUT_CLOUD });
      expect(t.links).toHaveLength(0);
      expect(t.h.transport.published.size).toBe(0);
      await end(t.h);
    });
  });
});

describe('runStdioHost', () => {
  it('serves the guard methods: an unknown guard is unknown_guard', async () => {
    const h = start();
    await expect(h.sdk.request('guard.check', { guardId: 'g9' })).rejects.toMatchObject({ code: 'unknown_guard' });
    h.input.end();
    await h.done;
  });

  it('answers engine.hello with versions', async () => {
    const h = start();
    await expect(h.sdk.request(Methods.hello, { sdk: 'ts', sdkVersion: '0', protocolVersion: PROTOCOL_VERSION })).resolves.toEqual({
      engineVersion: '9.9.9',
      protocolVersion: 1,
      protocolMinor: 2,
      capabilities: ['guard', 'paintCheck', 'ask'],
    });
    // A newer SDK with a higher minor is still served.
    await expect(h.sdk.request(Methods.hello, { sdk: 'py', sdkVersion: '0', protocolVersion: PROTOCOL_VERSION, protocolMinor: 7 })).resolves.toMatchObject({ protocolMinor: 2 });
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

describe('runStdioHost ask and approval takeovers', () => {
  const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('t');

  it('ask over RPC: link notification, then the answer', async () => {
    const alerter = vi.fn(async (_info: any, _site: string | undefined, _extra?: any) => ({ delivered: 1 }));
    const h = start(alerter as any);
    const links: any[] = [];
    h.sdk.onNotification(Methods.askLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.ask, { question: 'Which account?', choices: ['Work', 'Home'], private: false, timeoutS: 30, alerts: true });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(links[0]).toMatchObject({ reason: 'Which account?' });
    expect(Object.keys(links[0]).sort()).toEqual(['expiresAt', 'reason', 'sessionId', 'url']);
    expect(alerter).toHaveBeenCalledTimes(1);
    expect(alerter.mock.calls[0]![0]).toMatchObject({ kind: 'question', sessionId: links[0].sessionId });
    expect(alerter.mock.calls[0]![1]).toBeUndefined();
    expect(alerter.mock.calls[0]![2]).toEqual({ quick: { question: 'Which account?', choices: ['Work', 'Home'] } });
    const viewer = h.transport.connect(links[0].url);
    viewer.push({ t: 'hello', token: tokenOf(links[0].url) });
    await new Promise((r) => setTimeout(r, 30));
    viewer.push({ t: 'answer', choice: 1 });
    await expect(result).resolves.toMatchObject({ status: 'answered', answer: { label: 'Home' } });
    h.input.end();
    await h.done;
  });

  it('ask echoes linkId in its link notification; a bad linkId is bad_params', async () => {
    const h = start(vi.fn(async () => ({ delivered: 1 })) as any);
    const links: any[] = [];
    h.sdk.onNotification(Methods.askLink, (p) => links.push(p));
    void h.sdk.request<any>(Methods.ask, { question: 'Which?', linkId: 'ask-7', timeoutS: 30 }).catch(() => {});
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(links[0]).toMatchObject({ linkId: 'ask-7', reason: 'Which?' });
    for (const linkId of [5, 'x'.repeat(65)]) await expect(h.sdk.request(Methods.ask, { question: 'Q?', linkId })).rejects.toMatchObject({ code: 'bad_params' });
    h.input.end();
    await h.done;
  });

  it('a private question sends no quick text to the alerter', async () => {
    const alerter = vi.fn(async (_info: any, _site: string | undefined, _extra?: any) => ({ delivered: 1 }));
    const h = start(alerter as any);
    const links: any[] = [];
    h.sdk.onNotification(Methods.askLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.ask, { question: 'Code?', timeoutS: 30 });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(alerter.mock.calls[0]).toHaveLength(2);
    h.input.end();
    await h.done;
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });

  it.each([
    [{ question: 'q', choices: ['1', '2', '3', '4', '5', '6', '7'] }, 'choices must be 2-6 labels of at most 80 characters'],
    [{ question: 'q', allowText: false }, 'a question needs choices or allowText'],
    [{ question: 'q', choices: 'yes' }, 'choices must be 2-6 labels of at most 80 characters'],
    [{ question: 'q', choices: ['a', 3] }, 'choices must be 2-6 labels of at most 80 characters'],
    [{ question: 'q', allowText: 'yes' }, 'allowText must be true or false'],
    [{ question: 'q', private: 'no' }, 'private must be true or false'],
    [{ question: 'q', alerts: 'sometimes' }, "alerts must be true, false or 'required'"],
    [undefined, 'question must be 1-300 characters'],
  ])('ask with bad params %j is bad_params', async (params, message) => {
    const h = start();
    await expect(h.sdk.request(Methods.ask, params as any)).rejects.toMatchObject({ code: 'bad_params', message });
    h.input.end();
    await h.done;
  });

  it("ask alerts: 'required' without Cloud is config_error", async () => {
    const h = start();
    await expect(h.sdk.request(Methods.ask, { question: 'q', alerts: 'required' })).rejects.toMatchObject({ code: 'config_error', message: REQUIRED_WITHOUT_CLOUD });
    expect(h.transport.published.size).toBe(0);
    h.input.end();
    await h.done;
  });

  it('takeover with mode approval runs an approval session, and kind reaches the alert (default other)', async () => {
    const alerter = vi.fn(async (_info: any, _site: string | undefined) => ({ delivered: 1 }));
    const h = start(alerter as any);
    const cdp = new FakeCdp();
    let prompt = true;
    cdp.respond('Runtime.evaluate', () => ({ result: { value: prompt ? 'https://bank.example/approve' : 'https://bank.example/home' } }));
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const links: any[] = [];
    h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'Approve the sign-in', timeoutS: 30, mode: 'approval', kind: 'approval' });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(links[0]).toMatchObject({ kind: 'approval', mode: 'approval' });
    expect(alerter.mock.calls[0]![0]).toMatchObject({ kind: 'approval', mode: 'approval' });
    const viewer = h.transport.connect(links[0].url);
    expect(viewer).toBeDefined();
    prompt = false;
    h.input.end();
    await h.done;
    await result;
  });

  it('a plain takeover alert has kind other', async () => {
    const alerter = vi.fn(async (_info: any, _site: string | undefined) => ({ delivered: 1 }));
    const h = start(alerter as any);
    const cdp = new FakeCdp();
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const links: any[] = [];
    h.sdk.onNotification(Methods.takeoverLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'x', timeoutS: 30 });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(alerter.mock.calls[0]![0]).toMatchObject({ kind: 'other' });
    h.input.end();
    await h.done;
    await result;
  });

  it.each([
    [{ mode: 'question' }, 'mode must be control or approval'],
    [{ mode: 'x' }, 'mode must be control or approval'],
    [{ kind: 'my secret reason' }, 'kind must be one of challenge, approval, login, question, other'],
  ])('takeover with %j is bad_params', async (extra, message) => {
    const h = start();
    await expect(h.sdk.request(Methods.takeover, { pageId: 'p1', reason: 'r', ...extra })).rejects.toMatchObject({ code: 'bad_params', message });
    expect(h.transport.published.size).toBe(0);
    h.input.end();
    await h.done;
  });

  it('a private:false question without choices is alerted without question or choices', async () => {
    const alerter = vi.fn(async (_info: any, _site: string | undefined, _extra?: any) => ({ delivered: 1 }));
    const h = start(alerter as any);
    const links: any[] = [];
    h.sdk.onNotification(Methods.askLink, (p) => links.push(p));
    const result = h.sdk.request<any>(Methods.ask, { question: 'Code?', private: false, timeoutS: 30 });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(alerter.mock.calls[0]).toHaveLength(2);
    h.input.end();
    await h.done;
    await result;
  });

  it('the agent name reaches the viewer mode frame for ask, approval takeover and control takeover', async () => {
    const h = start(undefined, 'Flag Bot');
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: 'https://bank.example/approve' } }));
    h.sdk.handle(Methods.cdpSend, (p) => cdp.send((p as { method: string }).method, (p as { params?: object }).params));
    h.sdk.handle(Methods.cdpSubscribe, () => ({}));
    const askLinks: any[] = [];
    const tkLinks: any[] = [];
    h.sdk.onNotification(Methods.askLink, (p) => askLinks.push(p));
    h.sdk.onNotification(Methods.takeoverLink, (p) => tkLinks.push(p));
    const a = h.sdk.request<any>(Methods.ask, { question: 'q', timeoutS: 30 });
    const t = h.sdk.request<any>(Methods.takeover, { pageId: 'p1', reason: 'Approve', timeoutS: 30, mode: 'approval', kind: 'approval' });
    await vi.waitFor(() => expect(askLinks.length + tkLinks.length).toBe(2));
    for (const link of [askLinks[0], tkLinks[0]]) {
      const viewer = h.transport.connect(link.url);
      viewer.push({ t: 'hello', token: tokenOf(link.url) });
      await vi.waitFor(() => expect(viewer.json().some((m: any) => m.t === 'mode')).toBe(true));
      expect(viewer.json().find((m: any) => m.t === 'mode')).toMatchObject({ agentName: 'Flag Bot' });
    }
    h.input.end();
    await h.done;
    await Promise.all([a, t]);
  });
});
