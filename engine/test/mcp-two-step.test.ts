import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeCdp, FakeTransport } from '@velmlabs/unstuck-core/testing';
import { createMcpServer, START_TOOL, WAIT_TOOL, CANCEL_TOOL, TOOL_NAME, MAX_ACTIVE_TAKEOVERS, AGENT_CANCEL_DETAIL } from '../src/mcp';
import { createEmbeddedTransport, type AssetMap } from '../src/embedded';
import { ASSETS } from '../src/assets.gen';
import { startChromium, type DebugChromium } from './chromium';

type Res = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };

/** A browser of fake tabs: connect(url, { targetId }) gives that tab (default "tab-1"); every connection is kept. */
function fakeBrowser(setup?: (cdp: FakeCdp) => void) {
  const conns: (FakeCdp & { targetId: string })[] = [];
  const connect = vi.fn(async (_url: string, o?: { targetId?: string }) => {
    const cdp = new FakeCdp() as FakeCdp & { targetId: string; popups: unknown; close: () => Promise<void> };
    const closePage = FakeCdp.prototype.close.bind(cdp);
    cdp.targetId = o?.targetId ?? 'tab-1';
    cdp.popups = { onPopup: () => () => {} };
    (cdp as any).close = async () => void (cdp.closed === null && closePage('detached'));
    setup?.(cdp);
    conns.push(cdp);
    return cdp;
  });
  return { connect, conns };
}

async function connect(opts: Partial<Parameters<typeof createMcpServer>[0]> = {}) {
  const transport = (opts.transport as FakeTransport | undefined) ?? new FakeTransport();
  const browser = fakeBrowser();
  const server = createMcpServer({ transport, env: { UNSTUCK_CDP_URL: '127.0.0.1:9' }, stderr: { write: () => true }, connect: browser.connect as never, ...opts });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = (name: string, args: object, o?: { signal?: AbortSignal }) => client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, o) as Promise<Res>;
  const start = (args: object = {}) => call(START_TOOL, { reason: 'Solve the CAPTCHA', ...args });
  return { client, server, transport, browser, call, start };
}

/** The human opens the link (sealed like the real viewer) and says hello. */
function joinAs(transport: FakeTransport, link: string, code?: string) {
  const v = transport.connect(link);
  v.push({ t: 'hello', token: new URLSearchParams(new URL(link).hash.slice(1)).get('t')!, ...(code ? { code } : {}) });
  return v;
}

