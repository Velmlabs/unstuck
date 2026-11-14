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

type RelayOpts = Parameters<typeof createNodeRelay>[0];
async function relay(opts: { now?: () => number; sweepMs?: number; keys?: string[]; trustProxy?: RelayOpts['trustProxy']; hsts?: boolean; authorize?: RelayOpts['authorize'] } = {}) {
  const events: RelayEvent[] = [];
  const r = await createNodeRelay({
    port: 0,
    host: '127.0.0.1',
    viewerDir,
    authorize: opts.authorize ?? createKeyAuthorizer({ keys: opts.keys ?? ['K'] }),
    trustProxy: opts.trustProxy,
    hsts: opts.hsts,
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
    expect(page.headers.get('access-control-allow-origin')).toBe('*');
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');
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
  it('behind a trusted proxy, viewer limits use the X-Forwarded-For entry the proxy appended (the rightmost)', async () => {
    const r = await relay({ trustProxy: true });
    for (let i = 0; i < 30; i++) await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '10.0.0.1, 9.9.9.9' });
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '9.9.9.9' })).toBe(429);
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '8.8.8.8' })).toBe(404);
  });

  it('security finding 1: a client-chosen leftmost X-Forwarded-For entry does not escape the viewer limit', async () => {
    const r = await relay({ trustProxy: true });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': `1.2.3.${i}, 9.9.9.9` }));
    expect(statuses[30]).toBe(429);
  });

  it('IPv6 clients are limited by /64: rotating addresses within one /64 does not escape the viewer limit', async () => {
    const r = await relay({ trustProxy: true });
    for (let i = 0; i < 30; i++) await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': `2001:db8:1:2::${(i + 1).toString(16)}` });
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '2001:db8:1:2:ffff::1' })).toBe(429);
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '2001:db8:1:3::1' })).toBe(404); // another /64
  });

  it('security finding 1: trustProxy 0 ignores X-Forwarded-For', async () => {
    const r = await relay({ trustProxy: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': `1.2.3.${i}` }));
    expect(statuses[30]).toBe(429);
  });

  it('security finding 1: with trustProxy = 2 the client is the second entry from the right', async () => {
    const r = await relay({ trustProxy: 2 });
    for (let i = 0; i < 30; i++) await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': `1.2.3.${i}, 9.9.9.9, 10.0.0.1` });
    expect(await upgradeStatus(`${r.http}/ws/NOSUCHSESSION_0000000`, { 'x-forwarded-for': '9.9.9.9, 10.0.0.2' })).toBe(429);
    // Fewer entries than trusted hops: the leftmost one is used.
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

  it('a 5th viewer evicts the oldest unconfirmed one with 1013; an oversize viewer message closes it with 1009', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const vs: Awaited<ReturnType<typeof viewerFor>>[] = [];
    for (let i = 0; i < 4; i++) vs.push(await viewerFor(a.link.url));
    const fifth = await viewerFor(a.link.url);
    await waitFor(() => vs.some((v) => v.closeCode() === 1013));
    expect(fifth.closeCode()).toBeNull();
    fifth.sock.send(new Uint8Array(70_000));
    await waitFor(() => fifth.closeCode() !== null);
    expect(fifth.closeCode()).toBe(1009);
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


describe('robustness', () => {
  it('a request whose target cannot be parsed gets a 500, and the relay keeps serving', async () => {
    const r = await relay();
    const net = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const sock = net.connect(r.port, '127.0.0.1', () => sock.write('GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let out = '';
      sock.on('data', (d) => (out += d));
      sock.on('end', () => resolve(out));
      sock.on('error', () => resolve(out));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 (500|400)/);
    expect((await fetch(`${r.http}/healthz`)).status).toBe(200);
  });

  it('an agent offering a key but not the relay protocol is not upgraded', async () => {
    const r = await relay();
    const ws = new WebSocket(`${r.url}/agent/ABCDEFGHIJKLMNOPQRSTUV`, ['key.K']);
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve(`open:${ws.protocol}`);
      ws.onerror = () => resolve('error');
      ws.onclose = (e) => resolve(`close:${e.code}`);
    });
    expect(outcome).not.toBe('open:unstuck-relay.1');
    ws.close();
  });
});

describe('security fixes', () => {
  it('finding 2: viewers that never said hello cannot keep a human out', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const squatters: Awaited<ReturnType<typeof viewerFor>>[] = [];
    for (let i = 0; i < 4; i++) squatters.push(await viewerFor(a.link.url));
    const human = await viewerFor(a.link.url);
    await human.send({ t: 'hello', token: human.token });
    await waitFor(() => human.json.some((m) => m.t === 'ready'));
    expect(human.closeCode()).toBeNull();
    await waitFor(() => squatters.filter((v) => v.closeCode() === 1013).length >= 1);
  });

  it('finding 3: viewer sockets accept at most viewerPayloadMax bytes per message (1009 from ws, before buffering 2 MB)', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const { WebSocket: Ws } = await import('ws');
    const raw = new Ws(`${r.url}/ws/${a.link.sessionId}`);
    await new Promise((res) => raw.once('open', res));
    const code = new Promise<number>((res) => raw.once('close', (c: number) => res(c)));
    raw.send(Buffer.alloc(65_537));
    expect(await code).toBe(1009);
    expect((await fetch(`${r.http}/healthz`)).status).toBe(200);
  });

  it('finding 4: failed agent authorizations are limited per IP, whatever key is presented', async () => {
    const r = await relay();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const ws = new WebSocket(`${r.url}/agent/SESSIONBRUTE_${String(i).padStart(10, '0')}`, ['unstuck-relay.1', `key.guess${i}`]);
      codes.push(await new Promise<number>((res) => (ws.onclose = (e) => res(e.code))));
    }
    expect(codes.slice(0, 10).every((c) => c === 4401)).toBe(true);
    expect(codes[10]).toBe(4429);
    // Even the right key is refused from that IP until the window passes: no oracle.
    const ok = new WebSocket(`${r.url}/agent/SESSIONBRUTE_OK00000000`, ['unstuck-relay.1', 'key.K']);
    expect(await new Promise<number>((res) => (ok.onclose = (e) => res(e.code)))).toBe(4429);
  });

  it('finding 4: successful agent upgrades do not count toward the per-IP failure limit', async () => {
    const r = await relay({ keys: Array.from({ length: 12 }, (_, i) => `K${i}`) });
    for (let i = 0; i < 12; i++) {
      const ws = new WebSocket(`${r.url}/agent/SESSIONGOOD_${String(i).padStart(10, '0')}`, ['unstuck-relay.1', `key.K${i}`]);
      await new Promise((res) => (ws.onopen = res));
      ws.close();
    }
  });

  it('finding 9: a refusal error longer than a close reason allows still closes with the refusal code', async () => {
    const r = await relay({ authorize: async () => ({ ok: false, status: 402, error: 'quota exceeded: '.repeat(20) }) });
    const ws = new WebSocket(`${r.url}/agent/SESSIONLONGERR_0000000`, ['unstuck-relay.1', 'key.K']);
    const e = await new Promise<CloseEvent>((res) => (ws.onclose = res));
    expect(e.code).toBe(4402);
    expect(JSON.parse(e.reason).error).toMatch(/^quota exceeded/);
  });

  it('finding 9: page CSPs forbid <base> and form posts; HSTS only when asked for', async () => {
    const r = await relay();
    const a = await agent(r.url);
    const u = new URL(a.link.url);
    for (const p of [u.pathname, '/s/NOSUCHSESSION_0000000']) {
      const res = await fetch(r.http + p);
      expect(res.headers.get('content-security-policy')).toContain("base-uri 'none'");
      expect(res.headers.get('content-security-policy')).toContain("form-action 'none'");
      expect(res.headers.get('strict-transport-security')).toBeNull();
    }
    const tls = await relay({ hsts: true });
    for (const p of ['/healthz', '/s/NOSUCHSESSION_0000000', '/nope']) {
      expect((await fetch(tls.http + p)).headers.get('strict-transport-security')).toBe('max-age=31536000');
    }
  });
});
