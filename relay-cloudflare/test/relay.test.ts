import { describe, it, expect, beforeEach } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createEngine, createRelayTransport, type LinkInfo } from '@unstuck/core';
import { FakeCdp } from '@unstuck/core/testing';
import { probe } from './fixtures/worker';
import { FetchWs, viewerFor, waitFor } from './helpers';

const BASE = 'https://relay.test';
const frame = { data: btoa(String.fromCharCode(...new Uint8Array(30_000).fill(7))), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 720 } };
const get = (path: string) => exports.default.fetch(new Request(BASE + path));
const stub = (id: string) => env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(id));

async function agent(key = 'K') {
  const links: LinkInfo[] = [];
  const cdp = new FakeCdp();
  const engine = createEngine({
    transport: createRelayTransport({ url: 'wss://relay.test', agentKey: key, WebSocketImpl: FetchWs as never }),
    onLink: (l) => links.push(l),
  });
  const result = engine.takeover(cdp, { reason: 'Solve it', timeoutS: 120 });
  let done = false;
  void result.then(() => (done = true));
  await waitFor(() => links.length > 0 || done);
  return { engine, cdp, result, link: links[0]!, id: links[0]?.sessionId ?? '' };
}

beforeEach(() => {
  probe.events = [];
  probe.offset = 0;
  probe.refuse = null;
  FetchWs.all = [];
});

describe('worker routes', () => {
  it('healthz; the viewer page is 404 until an agent registers, then served with strict headers', async () => {
    expect(await (await get('/healthz')).json()).toEqual({ ok: true });
    expect((await get('/s/NOSUCHSESSION_0000000')).status).toBe(404);
    expect((await get('/s/bad')).status).toBe(404);
    const a = await agent();
    const page = await get(`/s/${a.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const asset = (await page.text()).match(/\/assets\/[^"]+\.js/)![0];
    expect((await get(asset)).status).toBe(200);
    expect((await get('/elsewhere')).status).toBe(404);
    await a.engine.close();
  });

  it('echoes only unstuck-relay.1, never the key', async () => {
    const ws = new FetchWs('wss://relay.test/agent/SESSIONPROTO_00000000', ['unstuck-relay.1', 'key.K']);
    await waitFor(() => ws.readyState !== 0);
    expect(ws.protocol).toBe('unstuck-relay.1');
    ws.close();
  });

  it('viewer upgrades echo no subprotocol (browsers reject one they did not offer)', async () => {
    const a = await agent();
    const res = await exports.default.fetch(new Request(`${BASE}/ws/${a.id}`, { headers: { Upgrade: 'websocket' } }));
    expect(res.status).toBe(101);
    expect(res.headers.get('sec-websocket-protocol')).toBeNull();
    res.webSocket!.accept();
    res.webSocket!.close();
    await a.engine.close();
  });

  it('a non-upgrade request to a socket path is 426; bad ids are 404', async () => {
    expect((await get('/agent/SESSIONPLAIN_00000000')).status).toBe(426);
    expect((await get('/ws/bad')).status).toBe(404);
  });
});

describe('agent refusals become close codes', () => {
  it('a bad key fails the in-process takeover with relay_unauthorized', async () => {
    const engine = createEngine({ transport: createRelayTransport({ url: 'wss://relay.test', agentKey: 'BAD', WebSocketImpl: FetchWs as never }) });
    await expect(engine.takeover(new FakeCdp(), { reason: 'x', timeoutS: 30 })).resolves.toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
  });

  it('a custom authorize returning 402 closes with 4402 (relay_quota_exceeded)', async () => {
    probe.refuse = 402;
    const engine = createEngine({ transport: createRelayTransport({ url: 'wss://relay.test', agentKey: 'K', WebSocketImpl: FetchWs as never }) });
    await expect(engine.takeover(new FakeCdp(), { reason: 'x', timeoutS: 30 })).resolves.toMatchObject({ detail: 'relay_quota_exceeded' });
  });

  it('a different key on a live session id is refused with 4409', async () => {
    const a = await agent('K');
    const ws = new FetchWs(`wss://relay.test/agent/${a.id}`, ['unstuck-relay.1', 'key.K2']);
    let code = 0;
    ws.onclose = (e) => (code = e.code);
    await waitFor(() => code !== 0);
    expect(code).toBe(4409);
    await a.engine.close();
  });

  it('the agent rate limit closes with 4429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const ws = new FetchWs(`wss://relay.test/agent/SESSIONRATE_${String(i).padStart(10, '0')}`, ['unstuck-relay.1', 'key.K2']);
      let code = 0;
      ws.onclose = (e) => (code = e.code); // set before the upgrade completes: refusals close immediately
      await waitFor(() => ws.readyState !== 0);
      await new Promise((r) => setTimeout(r, 5));
      codes.push(code);
      ws.close();
    }
    expect(codes).toContain(4429);
  });
});