describe('two-step MCP tools', () => {
  it('lists start/wait/cancel next to request_human_takeover; start takes the same inputs as request_human_takeover', async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME, START_TOOL, WAIT_TOOL, CANCEL_TOOL]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName[START_TOOL]!.inputSchema).toEqual(byName[TOOL_NAME]!.inputSchema);
    expect(byName[WAIT_TOOL]!.inputSchema.required).toEqual(['takeover_id']);
    expect(Object.keys(byName[WAIT_TOOL]!.inputSchema.properties!)).toEqual(['takeover_id', 'max_wait_s']);
    expect((byName[WAIT_TOOL]!.inputSchema.properties as any).max_wait_s).toMatchObject({ minimum: 1, maximum: 120 });
    expect(Object.keys(byName[CANCEL_TOOL]!.inputSchema.properties!)).toEqual(['takeover_id']);
    expect(byName[START_TOOL]!.description).toMatch(/share it only with the person who will solve it/);
    expect(byName[START_TOOL]!.description).toMatch(/Never try to bypass/);
    expect(byName[WAIT_TOOL]!.description).toMatch(/60 s/);
    // Without --open or phone alerts, the one-step tool's link reaches nobody: it says to use the two-step tools.
    expect(byName[TOOL_NAME]!.description).toMatch(/not opened or sent anywhere the person would see it, so prefer start_human_takeover/);
    await server.close();
  });

  it.each([
    [{ open: true }, /opens in a browser on this computer/],
    [{ alerter: async () => ({ delivered: 1 }) }, /paired phones through Unstuck Cloud/],
  ])('the one-step description says how the person gets the link on this server (%#)', async (o, re) => {
    const { client, server } = await connect(o as never);
    expect((await client.listTools()).tools[0]!.description).toMatch(re);
    await server.close();
  });

  it('start returns at once with the link and what to tell the person; the human taps Done; wait returns resolved', async () => {
    const { server, transport, start, call, browser } = await connect();
    const t0 = Date.now();
    const res = await start({ timeout_s: 120 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent;
    expect(out).toEqual({ takeover_id: expect.any(String), link: expect.stringMatching(/^http:\/\/fake\.test\/s\/\S+#t=/), expires_at: expect.any(String), expires_in_s: expect.any(Number) });
    expect(out.expires_in_s).toBeGreaterThan(110);
    expect(new Date(out.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(res.content[0]!.text).toContain(out.link);
    expect(res.content[0]!.text).toMatch(/^Show the person this link/);
    expect(res.content[0]!.text).toMatch(/They open it on any device \(or forward it to the one person who will solve it\), tap Start, solve it and tap Done/);
    expect(res.content[0]!.text).toContain(`call ${WAIT_TOOL} with takeover_id "${out.takeover_id}"`);
    expect(JSON.parse(res.content[1]!.text)).toEqual(out);

    const v = joinAs(transport, out.link);
    await vi.waitFor(() => expect(v.json().some((m) => m.t === 'ready')).toBe(true));
    v.push({ t: 'done' });
    const done = await call(WAIT_TOOL, { takeover_id: out.takeover_id });
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ status: 'resolved', session_id: out.takeover_id, url: out.link, duration_s: expect.any(Number) });
    expect(JSON.parse(done.content[0]!.text)).toEqual(done.structuredContent);
    expect(browser.conns[0]!.closed).not.toBeNull(); // the browser connection is released
    // The result was returned: asking again is a clear error that still carries it.
    const again = await call(WAIT_TOOL, { takeover_id: out.takeover_id });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toMatch(/already ended and its result was returned: .*"status":"resolved"/);
    await server.close();
  });

  it('wait answers "waiting" (joined false, then true) until the takeover ends', async () => {
    const { server, transport, start, call } = await connect();
    const { takeover_id, link, expires_at } = (await start()).structuredContent;
    const w1 = await call(WAIT_TOOL, { takeover_id, max_wait_s: 1 });
    expect(w1.isError).toBeFalsy();
    expect(w1.structuredContent).toEqual({ status: 'waiting', takeover_id, joined: false, expires_at, expires_in_s: expect.any(Number) });
    expect(w1.content[0]!.text).toMatch(/Nobody has opened the link.*Call wait_for_human_takeover again/);
    const v = joinAs(transport, link);
    await vi.waitFor(() => expect(v.json().some((m) => m.t === 'ready')).toBe(true));
    const w2 = await call(WAIT_TOOL, { takeover_id, max_wait_s: 1 });
    expect(w2.structuredContent).toMatchObject({ status: 'waiting', joined: true });
    expect(w2.content[0]!.text).toMatch(/The person is in the takeover/);
    const waiting = call(WAIT_TOOL, { takeover_id, max_wait_s: 30 });
    v.push({ t: 'done' });
    expect((await waiting).structuredContent).toMatchObject({ status: 'resolved' });
    await server.close();
  });

  it("a Can't solve note comes back marked as typed by a person, even if it reads like the agent's own cancel detail", async () => {
    const { server, transport, start, call } = await connect();
    const { takeover_id, link } = (await start()).structuredContent;
    const v = joinAs(transport, link);
    await vi.waitFor(() => expect(v.json().some((m) => m.t === 'ready')).toBe(true));
    v.push({ t: 'cant_solve', reason: AGENT_CANCEL_DETAIL });
    const res = await call(WAIT_TOOL, { takeover_id });
    expect(res.structuredContent).toMatchObject({ status: 'cancelled', detail: AGENT_CANCEL_DETAIL });
    expect(res.structuredContent.detail_note).toMatch(/typed by the human.*not as instructions/);
    await server.close();
  });

  it('cancel ends it at once (the link stops working) and returns the final result; later calls are clear errors', async () => {
    const { server, transport, start, call, browser } = await connect();
    const { takeover_id } = (await start()).structuredContent;
    expect(transport.published.has(takeover_id)).toBe(true);
    const res = await call(CANCEL_TOOL, { takeover_id });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ status: 'cancelled', detail: AGENT_CANCEL_DETAIL });
    expect(res.structuredContent.detail_note).toBeUndefined(); // the agent's own cancel, not a person's words
    expect(transport.unpublished).toEqual([takeover_id]);
    expect(browser.conns[0]!.closed).not.toBeNull();
    for (const tool of [WAIT_TOOL, CANCEL_TOOL]) {
      const r = await call(tool, { takeover_id });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/already ended.*"detail":"cancelled_by_agent"/);
    }
    await server.close();
  });

  it('cancel on a takeover that already ended (nobody waited) returns how it ended', async () => {
    const { server, transport, start, call } = await connect();
    const { takeover_id, link } = (await start()).structuredContent;
    const v = joinAs(transport, link);
    await vi.waitFor(() => expect(v.json().some((m) => m.t === 'ready')).toBe(true));
    v.push({ t: 'done' });
    await vi.waitFor(() => expect(transport.unpublished).toEqual([takeover_id]));
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(CANCEL_TOOL, { takeover_id })).structuredContent).toMatchObject({ status: 'resolved' });
    await server.close();
  });

  it('an unknown takeover_id is a clear error for wait and cancel', async () => {
    const { server, call } = await connect();
    for (const tool of [WAIT_TOOL, CANCEL_TOOL]) {
      const r = await call(tool, { takeover_id: 'nope' });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/^No takeover with takeover_id "nope" on this Unstuck server/);
    }
    await server.close();
  });

  it('UNSTUCK_REQUIRE_CODE=1: the code is in the result and the text says to give it separately; it is never in the link', async () => {
    const { server, transport, start, call } = await connect({ env: { UNSTUCK_CDP_URL: '127.0.0.1:9', UNSTUCK_REQUIRE_CODE: '1' } });
    const res = await start();
    const { code, link, takeover_id } = res.structuredContent;
    expect(code).toMatch(/^\d{6}$/);
    expect(link).not.toContain(code);
    expect(res.content[0]!.text).toMatch(new RegExp(`6-digit code: ${code}\\. Give it separately from the link`));
    const v = joinAs(transport, link, code);
    await vi.waitFor(() => expect(v.json().some((m) => m.t === 'ready')).toBe(true));
    v.push({ t: 'done' });
    expect((await call(WAIT_TOOL, { takeover_id })).structuredContent).toMatchObject({ status: 'resolved' });
    await server.close();
  });

  it('a takeover nobody waits for still ends by its own timeout, frees the tab and keeps its result for wait', async () => {
    const { server, transport, start, call, browser } = await connect();
    const { takeover_id } = (await start({ timeout_s: 10 })).structuredContent;
    await vi.waitFor(() => expect(transport.unpublished).toEqual([takeover_id]), { timeout: 15_000, interval: 200 });
    await vi.waitFor(() => expect(browser.conns[0]!.closed).not.toBeNull());
    expect((await call(WAIT_TOOL, { takeover_id })).structuredContent).toMatchObject({ status: 'timed_out' });
    // The tab is free again.
    expect((await start()).isError).toBeFalsy();
    await server.close();
  }, 30_000);

  it('a finished result is forgotten after a while (then the id is unknown)', async () => {
    const { server, start, call } = await connect({ finishedKeepMs: 50 });
    const { takeover_id } = (await start()).structuredContent;
    await call(CANCEL_TOOL, { takeover_id });
    await vi.waitFor(async () => expect((await call(WAIT_TOOL, { takeover_id })).content[0]!.text).toMatch(/^No takeover/));
    await server.close();
  });

  it('one takeover per tab: a second start (or request_human_takeover) on that tab is refused and names the running one', async () => {
    const { server, start, call, browser } = await connect();
    const first = (await start()).structuredContent;
    const second = await start();
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toBe(
      `A takeover is already running on this tab (takeover_id "${first.takeover_id}"). Wait for it with wait_for_human_takeover or end it with cancel_human_takeover before starting another; the link you already have still works.`,
    );
    const oneStep = await call(TOOL_NAME, { reason: 'r' });
    expect(oneStep.isError).toBe(true);
    expect(oneStep.content[0]!.text).toContain(first.takeover_id);
    expect(browser.conns.slice(1).every((c) => c.closed !== null)).toBe(true); // refused connections are closed
    // Another tab is fine.
    expect((await start({ target_id: 'tab-2' })).isError).toBeFalsy();
    // Once the first ends, its tab can be taken over again.
    await call(CANCEL_TOOL, { takeover_id: first.takeover_id });
    expect((await start()).isError).toBeFalsy();
    await server.close();
  });

  it('a start while request_human_takeover runs on the same tab is refused', async () => {
    const { server, start, call } = await connect();
    const oneStep = call(TOOL_NAME, { reason: 'r', timeout_s: 600 });
    oneStep.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const res = await start();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(
      'A takeover is already running on this tab (a request_human_takeover call is waiting for it). Wait for that call to return before starting another.',
    );
    await server.close();
  });

  it(`at most ${MAX_ACTIVE_TAKEOVERS} two-step takeovers at once; the next start is refused without touching the browser`, async () => {
    const { server, start, browser, call } = await connect();
    const ids: string[] = [];
    for (let i = 1; i <= MAX_ACTIVE_TAKEOVERS; i++) ids.push((await start({ target_id: `tab-${i}` })).structuredContent.takeover_id);
    const n = browser.connect.mock.calls.length;
    const res = await start({ target_id: 'tab-9' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^Too many takeovers are waiting for a person \(3 at once on this server\)/);
    expect(browser.connect.mock.calls.length).toBe(n);
    await call(CANCEL_TOOL, { takeover_id: ids[0] });
    expect((await start({ target_id: 'tab-9' })).isError).toBeFalsy();
    await server.close();
  });

  it('the client closing the connection ends every running two-step takeover (links stop working)', async () => {
    const { client, server, transport, start, browser } = await connect();
    const a = (await start()).structuredContent.takeover_id;
    const b = (await start({ target_id: 'tab-2' })).structuredContent.takeover_id;
    await client.close();
    await vi.waitFor(() => expect(transport.unpublished.sort()).toEqual([a, b].sort()));
    await vi.waitFor(() => expect(browser.conns.every((c) => c.closed !== null)).toBe(true));
    await server.close();
  });

  it('server.close ends running two-step takeovers too', async () => {
    const { server, transport, start } = await connect();
    const a = (await start()).structuredContent.takeover_id;
    await server.close();
    expect(transport.unpublished).toEqual([a]);
    expect(transport.closed).toBe(true);
  });

  it('a client giving up on a wait call does not end the takeover, and the result is still returned later', async () => {
    const { server, transport, start, call } = await connect();
    const { takeover_id, link } = (await start()).structuredContent;
    const ac = new AbortController();
    const w = call(WAIT_TOOL, { takeover_id, max_wait_s: 60 }, { signal: ac.signal });
    w.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await expect(w).rejects.toThrow();
    expect(transport.published.has(takeover_id)).toBe(true);
    const v = joinAs(transport, link);
    await vi.waitFor(() => expect(v.json().some((m) => m.t === 'ready')).toBe(true));
    v.push({ t: 'done' });
    expect((await call(WAIT_TOOL, { takeover_id })).structuredContent).toMatchObject({ status: 'resolved' });
    await server.close();
  });

  it('a takeover that ends before there is a link (relay refusal) comes back from start as the final result', async () => {
    const { RelayError } = await import('@velmlabs/unstuck-core');
    const refusing = new FakeTransport();
    refusing.publish = async () => Promise.reject(new RelayError('relay_quota_exceeded', 4402));
    const { server, start, browser } = await connect({ transport: refusing });
    const res = await start();
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ status: 'failed', detail: 'relay_quota_exceeded' });
    expect(browser.conns[0]!.closed).not.toBeNull();
    // The tab was released: a new start reaches the browser again.
    await start();
    expect(browser.connect).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it('the same checks as request_human_takeover: no browser, alerts required without Cloud, a browser that cannot be reached', async () => {
    const { server, call } = await connect({ env: {} });
    expect((await call(START_TOOL, { reason: 'r' })).content[0]!.text).toBe('No browser to take over: pass cdp_url or set UNSTUCK_CDP_URL');
    expect((await call(START_TOOL, { reason: 'r', cdp_url: 'x:1', alerts: 'required' })).content[0]!.text).toMatch(/^alerts: 'required' needs Unstuck Cloud/);
    await server.close();
    const failing = await connect({ connect: (async () => Promise.reject(new Error('could not reach the browser'))) as never });
    const r = await failing.start();
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('could not reach the browser');
    await failing.server.close();
  });

  describe('phone alerts (Unstuck Cloud)', () => {
    it('alerted: true when a paired phone got it (and the text says so); alerted: false when none did', async () => {
      const ok = await connect({ alerter: async () => ({ delivered: 2 }) });
      const res = await ok.start();
      expect(res.structuredContent.alerted).toBe(true);
      expect(res.content[0]!.text).toMatch(/Their paired phones were alerted too/);
      await ok.server.close();
      const none = await connect({ alerter: async () => ({ delivered: 0, problem: 'no_devices' }) });
      const r2 = await none.start();
      expect(r2.structuredContent.alerted).toBe(false);
      expect(r2.content[0]!.text).not.toMatch(/alerted/);
      await none.server.close();
    });

    it('alerts: false sends none and leaves alerted out', async () => {
      const alerter = vi.fn(async () => ({ delivered: 1 }));
      const { server, start } = await connect({ alerter });
      expect((await start({ alerts: false })).structuredContent).not.toHaveProperty('alerted');
      expect(alerter).not.toHaveBeenCalled();
      await server.close();
    });

    it("alerts: 'required' with no phone reached: start returns failed/alert_failed", async () => {
      const { server, start } = await connect({ alerter: async () => ({ delivered: 0, problem: 'no_devices' }) });
      const res = await start({ alerts: 'required' });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ status: 'failed', detail: 'alert_failed' });
      await server.close();
    });

    it('a client giving up on start while the alert is pending ends the takeover (nobody will see that link)', async () => {
      const { server, transport, call } = await connect({ alerter: () => new Promise(() => {}) });
      const ac = new AbortController();
      const s = call(START_TOOL, { reason: 'r' }, { signal: ac.signal });
      s.catch(() => {});
      await vi.waitFor(() => expect(transport.published.size).toBe(1));
      ac.abort();
      await vi.waitFor(() => expect(transport.unpublished).toHaveLength(1));
      await server.close();
    });
  });

  it('a client giving up on start before the link exists closes the browser connection', async () => {
    let release!: () => void;
    const slow = fakeBrowser((cdp) => cdp.respond('Runtime.evaluate', () => new Promise((r) => (release = () => r({ result: { value: 'x.com' } })))));
    const { server, call, transport } = await connect({ connect: slow.connect as never });
    const ac = new AbortController();
    const s = call(START_TOOL, { reason: 'r' }, { signal: ac.signal });
    s.catch(() => {});
    await vi.waitFor(() => expect(slow.conns).toHaveLength(1));
    ac.abort();
    await vi.waitFor(() => expect(slow.conns[0]!.closed).not.toBeNull());
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.published.size).toBe(0);
    await server.close();
  });
});

