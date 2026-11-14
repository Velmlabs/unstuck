import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createEngine, createRelayTransport, type LinkInfo } from '@velmlabs/unstuck-core';
import { FakeCdp } from '@velmlabs/unstuck-core/testing';
import { createKeyAuthorizer, type RelayEvent } from '@velmlabs/unstuck-relay-core';
import { createNodeRelay } from '../src/server';
import { viewerFor, waitFor } from './helpers';

const viewerDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@velmlabs/unstuck-viewer/package.json')), 'dist');
const frame = { data: Buffer.alloc(30_000, 7).toString('base64'), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 720 } };
let stop: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stop.reverse()) await s().catch(() => {});
  stop = [];
});

async function relay(opts: { now?: () => number; sweepMs?: number; keys?: string[]; trustProxy?: boolean; authorize?: Parameters<typeof createNodeRelay>[0]['authorize'] } = {}) {
  const events: RelayEvent[] = [];
  const r = await createNodeRelay({
    port: 0,
    host: '127.0.0.1',
    viewerDir,
    authorize: opts.authorize ?? createKeyAuthorizer({ keys: opts.keys ?? ['K'] }),
    trustProxy: opts.trustProxy,
    onEvent: (e) => void events.push(e),
    now: opts.now,
    sweepMs: opts.sweepMs ?? 20,
  });
  stop.push(() => r.close());
  return { ...r, events, url: `ws://127.0.0.1:${r.port}`, http: `http://127.0.0.1:${r.port}` };
}

/** An engine with a fake browser, registered on the relay; resolves once the link exists. */
async function agent(url: string, key = 'K', WebSocketImpl?: typeof WebSocket) {
  const links: LinkInfo[] = [];
  const cdp = new FakeCdp();
  const engine = createEngine({ transport: createRelayTransport({ url, agentKey: key, WebSocketImpl }), onLink: (l) => links.push(l) });
  const result = engine.takeover(cdp, { reason: 'Solve it', timeoutS: 120 });
  stop.push(() => engine.close());
  let done = false;
  void result.then(() => (done = true));
  await waitFor(() => links.length > 0 || done);
  return { engine, cdp, result, link: links[0]!, links };
}

