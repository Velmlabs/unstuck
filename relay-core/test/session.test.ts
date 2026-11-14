import { describe, it, expect, beforeEach } from 'vitest';
import { encodeEnvelope, decodeEnvelope, RELAY_LIMITS } from '@velmlabs/unstuck-protocol';
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
    expect(agent.json()).toEqual([{ t: 'registered' }]);
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

  it('a 5th concurrent viewer is refused when the 4 attached ones are confirmed', async () => {
    const { s, agent } = await registered();
    for (let i = 0; i < 4; i++) {
      const c = s.attachViewer(new FakeSocket())!;
      expect(c).not.toBeNull();
      s.agentMessage(agent, encodeEnvelope(c, new Uint8Array([1])));
      s.agentMessage(agent, encodeEnvelope(c, new Uint8Array([2])));
    }
    await s.flush();
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
    expect(back.json()).toEqual([{ t: 'registered' }]);
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

  it('Final #3: replacing a still-open agent socket closes its viewers with 1012 so they resume on the new one', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    s.attachViewer(v);
    const back = new FakeSocket();
    s.attachAgent(back);
    s.agentMessage(back, hello('SECRET'));
    await s.flush();
    expect(v.closed?.code).toBe(1012);
    expect(back.json()).not.toContainEqual({ t: 'close', c: 1 }); // the new agent never knew viewer 1
    expect(s.attachViewer(new FakeSocket())).toBe(2);
    expect(agent.closed?.code).toBe(4409);
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

describe('isAgent', () => {
  it('is true only for the registered agent socket', async () => {
    const { s, agent } = await registered();
    const other = new FakeSocket();
    s.attachAgent(other);
    expect(s.isAgent(agent)).toBe(true);
    expect(s.isAgent(other)).toBe(false);
  });
});


describe('security: viewer slot squatting (finding 2)', () => {
  // A viewer is "confirmed" once the agent has sent it a second payload: the engine's first message to every
  // connection is its sealed challenge, and it says nothing more until a hello made with the link's key.
  const confirm = async (s: RelaySession, agent: FakeSocket, c: number) => {
    s.agentMessage(agent, encodeEnvelope(c, new Uint8Array([1])));
    s.agentMessage(agent, encodeEnvelope(c, new Uint8Array([2])));
    await s.flush();
  };

  it('when all slots hold unconfirmed viewers, a new viewer evicts the oldest unconfirmed one', async () => {
    const { s, agent } = await registered();
    const squatters = [1, 2, 3, 4].map(() => new FakeSocket());
    squatters.forEach((v, i) => expect(s.attachViewer(v, `10.0.0.${i}`)).toBe(i + 1));
    const human = new FakeSocket();
    expect(s.attachViewer(human, '192.168.1.1')).toBe(5);
    expect(squatters[0]!.closed?.code).toBe(1013);
    expect(squatters.slice(1).every((v) => v.closed === null)).toBe(true);
    expect(agent.json()).toContainEqual({ t: 'close', c: 1 }); // the engine drops its side too
  });

  it('a confirmed viewer is never evicted; with every slot confirmed a new viewer is refused', async () => {
    const { s, agent } = await registered();
    const humans = [1, 2, 3, 4].map(() => new FakeSocket());
    for (const [i, v] of humans.entries()) {
      const c = s.attachViewer(v, `10.0.0.${i}`)!;
      await confirm(s, agent, c);
    }
    expect(s.attachViewer(new FakeSocket(), '6.6.6.6')).toBeNull();
    expect(humans.every((v) => v.closed === null)).toBe(true);
  });

  it('a viewer that only received the challenge is still unconfirmed and can be evicted', async () => {
    const { s, agent } = await registered();
    const vs = [1, 2, 3, 4].map(() => new FakeSocket());
    for (const [i, v] of vs.entries()) s.attachViewer(v, `10.0.0.${i}`);
    await confirm(s, agent, 1);
    s.agentMessage(agent, encodeEnvelope(2, new Uint8Array([9]))); // challenge only
    await s.flush();
    expect(s.attachViewer(new FakeSocket(), '7.7.7.7')).toBe(5);
    expect(vs[0]!.closed).toBeNull(); // confirmed: kept
    expect(vs[1]!.closed?.code).toBe(1013); // oldest unconfirmed
  });

  it('one IP holds at most 2 unconfirmed viewers per session: its third evicts its own oldest', async () => {
    const { s } = await registered();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    s.attachViewer(a, '6.6.6.6');
    s.attachViewer(b, '6.6.6.6');
    expect(s.attachViewer(c, '6.6.6.6')).toBe(3);
    expect(a.closed?.code).toBe(1013);
    expect(b.closed).toBeNull();
    // So one address can't fill the session: two other people still get in without evicting anyone.
    const other1 = new FakeSocket();
    const other2 = new FakeSocket();
    s.attachViewer(other1, '1.1.1.1');
    s.attachViewer(other2, '2.2.2.2');
    expect([b, c, other1, other2].every((v) => v.closed === null)).toBe(true);
  });

  it('confirmed viewers from the same IP do not count toward its unconfirmed cap', async () => {
    const { s, agent } = await registered();
    const first = new FakeSocket();
    const c1 = s.attachViewer(first, '6.6.6.6')!;
    const second = new FakeSocket();
    const c2 = s.attachViewer(second, '6.6.6.6')!;
    await confirm(s, agent, c1);
    await confirm(s, agent, c2);
    s.attachViewer(new FakeSocket(), '6.6.6.6');
    s.attachViewer(new FakeSocket(), '6.6.6.6');
    expect(first.closed).toBeNull();
    expect(second.closed).toBeNull();
  });

  it('without an IP only the slot rule applies', async () => {
    const { s } = await registered();
    const vs = [1, 2, 3, 4].map(() => new FakeSocket());
    for (const v of vs) s.attachViewer(v);
    expect(s.attachViewer(new FakeSocket())).toBe(5);
    expect(vs[0]!.closed?.code).toBe(1013);
  });

  it('after a rebind, viewers keep their confirmed state; viewers without one count as confirmed', async () => {
    const { s, agent } = await registered();
    const confirmedEvents: number[] = [];
    const revived = new RelaySession(s.record, () => {}, () => now, { onViewerConfirmed: (c) => confirmedEvents.push(c) });
    const [v1, v2, v3, v4] = [1, 2, 3, 4].map(() => new FakeSocket());
    revived.rebind(
      agent,
      new Map([[1, v1!], [2, v2!], [3, v3!], [4, v4!]]),
      new Map([[1, { ip: '6.6.6.6', confirmed: false }], [2, { ip: null, confirmed: true }], [3, { ip: '6.6.6.6', confirmed: false }]]),
    );
    expect(revived.attachViewer(new FakeSocket(), '6.6.6.6')).toBe(1); // nextC from the record (no viewers attached on s)
    expect(v1!.closed?.code).toBe(1013);
    expect([v2, v3, v4].every((v) => v!.closed === null)).toBe(true);
    revived.agentMessage(agent, encodeEnvelope(3, new Uint8Array([1])));
    revived.agentMessage(agent, encodeEnvelope(3, new Uint8Array([2])));
    revived.agentMessage(agent, encodeEnvelope(3, new Uint8Array([3])));
    await revived.flush();
    expect(confirmedEvents).toEqual([3]); // reported once, so hosts can persist it
  });
});

describe('security: viewer → agent backpressure and rate (finding 3)', () => {
  it('a viewer is dropped with 1013 when the agent socket is backed up', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    const c = s.attachViewer(v)!;
    agent.bufferedAmount = RELAY_LIMITS.backpressureBytes + 1;
    s.viewerMessage(c, new Uint8Array(10));
    expect(v.closed?.code).toBe(1013);
    expect(agent.bytes()).toHaveLength(0);
    expect(agent.json()).toContainEqual({ t: 'close', c });
  });

  it('a viewer sending more than its byte budget per window is closed with 1008; the budget resets', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    const c = s.attachViewer(v)!;
    const chunk = new Uint8Array(RELAY_LIMITS.viewerPayloadMax);
    const n = RELAY_LIMITS.viewerBytesPerWindow / chunk.length;
    for (let i = 0; i < n; i++) s.viewerMessage(c, chunk);
    expect(v.closed).toBeNull();
    now += RELAY_LIMITS.viewerByteWindowMs;
    for (let i = 0; i < n; i++) s.viewerMessage(c, chunk);
    expect(v.closed).toBeNull();
    s.viewerMessage(c, new Uint8Array(1));
    expect(v.closed?.code).toBe(1008);
    expect(agent.bytes()).toHaveLength(2 * n);
  });
});

describe('security: agent close codes (finding 5)', () => {
  it('a viewer socket whose close throws is still forgotten, so its slot is freed', async () => {
    const { s, agent } = await registered();
    const v = new FakeSocket();
    v.close = () => {
      throw new RangeError('invalid code');
    };
    for (let i = 0; i < 4; i++) s.attachViewer(i === 0 ? v : new FakeSocket());
    // confirm the other three so the only way in is a freed slot
    for (const c of [2, 3, 4]) {
      s.agentMessage(agent, encodeEnvelope(c, new Uint8Array([1])));
      s.agentMessage(agent, encodeEnvelope(c, new Uint8Array([2])));
    }
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array([1])));
    s.agentMessage(agent, encodeEnvelope(1, new Uint8Array([2])));
    s.agentMessage(agent, '{"t":"close","c":1,"code":4000}');
    await s.flush();
    expect(s.attachViewer(new FakeSocket())).toBe(5);
  });
});