describe('two-step MCP tools with a real browser and viewer', () => {
  const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<any> } };
  let chrome: DebugChromium;
  let humanBrowser: any;
  beforeAll(async () => {
    chrome = await startChromium();
    humanBrowser = await chromium.launch();
  }, 30_000);
  afterAll(async () => {
    await humanBrowser?.close();
    await chrome?.stop();
  });

  it('start → the human opens the link, taps Start and Done → wait returns resolved; cancel revokes a link', async () => {
    const transport = await createEmbeddedTransport({ assets: ASSETS as AssetMap });
    const server = createMcpServer({ transport, env: {}, stderr: { write: () => true } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    const call = (name: string, args: object) => client.callTool({ name, arguments: args as Record<string, unknown> }) as Promise<Res>;
    const cdp_url = `127.0.0.1:${chrome.port}`;

    const started = await call(START_TOOL, { reason: 'Solve the CAPTCHA', cdp_url, timeout_s: 60 });
    const { takeover_id, link } = started.structuredContent;
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\//);
    // A link of the local viewer server opens on this machine only: the message must not suggest forwarding it.
    expect(started.content[0]!.text).toMatch(/opens only on this computer/);
    expect(started.content[0]!.text).not.toMatch(/forward/);
    expect((await call(WAIT_TOOL, { takeover_id, max_wait_s: 1 })).structuredContent).toMatchObject({ status: 'waiting', joined: false });
    const human = await humanBrowser.newPage();
    await human.goto(link);
    await human.getByRole('button', { name: 'Start takeover' }).click();
    await human.getByRole('button', { name: 'Done' }).click();
    const done = await call(WAIT_TOOL, { takeover_id });
    expect(done.structuredContent).toMatchObject({ status: 'resolved', url: link });
    await human.close();

    const again = (await call(START_TOOL, { reason: 'Log in', cdp_url, timeout_s: 60 })).structuredContent;
    const page = again.link.split('#')[0];
    expect((await fetch(page)).status).toBe(200);
    expect((await call(CANCEL_TOOL, { takeover_id: again.takeover_id })).structuredContent).toMatchObject({ status: 'cancelled', detail: AGENT_CANCEL_DETAIL });
    expect((await fetch(page)).status).toBe(404);
    await server.close();
  }, 60_000);
});