describe('HTTP', () => {
  it('healthz, viewer page only for live sessions, assets, and 404s', async () => {
    const r = await relay();
    expect(await (await fetch(`${r.http}/healthz`)).json()).toEqual({ ok: true });
    const missing = await fetch(`${r.http}/s/NOSUCHSESSION_0000000`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('expired or is invalid');
    expect((await fetch(`${r.http}/s/bad`)).status).toBe(404);
    const a = await agent(r.url);
    const page = await fetch(new URL(a.link.url).origin + new URL(a.link.url).pathname);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const asset = (await page.text()).match(/\/assets\/[^"]+\.js/)![0];
    const js = await fetch(r.http + asset);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${r.http}/assets/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${r.http}/other`)).status).toBe(404);
  });
});

describe('agent upgrades', () => {
  it('a wrong key fails the takeover with relay_unauthorized', async () => {
    const r = await relay();
    const engine = createEngine({ transport: createRelayTransport({ url: r.url, agentKey: 'WRONG' }) });
    stop.push(() => engine.close());
    await expect(engine.takeover(new FakeCdp(), { reason: 'x', timeoutS: 30 })).resolves.toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
  });

  it('the 21st agent upgrade in a minute with one key is rate limited (4429)', async () => {
    const r = await relay();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const ws = new WebSocket(`${r.url}/agent/SESSIONRATE_${String(i).padStart(10, '0')}`, ['unstuck-relay.1', 'key.K']);
      codes.push(await new Promise<number>((res) => {
        ws.onopen = () => ws.close(1000);
        ws.onclose = (e) => res(e.code);
      }));
    }
    expect(codes.slice(0, 20).every((c) => c !== 4429)).toBe(true);
    expect(codes[20]).toBe(4429);
  });

  it('a different key on a live session id is refused with 4409', async () => {
    const r = await relay({ keys: ['K', 'K2'] });
    const a = await agent(r.url);
    const ws = new WebSocket(`${r.url}/agent/${a.link.sessionId}`, ['unstuck-relay.1', 'key.K2']);
    const code = await new Promise<number>((res) => (ws.onclose = (e) => res(e.code)));
    expect(code).toBe(4409);
  });
});

/** The HTTP status a raw WebSocket upgrade request gets (101 when accepted). */
function upgradeStatus(url: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { ...extra, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', (res) => (res.resume(), resolve(res.statusCode!)));
    req.on('upgrade', (_res, sock) => (sock.destroy(), resolve(101)));
    req.on('error', reject);
    req.end();
  });
}

describe('viewer upgrades', () => {
  it('a viewer for an id with no agent gets 404; the 31st upgrade from one IP is refused', async () => {
    const r = await relay();
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`)).toBe(404);
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`));
    const refused = statuses.filter((x) => x === 429).length;
    expect(statuses[29]).toBe(429);
    expect(refused).toBeGreaterThanOrEqual(1);
  });
});

describe('full takeover through the Node relay', () => {
  it('resolves, reports events, and only ciphertext crosses the relay', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const v = await viewerFor(a.link.url);
    await v.send({ t: 'hello', token: v.token });
    await waitFor(() => v.json.some((m) => m.t === 'ready'));
    a.cdp.emit('Page.screencastFrame', frame);
    await waitFor(() => v.raw.some((b) => b.length > 4096));
    await v.send({ t: 'done' });
    await expect(a.result).resolves.toMatchObject({ status: 'resolved' });
    await waitFor(() => r.events.some((e) => e.name === 'session_closed'));
    expect(r.events.map((e) => e.name)).toEqual(expect.arrayContaining(['session_opened', 'viewer_connected', 'takeover_opened', 'session_closed']));
    for (const b of v.raw) {
      const s = Buffer.from(b);
      // The frame's plaintext (30 000 bytes of 0x07) must not appear: a run of 16 is ~2^-128 likely by chance.
      // (Checking for FF D8 anywhere was wrong: 30 KB of ciphertext contains it about a third of the time.)
      expect(s.includes(Buffer.alloc(16, 7))).toBe(false);
      expect(s.includes(Buffer.from('"ready"'))).toBe(false);
      expect(s.includes(Buffer.from(v.token))).toBe(false);
    }
    await waitFor(() => r.stats().sessions === 0);
  });

  it('Review Focus 1: the agent socket dropping mid-takeover recovers and still resolves', async () => {
    const r = await relay();
    const sockets: WebSocket[] = [];
    const Tracking = class extends WebSocket {
      constructor(u: string | URL, p?: string | string[]) {
        super(u, p);
        sockets.push(this);
      }
    } as typeof WebSocket;
    const a = await agent(r.url, 'K', Tracking);
    const v = await viewerFor(a.link.url);
    await v.send({ t: 'hello', token: v.token });
    await waitFor(() => v.json.some((m) => m.t === 'ready'));
    const resumeKey = v.json.find((m) => m.t === 'ready').resumeKey;
    sockets[0]!.close(1000); // the agent's connection drops
    await waitFor(() => v.closeCode() === 1012);
    await waitFor(() => sockets.length === 2 && sockets[1]!.readyState === 1, 8000);
    await new Promise((res) => setTimeout(res, 100));
    const back = await viewerFor(a.link.url);
    await back.send({ t: 'hello', token: back.token, resumeKey });
    await waitFor(() => back.json.some((m) => m.t === 'ready'));
    await back.send({ t: 'done' });
    await expect(a.result).resolves.toMatchObject({ status: 'resolved' });
  });

  it('Review Focus 4: an agent killed without end is cleaned up after the grace', async () => {
    let now = Date.now();
    const r = await relay({ now: () => now });
    const sockets: WebSocket[] = [];
    const NoRetry = class extends WebSocket {
      constructor(u: string | URL, p?: string | string[]) {
        super(u, p);
        sockets.push(this);
        if (sockets.length > 1) this.close(); // never comes back
      }
    } as typeof WebSocket;
    const a = await agent(r.url, 'K', NoRetry);
    const v = await viewerFor(a.link.url);
    expect(r.stats().sessions).toBe(1);
    sockets[0]!.close(1000);
    await waitFor(() => v.closeCode() !== null);
    now += 61_000;
    await waitFor(() => r.stats().sessions === 0);
    expect(r.events.filter((e) => e.name === 'session_closed')).toHaveLength(1);
  });

  it('close() shuts every socket with 1001 quickly', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const v = await viewerFor(a.link.url);
    const t = Date.now();
    await r.close();
    await waitFor(() => v.closeCode() !== null);
    expect(v.closeCode()).toBe(1001);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('edge cases', () => {
  it('behind a trusted proxy, viewer limits use X-Forwarded-For', async () => {
    const r = await relay({ trustProxy: true });
    for (let i = 0; i < 30; i++) await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' });
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '9.9.9.9' })).toBe(429);
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '8.8.8.8' })).toBe(404);
  });

  it('an authorizer that throws refuses the agent (relay_unauthorized)', async () => {
    const r = await relay({ authorize: async () => Promise.reject(new Error('db down')) });
    const engine = createEngine({ transport: createRelayTransport({ url: r.url, agentKey: 'K' }) });
    stop.push(() => engine.close());
    await expect(engine.takeover(new FakeCdp(), { reason: 'x', timeoutS: 30 })).resolves.toMatchObject({ detail: 'relay_unauthorized' });
  });

  it('a missing asset is 404', async () => {
    const r = await relay();
    expect((await fetch(`${r.http}/assets/nope.js`)).status).toBe(404);
  });

  it('a 5th viewer is closed with 1013; an oversize viewer message closes it with 1009', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const vs: Awaited<ReturnType<typeof viewerFor>>[] = [];
    for (let i = 0; i < 4; i++) vs.push(await viewerFor(a.link.url));
    const fifth = await viewerFor(a.link.url);
    await waitFor(() => fifth.closeCode() !== null);
    expect(fifth.closeCode()).toBe(1013);
    vs[0]!.sock.send(new Uint8Array(70_000));
    await waitFor(() => vs[0]!.closeCode() !== null);
    expect(vs[0]!.closeCode()).toBe(1009);
  });

  it('an ended session id can be registered again', async () => {
    const r = await relay();
    const a = await agent(r.url);
    await a.engine.close();
    await waitFor(() => r.stats().sessions === 0);
    const ws = new WebSocket(`${r.url}/agent/${a.link.sessionId}`, ['unstuck-relay.1', 'key.K']);
    const got = await new Promise<string>((res) => {
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', expiresAt: Date.now() + 60_000, secret: 'S' }));
      ws.onmessage = (e) => res(String(e.data));
    });
    expect(JSON.parse(got)).toEqual({ t: 'registered' });
    ws.close();
  });

  it('bad upgrade paths and ids are 404', async () => {
    const r = await relay();
    expect(await upgradeStatus(`${r.http}/nope/SESSIONX_000000000000`)).toBe(404);
    expect(await upgradeStatus(`${r.http}/ws/bad`)).toBe(404);
    expect(await upgradeStatus(`${r.http}/agent/bad`)).toBe(404);
  });

  it('an agent offering no key or subprotocol is refused with 4401', async () => {
    const r = await relay();
    const ws = new WebSocket(`${r.url}/agent/SESSIONNOKEY_000000000`);
    expect(await new Promise<number>((res) => (ws.onclose = (e) => res(e.code)))).toBe(4401);
  });

  it('housekeeping removes an agent that never says hello', async () => {
    let now = Date.now();
    const r = await relay({ now: () => now });
    const ws = new WebSocket(`${r.url}/agent/SESSIONSILENT_00000000`, ['unstuck-relay.1', 'key.K']);
    await new Promise((res) => (ws.onopen = res));
    await waitFor(() => r.stats().sessions === 1);
    now += 31_000;
    await waitFor(() => r.stats().sessions === 0);
    ws.close();
  });

  it('Final #1: a malformed asset path is a 404, not a crash', async () => {
    const r = await relay();
    expect((await fetch(`${r.http}/assets/%E0`)).status).toBe(404);
    expect((await fetch(`${r.http}/healthz`)).status).toBe(200);
  });

  it('Final #2: an oversize viewer frame closes that viewer without crashing the relay', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const raw = new (await import('ws')).WebSocket(`${r.url.replace('ws:', 'ws:')}/ws/${a.link.sessionId}`);
    await new Promise((res) => raw.once('open', res));
    raw.send(Buffer.alloc(3 * 1024 * 1024)); // beyond the server's maxPayload
    await new Promise((res) => raw.once('close', res));
    expect((await fetch(`${r.http}/healthz`)).status).toBe(200);
  });

  it('Final #5: each session has its own timer: expiry is enforced on time, not at the next sweep', async () => {
    const r = await relay({ sweepMs: 60_000 });
    const ws = new WebSocket(`${r.url}/agent/SESSIONEXPIRES_0000000`, ['unstuck-relay.1', 'key.K']);
    const closed = new Promise<number>((res) => (ws.onclose = (e) => res(e.code)));
    await new Promise((res) => (ws.onopen = res));
    ws.send(JSON.stringify({ t: 'hello', expiresAt: Date.now() + 300, secret: 'S' }));
    await waitFor(() => r.stats().sessions === 1);
    await waitFor(() => r.stats().sessions === 0, 2000);
    expect(await closed).toBe(1000);
    expect(r.events.filter((e) => e.name === 'session_closed')).toHaveLength(1);
  });
});

