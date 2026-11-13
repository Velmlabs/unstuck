import { describe, it, expect, beforeEach } from 'vitest';
import { encodeEnvelope, decodeEnvelope, RELAY_LIMITS } from '@unstuck/protocol';
import { RelaySession, newRecord } from '../src/session';
import type { RelayEvent } from '../src/hooks';
import { FakeSocket } from './helpers';

let now = 1_000_000;
let events: RelayEvent[];
const hello = (secret = 'SECRET', expiresAt = now + 600_000) => JSON.stringify({ t: 'hello', expiresAt, secret });

async function registered() {
  const s = new RelaySession(newRecord('SID_0123456789abcdef', 'acct', 'KEYHASH', now), (e) => void events.push(e), () => now);
  const agent = new FakeSocket();
  s.attachAgent(agent);
  s.agentMessage(agent, hello());
  await s.flush();
  return { s, agent };
}
const names = () => events.map((e) => e.name);

beforeEach(() => {
  now = 1_000_000;
  events = [];
});

describe('registration', () => {
  it('hello registers once, caps expiry at 1 h, and fires session_opened', async () => {
    const { s, agent } = await registered();
    expect(names()).toEqual(['session_opened']);
    s.agentMessage(agent, hello('SECRET', now + 10 * 3_600_000));
    await s.flush();
    expect(names()).toEqual(['session_opened']);
    const s2 = new RelaySession(newRecord('SID_0123456789abcdeX', 'a', 'K', now), () => {}, () => now);
    const a2 = new FakeSocket();
    s2.attachAgent(a2);
    s2.agentMessage(a2, hello('X', now + 10 * 3_600_000));
    await s2.flush();
    expect(s2.record.expiresAt).toBe(now + RELAY_LIMITS.maxExpiryMs);
  });

  it('text before hello that is not hello closes the agent with 1003', async () => {
    const s = new RelaySession(newRecord('SID_0123456789abcdef', 'a', 'K', now), () => {}, () => now);
    const agent = new FakeSocket();
    s.attachAgent(agent);
    s.agentMessage(agent, '{"t":"pong"}');
    await s.flush();
    expect(agent.closed?.code).toBe(1003);
  });

  it('no viewer can attach before the agent registers', () => {
    const s = new RelaySession(newRecord('SID_0123456789abcdef', 'a', 'K', now), () => {}, () => now);
    s.attachAgent(new FakeSocket());
    expect(s.attachViewer(new FakeSocket())).toBeNull();
  });
});

describe('pairing and routing', () => {
  it('routes envelopes both ways by connection number', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    const c = s.attachViewer(v)!;
    expect(c).toBe(1);
    expect(agent.json()).toContainEqual({ t: 'open', c: 1 });
    s.viewerMessage(1, new Uint8Array([5, 6]));
    expect(decodeEnvelope(agent.bytes()[0]!)).toEqual({ c: 1, payload: new Uint8Array([5, 6]) });
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array([7])));
    await s.flush();
    expect(v.bytes()).toEqual([new Uint8Array([7])]);
    s.agentMessage(agent, encodeEnvelope(99, new Uint8Array([8])));
    await s.flush();
    expect(v.bytes()).toHaveLength(1);
  });

  it('text from a viewer closes it with 1003; oversize payloads close with 1009', async () => {
    const { s, agent } = await registered();
    const v1 = new FakeSocket();
    s.attachViewer(v1);
    s.viewerMessage(1, 'hello');
    expect(v1.closed?.code).toBe(1003);
    const v2 = new FakeSocket();
    const c2 = s.attachViewer(v2)!;
    s.viewerMessage(c2, new Uint8Array(RELAY_LIMITS.viewerPayloadMax + 1));
    expect(v2.closed?.code).toBe(1009);
    s.agentMessage(agent, encodeEnvelope(c2, new Uint8Array(RELAY_LIMITS.agentPayloadMax + 1)));
    await s.flush();
    expect(agent.closed?.code).toBe(1009);
  });

  it('a 5th concurrent viewer is refused', async () => {
    const { s } = await registered();
    for (let i = 0; i < 4; i++) expect(s.attachViewer(new FakeSocket())).not.toBeNull();
    expect(s.attachViewer(new FakeSocket())).toBeNull();
  });

  it('a viewer closing tells the agent; the agent can close a viewer with a code', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    s.agentMessage(agent, '{"t":"close","c":1,"code":1008}');
    await s.flush();
    expect(v.closed?.code).toBe(1008);
    const v2 = new FakeSocket();
    const c2 = s.attachViewer(v2)!;
    s.viewerClosed(c2);
    expect(agent.json()).toContainEqual({ t: 'close', c: c2 });
  });
});

describe('billing signal', () => {
  it('fires takeover_opened once, on the first payload of 4 KB or more', async () => {
    const { s, agent } = await registered();
    s.attachViewer(new FakeSocket());
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array(RELAY_LIMITS.billableBytes - 1)));
    await s.flush();
    expect(names()).not.toContain('takeover_opened');
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array(RELAY_LIMITS.billableBytes)));
    await s.flush();
    expect(names().filter((n) => n === 'takeover_opened')).toHaveLength(1);
  });

  it('Review Focus 3: two viewers receiving frames, and a reconnect, still count once', async () => {
    const { s, agent } = await registered();
    s.attachViewer(new FakeSocket());
    s.attachViewer(new FakeSocket());
    for (const c of [1, 2, 1, 2]) s.agentMessage(agent, encodeEnvelope(c, new Uint8Array(50_000)));
    s.viewerClosed(1);
    s.attachViewer(new FakeSocket());
    s.agentMessage(agent, encodeEnvelope(3, new Uint8Array(50_000)));
    await s.flush();
    expect(names().filter((n) => n === 'takeover_opened')).toHaveLength(1);
  });
});