describe('takeover through a Durable Object', () => {
  it('resolves end to end; events fire; only ciphertext crosses; storage is emptied at the end', async () => {
    const a = await agent();
    const v = await viewerFor(a.link.url);
    await v.send({ t: 'hello', token: v.token });
    await waitFor(() => v.json.some((m) => m.t === 'ready'));
    a.cdp.emit('Page.screencastFrame', frame);
    await waitFor(() => v.raw.some((b) => b.length > 4096));
    await v.send({ t: 'done' });
    await expect(a.result).resolves.toMatchObject({ status: 'resolved' });
    await waitFor(() => probe.events.some((e) => e.name === 'session_closed'));
    const names = probe.events.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['session_opened', 'viewer_connected', 'takeover_opened', 'session_closed']));
    expect(names.filter((n) => n === 'takeover_opened')).toHaveLength(1);
    expect(probe.events[0]).toMatchObject({ account: 'acct:K' });
    for (const b of v.raw) expect(b[0]).not.toBe(0x7b);
    const left = await runInDurableObject(stub(a.id), async (_i, state) => ({ keys: (await state.storage.list()).size, alarm: await state.storage.getAlarm() }));
    expect(left).toEqual({ keys: 0, alarm: null });
    await a.engine.close();
  });

  it('keeps forwarding after the Durable Object is evicted (hibernation)', async () => {
    const a = await agent();
    const v = await viewerFor(a.link.url);
    await evictDurableObject(stub(a.id));
    // Hibernation drops the object's memory but keeps its sockets: the session must rebuild from storage.
    await runInDurableObject(stub(a.id), async (inst: any) => void (inst.session = null));
    await v.send({ t: 'hello', token: v.token });
    await waitFor(() => v.json.some((m) => m.t === 'ready'));
    await v.send({ t: 'done' });
    await expect(a.result).resolves.toMatchObject({ status: 'resolved' });
  });

  it('an agent socket that has not said hello yet survives a rebuild as a candidate', async () => {
    const id = 'SESSIONCANDIDATE_00000';
    const first = new FetchWs(`wss://relay.test/agent/${id}`, ['unstuck-relay.1', 'key.K']);
    await waitFor(() => first.readyState === 1);
    await runInDurableObject(stub(id), async (inst: any) => void (inst.session = null));
    const got: string[] = [];
    first.onmessage = (e) => got.push(String(e.data));
    first.send(JSON.stringify({ t: 'hello', expiresAt: Date.now() + 60_000, secret: 'S' }));
    await waitFor(() => got.length > 0);
    expect(JSON.parse(got[0]!)).toEqual({ t: 'registered' });
    first.close();
  });

  it('a 5th viewer is closed with 1013', async () => {
    const a = await agent();
    for (let i = 0; i < 4; i++) await viewerFor(a.link.url);
    const fifth = await viewerFor(a.link.url);
    await waitFor(() => fifth.closeCode() !== null);
    expect(fifth.closeCode()).toBe(1013);
    await a.engine.close();
  });

  it('Review Focus 4: an agent that vanishes without end is cleaned up by the alarm after the grace', async () => {
    const a = await agent();
    const v = await viewerFor(a.link.url);
    const agentWs = FetchWs.all[0]!;
    agentWs.onclose = null; // the engine never hears about it, so it won't reconnect
    agentWs.close(1001);
    await waitFor(() => v.closeCode() !== null);
    expect(v.closeCode()).toBe(1012);
    probe.offset = 61_000;
    expect(await runDurableObjectAlarm(stub(a.id))).toBe(true);
    await waitFor(() => probe.events.some((e) => e.name === 'session_closed'));
    const left = await runInDurableObject(stub(a.id), async (_i, state) => ({ keys: (await state.storage.list()).size, alarm: await state.storage.getAlarm() }));
    expect(left).toEqual({ keys: 0, alarm: null });
    expect((await get(`/s/${a.id}`)).status).toBe(404);
    await a.engine.close();
  });

  it('a viewer for an id with no agent gets 404', async () => {
    const v = new FetchWs('wss://relay.test/ws/NOSUCHSESSION_0000000');
    await waitFor(() => v.readyState !== 0);
    expect(v.status).toBe(404);
  });
});