describe('security: sessions that never register (finding 6)', () => {
  it('end 30 s after creation when no hello arrived', () => {
    const s = new RelaySession(newRecord('SID_0123456789abcdef', 'a', 'K', now), (e) => void events.push(e), () => now);
    const cand = new FakeSocket();
    s.attachAgent(cand);
    expect(s.deadline()).toBe(now + RELAY_LIMITS.heartbeatMs);
    now += RELAY_LIMITS.heartbeatMs - 1;
    expect(s.tick()).toBe('alive');
    now += 1;
    expect(s.tick()).toBe('ended');
    expect(cand.closed).not.toBeNull();
    expect(names()).toEqual(['session_closed']);
  });

  it('a registered session is not subject to the registration deadline', async () => {
    const { s } = await registered();
    now += RELAY_LIMITS.heartbeatMs + 1;
    expect(s.tick()).toBe('alive');
  });
});

describe('security: billing needs one real frame (finding 8)', () => {
  it('many small payloads across many viewer connections never fire takeover_opened', async () => {
    const { s, agent } = await registered();
    for (let i = 0; i < 100; i++) {
      const c = s.attachViewer(new FakeSocket(), `10.0.${i}.1`)!;
      s.agentMessage(agent, encodeEnvelope(c, new Uint8Array(120))); // a sealed challenge is ~100 bytes
      await s.flush();
      s.viewerClosed(c);
    }
    expect(s.record.bytesToViewers).toBeGreaterThan(RELAY_LIMITS.billableBytes);
    expect(names()).not.toContain('takeover_opened');
  });
});
