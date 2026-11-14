import { describe, it, expect, beforeEach } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createEngine, createRelayTransport, type LinkInfo } from '@velmlabs/unstuck-core';
import { FakeCdp } from '@velmlabs/unstuck-core/testing';
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
    // A viewer on its own origin asks whether the session still exists: readable cross-origin, live or not.
    expect(page.headers.get('access-control-allow-origin')).toBe('*');
    expect((await get('/s/NOSUCHSESSION_0000000')).headers.get('access-control-allow-origin')).toBe('*');
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
      // Accepted (open) or refused (closed with a code): wait for one of the two, not a fixed time.
      await waitFor(() => ws.readyState === 1 || code !== 0);
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

  it('Final #6: frames do not cause storage writes; billing state does, and the alarm flushes counters', async () => {
    const a = await agent();
    const v = await viewerFor(a.link.url);
    await v.send({ t: 'hello', token: v.token });
    await waitFor(() => v.json.some((m) => m.t === 'ready'));
    for (let i = 0; i < 5; i++) a.cdp.emit('Page.screencastFrame', frame);
    await waitFor(() => v.raw.filter((b) => b.length > 4096).length >= 2);
    const rec = await runInDurableObject(stub(a.id), async (_i, state) => (await state.storage.get<any>('rec'))!);
    const received = v.raw.reduce((n, b) => n + b.length, 0);
    expect(rec.billed).toBe(true);
    // Stored counters lag behind: only the write that recorded billing happened, not one per frame.
    expect(rec.bytesToViewers).toBeLessThan(received);
    await runDurableObjectAlarm(stub(a.id));
    const after = await runInDurableObject(stub(a.id), async (_i, state) => (await state.storage.get<any>('rec'))!);
    expect(after.bytesToViewers).toBeGreaterThanOrEqual(received); // the alarm flushes them (more frames may have arrived)
    await a.engine.close();
  });

  it('Final #7: after an agent reconnect only one socket is marked as the live agent', async () => {
    const id = 'SESSIONREPLACE_0000000';
    const helloMsg = JSON.stringify({ t: 'hello', expiresAt: Date.now() + 60_000, secret: 'SAME' });
    const registered = (ws: FetchWs) => {
      const got: string[] = [];
      ws.onmessage = (e) => got.push(String(e.data));
      return () => got.includes('{"t":"registered"}');
    };
    const first = new FetchWs(`wss://relay.test/agent/${id}`, ['unstuck-relay.1', 'key.K']);
    await waitFor(() => first.readyState === 1);
    const firstOk = registered(first);
    first.send(helloMsg);
    await waitFor(firstOk);
    const second = new FetchWs(`wss://relay.test/agent/${id}`, ['unstuck-relay.1', 'key.K']);
    await waitFor(() => second.readyState === 1);
    const secondOk = registered(second);
    second.send(helloMsg);
    await waitFor(secondOk);
    const actives = await runInDurableObject(stub(id), async (_i, state) =>
      state.getWebSockets().filter((ws) => (ws.deserializeAttachment() as { active?: boolean } | null)?.active === true).length,
    );
    expect(actives).toBe(1);
    second.close();
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

  it('a 5th viewer evicts the oldest unconfirmed one with 1013', async () => {
    const a = await agent();
    const vs = [];
    for (let i = 0; i < 4; i++) vs.push(await viewerFor(a.link.url));
    const fifth = await viewerFor(a.link.url);
    await waitFor(() => vs[0]!.closeCode() !== null);
    expect(vs[0]!.closeCode()).toBe(1013);
    expect(fifth.closeCode()).toBeNull();
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

describe('security fixes', () => {
  const agentReq = (id: string, key: string, ip = '5.5.5.5') =>
    new Request(`${BASE}/agent/${id}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `unstuck-relay.1, key.${key}`, 'cf-connecting-ip': ip } });
  const closeCodeOf = async (res: Response) => {
    const ws = res.webSocket!;
    ws.accept();
    return new Promise<{ code: number; reason: string }>((r) => ws.addEventListener('close', (e) => r({ code: e.code, reason: e.reason })));
  };
  const storageOf = (id: string) =>
    runInDurableObject(stub(id), async (_i, state) => ({ keys: (await state.storage.list()).size, alarm: await state.storage.getAlarm() }));

  it('finding 2: four silent viewers cannot keep a human out; the oldest is evicted with 1013', async () => {
    const a = await agent();
    const squatters = [];
    for (let i = 0; i < 4; i++) {
      const res = await exports.default.fetch(new Request(`${BASE}/ws/${a.id}`, { headers: { Upgrade: 'websocket', 'cf-connecting-ip': `6.6.6.${i}` } }));
      const ws = res.webSocket!;
      ws.accept();
      const sq = { code: 0 };
      ws.addEventListener('close', (e) => (sq.code = e.code));
      squatters.push(sq);
    }
    const human = await viewerFor(a.link.url);
    await human.send({ t: 'hello', token: human.token });
    await waitFor(() => human.json.some((m) => m.t === 'ready'));
    await waitFor(() => squatters[0]!.code === 1013);
    expect(human.closeCode()).toBeNull();
    // The human's socket is marked confirmed in its hibernation attachment, so a rebuild can't make it evictable.
    const confirmed = await runInDurableObject(stub(a.id), async (_i, state) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as { role: string; confirmed?: boolean } | null).filter((x) => x?.role === 'viewer' && x.confirmed).length,
    );
    expect(confirmed).toBe(1);
    await runInDurableObject(stub(a.id), async (inst: any) => void (inst.session = null));
    for (let i = 0; i < 4; i++) await exports.default.fetch(new Request(`${BASE}/ws/${a.id}`, { headers: { Upgrade: 'websocket', 'cf-connecting-ip': `7.7.7.${i}` } })).then((r) => r.webSocket!.accept());
    await new Promise((r) => setTimeout(r, 50));
    expect(human.closeCode()).toBeNull();
    await a.engine.close();
  });

  it('finding 2: a viewer attached before attachments carried confirmed state counts as confirmed after a rebuild', async () => {
    const a = await agent();
    const old = await viewerFor(a.link.url);
    await runInDurableObject(stub(a.id), async (inst: any, state) => {
      for (const ws of state.getWebSockets()) {
        const at = ws.deserializeAttachment() as { role: string; c: number };
        if (at.role === 'viewer') ws.serializeAttachment({ role: 'viewer', c: at.c });
      }
      inst.session = null;
    });
    for (let i = 0; i < 4; i++) await viewerFor(a.link.url);
    await new Promise((r) => setTimeout(r, 50));
    expect(old.closeCode()).toBeNull();
    await a.engine.close();
  });

  it('finding 4: agent upgrades are limited per IP, whatever key is presented', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await exports.default.fetch(agentReq(`SESSIONBRUTE_${String(i).padStart(10, '0')}`, `guess${i}`, '4.4.4.4'));
      codes.push((await closeCodeOf(res)).code);
    }
    expect(codes.slice(0, 20).every((c) => c === 4401)).toBe(true);
    expect(codes).toContain(4429);
  });

  it('finding 6: a session that never registers is gone 30 s after its agent connected', async () => {
    const id = 'SESSIONNOHELLO_0000000';
    const ws = new FetchWs(`wss://relay.test/agent/${id}`, ['unstuck-relay.1', 'key.K']);
    await waitFor(() => ws.readyState === 1);
    ws.close(); // and never comes back
    await new Promise((r) => setTimeout(r, 50));
    const alarm = await runInDurableObject(stub(id), async (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(30_000);
    probe.offset = 31_000;
    await runDurableObjectAlarm(stub(id));
    expect(await storageOf(id)).toEqual({ keys: 0, alarm: null });
  });

  it('finding 6: any request that finds a record past expiresAt + 60 s cleans it up first (backstop)', async () => {
    const a = await agent();
    await runInDurableObject(stub(a.id), async (inst: any, state) => {
      const rec = await state.storage.get<any>('rec');
      await state.storage.put('rec', { ...rec, expiresAt: Date.now() - 61_000 });
      await state.storage.deleteAlarm(); // the alarm was lost
      inst.session = null;
    });
    expect((await get(`/s/${a.id}`)).status).toBe(404);
    expect(await storageOf(a.id)).toEqual({ keys: 0, alarm: null });
    expect(probe.events.filter((e) => e.name === 'session_closed')).toHaveLength(1);
    await a.engine.close();
  });

  it('finding 7: after an agent reconnect and a rebuild, the replaced socket is never rebound as the agent', async () => {
    const id = 'SESSIONREBIND_00000000';
    const helloMsg = JSON.stringify({ t: 'hello', expiresAt: Date.now() + 60_000, secret: 'SAME' });
    const connect = async () => {
      const ws = new FetchWs(`wss://relay.test/agent/${id}`, ['unstuck-relay.1', 'key.K']);
      await waitFor(() => ws.readyState === 1);
      const got: string[] = [];
      ws.onmessage = (e) => got.push(String(e.data));
      ws.send(helloMsg);
      await waitFor(() => got.includes('{"t":"registered"}'));
      return { ws, got };
    };
    const first = await connect();
    first.ws.onclose = null;
    const second = await connect();
    const tags = await runInDurableObject(stub(id), async (inst: any, state) => {
      inst.session = null; // hibernation
      return state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { active?: boolean }).active);
    });
    expect(tags.filter((t) => t === true)).toHaveLength(1);
    const v = new FetchWs(`wss://relay.test/ws/${id}`);
    await waitFor(() => v.readyState === 1);
    await waitFor(() => second.got.some((m) => m.includes('"open"')));
    expect(first.got.some((m) => m.includes('"open"'))).toBe(false);
    second.ws.close();
  });

  it('finding 9: assets get nosniff; pages forbid <base> and form posts; every response has HSTS', async () => {
    const a = await agent();
    const page = await get(`/s/${a.id}`);
    for (const p of [page, await get('/s/NOSUCHSESSION_0000000')]) {
      expect(p.headers.get('content-security-policy')).toContain("base-uri 'none'");
      expect(p.headers.get('content-security-policy')).toContain("form-action 'none'");
    }
    const asset = await get((await page.text()).match(/\/assets\/[^"]+\.js/)![0]);
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    for (const r of [page, asset, await get('/healthz'), await get('/nope'), await get('/agent/SESSIONPLAIN_00000000')]) {
      expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000');
    }
    const up = await exports.default.fetch(new Request(`${BASE}/ws/${a.id}`, { headers: { Upgrade: 'websocket' } }));
    expect(up.status).toBe(101);
    up.webSocket!.accept();
    up.webSocket!.close();
    await a.engine.close();
  });

  it('finding 9: a refusal error longer than a close reason allows still closes with the refusal code', async () => {
    const { createRelayWorker } = await import('../src/worker');
    const relay = createRelayWorker({ authorize: async () => ({ ok: false, status: 402, error: 'quota exceeded: '.repeat(20) }) });
    const res = await relay.fetch(agentReq('SESSIONLONGERR_0000000', 'K'), { ...env, AGENT_LIMIT: undefined, AGENT_IP_LIMIT: undefined } as never);
    const { code, reason } = await closeCodeOf(res);
    expect(code).toBe(4402);
    expect(JSON.parse(reason).error).toMatch(/^quota exceeded/);
  });
});