describe('backpressure', () => {
  it('drops payloads of 4 KB or more for a backed-up viewer but still delivers small ones', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    v.bufferedAmount = RELAY_LIMITS.backpressureBytes + 1;
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array(5000)));
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array(300)));
    await s.flush();
    expect(v.bytes().map((b) => b.length)).toEqual([300]);
  });
});

describe('agent drop and reconnect', () => {
  it('closes viewers with 1012 and accepts a reconnect with the same secret', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    s.agentClosed(agent);
    expect(v.closed?.code).toBe(1012);
    expect(s.record.agentDownSince).toBe(now);
    expect(s.attachViewer(new FakeSocket())).toBeNull();
    now += 5000;
    const back = new FakeSocket();
    s.attachAgent(back);
    s.agentMessage(back, hello('SECRET'));
    await s.flush();
    expect(s.record.agentDownSince).toBeNull();
    expect(s.attachViewer(new FakeSocket())).not.toBeNull();
  });

  it('a different secret is closed with 4409 and the original keeps working', async () => {
    const { s, agent } = await registered();
    const thief = new FakeSocket();
    s.attachAgent(thief);
    s.agentMessage(thief, hello('WRONG'));
    await s.flush();
    expect(thief.closed?.code).toBe(4409);
    expect(agent.closed).toBeNull();
    expect(s.attachViewer(new FakeSocket())).not.toBeNull();
  });

  it('a same-secret reconnect while the old socket is still open replaces it', async () => {
    const { s, agent } = await registered();
    const back = new FakeSocket();
    s.attachAgent(back);
    s.agentMessage(back, hello('SECRET'));
    await s.flush();
    expect(agent.closed?.code).toBe(4409);
    s.agentClosed(agent); // the old socket's close must not take the session down
    expect(s.record.agentDownSince).toBeNull();
  });

  it('Review Focus 4: without a reconnect the session ends after the grace and reports once', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array(10)));
    await s.flush();
    s.agentClosed(agent);
    expect(s.deadline()).toBe(now + RELAY_LIMITS.graceMs);
    now += RELAY_LIMITS.graceMs - 1;
    expect(s.tick()).toBe('alive');
    now += 2;
    expect(s.tick()).toBe('ended');
    expect(s.ended).toBe(true);
    const closed = events.filter((e) => e.name === 'session_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ bytesToViewers: 10, viewers: 1, durationMs: RELAY_LIMITS.graceMs + 1 });
    expect(s.tick()).toBe('ended');
  });
});

describe('end, expiry, idle, heartbeat', () => {
  it('end from the agent closes everything', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    s.agentMessage(agent, '{"t":"end"}');
    await s.flush();
    expect(s.ended).toBe(true);
    expect(v.closed).not.toBeNull();
    expect(agent.closed).not.toBeNull();
    expect(names()).toContain('session_closed');
  });

  it('expiry ends the session', async () => {
    const { s } = await registered();
    now += 600_000;
    expect(s.tick()).toBe('ended');
  });

  it('pings the agent every 30 s and closes a socket silent for 120 s', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    now += RELAY_LIMITS.heartbeatMs;
    s.tick();
    expect(agent.json()).toContainEqual({ t: 'ping' });
    s.agentMessage(agent, '{"t":"pong"}');
    await s.flush();
    now += RELAY_LIMITS.idleMs - RELAY_LIMITS.heartbeatMs + 1;
    s.tick();
    expect(v.closed?.code).toBe(1001);
    expect(agent.closed).toBeNull();
  });

  it('passes agent events through and ignores unknown control', async () => {
    const { s, agent } = await registered();
    s.agentMessage(agent, '{"t":"event","name":"viewer_joined"}');
    s.agentMessage(agent, '{"t":"nope"}');
    await s.flush();
    expect(events.at(-1)).toMatchObject({ name: 'agent_event', event: 'viewer_joined', account: 'acct' });
    expect(agent.closed).toBeNull();
  });

  it('after end every method is a no-op', async () => {
    const { s, agent } = await registered();
    s.end('test');
    const n = events.length;
    expect(s.attachViewer(new FakeSocket())).toBeNull();
    s.viewerMessage(1, new Uint8Array(1));
    s.viewerClosed(1);
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array(1)));
    s.agentClosed(agent);
    s.attachAgent(new FakeSocket());
    s.end('again');
    await s.flush();
    expect(events).toHaveLength(n);
  });
});

describe('rebind after hibernation', () => {
  it('a fresh RelaySession from the record and the live sockets keeps forwarding', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    const revived = new RelaySession(s.record, (e) => void events.push(e), () => now);
    revived.rebind(agent, new Map([[1, v]]));
    revived.agentMessage(agent, encodeEnvelope(1, new Uint8Array([4])));
    await revived.flush();
    expect(v.bytes()).toEqual([new Uint8Array([4])]);
    expect(revived.attachViewer(new FakeSocket())).toBe(2);
  });
});