describe('default authorizer and fallbacks', () => {
  const closeCodeOf = async (res: Response) => {
    const ws = res.webSocket!;
    ws.accept();
    return new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
  };
  const agentReq = (id: string, key?: string) =>
    new Request(`${BASE}/agent/${id}`, { headers: { Upgrade: 'websocket', ...(key ? { 'Sec-WebSocket-Protocol': `unstuck-relay.1, key.${key}` } : {}) } });

  it('AGENT_KEYS: an unknown key is refused with 4401', async () => {
    const { createRelayWorker } = await import('../src/worker');
    const relay = createRelayWorker();
    const res = await relay.fetch(agentReq('SESSIONDEFAULT_0000000', 'nope'), { ...env, AGENT_KEYS: 'a, b', AGENT_LIMIT: undefined });
    expect(await closeCodeOf(res)).toBe(4401);
  });

  it('RELAY_OPEN=1 lets any agent register', async () => {
    const { createRelayWorker } = await import('../src/worker');
    const res = await createRelayWorker().fetch(agentReq('SESSIONOPENMODE_000000'), { ...env, RELAY_OPEN: '1', AGENT_LIMIT: undefined });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const got = new Promise<string>((r) => ws.addEventListener('message', (e) => r(String(e.data))));
    ws.send(JSON.stringify({ t: 'hello', expiresAt: Date.now() + 60_000, secret: 'S' }));
    expect(JSON.parse(await got)).toEqual({ t: 'registered' });
    ws.close();
  });

  it('an authorizer that throws refuses with 4403', async () => {
    const { createRelayWorker } = await import('../src/worker');
    const relay = createRelayWorker({ authorize: async () => Promise.reject(new Error('db down')) });
    const res = await relay.fetch(agentReq('SESSIONTHROWS_00000000', 'K'), { ...env, AGENT_LIMIT: undefined });
    expect(await closeCodeOf(res)).toBe(4403);
  });

  it('the viewer rate limit answers 429', async () => {
    let refused = 0;
    for (let i = 0; i < 31; i++) {
      const res = await exports.default.fetch(new Request(`${BASE}/ws/NOSUCHSESSION_0000000`, { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '7.7.7.7' } }));
      if (res.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('an alarm or socket error with no stored session is harmless', async () => {
    const s = stub('SESSIONEMPTY_000000000');
    await runInDurableObject(s, async (inst: any, state) => {
      await inst.alarm();
      await inst.webSocketError({ deserializeAttachment: () => null });
      expect((await state.storage.list()).size).toBe(0);
    });
  });
});
