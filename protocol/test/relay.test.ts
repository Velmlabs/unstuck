import { describe, it, expect } from 'vitest';
import {
  encodeEnvelope,
  decodeEnvelope,
  parseAgentToRelay,
  parseRelayToAgent,
  RELAY_CLOSE,
  RELAY_LIMITS,
  RELAY_SUBPROTOCOL,
  KEY_SUBPROTOCOL_PREFIX,
  SESSION_ID_RE,
} from '../src/relay';

describe('envelope', () => {
  it('round-trips connection number and payload', () => {
    const p = new Uint8Array([1, 2, 3]);
    expect(decodeEnvelope(encodeEnvelope(7, p))).toEqual({ c: 7, payload: p });
    expect(decodeEnvelope(encodeEnvelope(0xffffffff, p))!.c).toBe(0xffffffff);
    expect(decodeEnvelope(encodeEnvelope(1, new Uint8Array()))).toEqual({ c: 1, payload: new Uint8Array() });
  });
  it('rejects short input and bad connection numbers', () => {
    expect(decodeEnvelope(new Uint8Array([0, 0, 1]))).toBeNull();
    expect(() => encodeEnvelope(-1, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeEnvelope(2 ** 32, new Uint8Array())).toThrow(RangeError);
  });
  it('decodes from a view into a larger buffer', () => {
    const big = new Uint8Array(10);
    big.set(encodeEnvelope(3, new Uint8Array([9])), 2);
    expect(decodeEnvelope(big.subarray(2, 7))).toEqual({ c: 3, payload: new Uint8Array([9]) });
  });
});

describe('control messages', () => {
  it.each(['{"t":"open","c":1}', '{"t":"close","c":2}', '{"t":"ping"}', '{"t":"registered"}'])('relay→agent accepts %s', (raw) => {
    expect(parseRelayToAgent(raw)).toEqual(JSON.parse(raw));
  });
  it.each([
    '{"t":"hello","expiresAt":1,"secret":"abc"}',
    '{"t":"close","c":2,"code":1008}',
    '{"t":"pong"}',
    '{"t":"end"}',
    '{"t":"event","name":"viewer_joined"}',
  ])('agent→relay accepts %s', (raw) => {
    expect(parseAgentToRelay(raw)).toEqual(JSON.parse(raw));
  });
  it.each(['{"t":"hello","expiresAt":1}', '{"t":"nope"}', '{"t":"pong","x":1}', 'not json', '{"t":"open","c":-1}'])('rejects %s', (raw) => {
    expect(parseAgentToRelay(raw)).toBeNull();
    expect(parseRelayToAgent(raw)).toBeNull();
  });
});

describe('constants', () => {
  it('match the spec', () => {
    expect(RELAY_SUBPROTOCOL).toBe('unstuck-relay.1');
    expect(KEY_SUBPROTOCOL_PREFIX).toBe('key.');
    expect(SESSION_ID_RE.test('abcdefghijklmnop')).toBe(true);
    expect(SESSION_ID_RE.test('short')).toBe(false);
    expect(SESSION_ID_RE.test('a/b' + 'x'.repeat(20))).toBe(false);
    expect(RELAY_LIMITS).toMatchObject({ agentPayloadMax: 2_097_152, viewerPayloadMax: 65_536, viewersPerSession: 4, graceMs: 60_000, billableBytes: 4096 });
    expect(RELAY_CLOSE.refused(401)).toBe(4401);
    expect(RELAY_CLOSE.replaced).toBe(4409);
  });
});

describe('agent close codes (security finding 5)', () => {
  it.each([1000, 1001, 1003, 1008, 1011, 1013, 3000, 4000, 4999])('accepts sendable code %i', (code) => {
    expect(parseAgentToRelay(JSON.stringify({ t: 'close', c: 1, code }))).not.toBeNull();
  });
  it.each([0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535, -1, 1000.5])('rejects code %s, which a socket would refuse to send', (code) => {
    expect(parseAgentToRelay(JSON.stringify({ t: 'close', c: 1, code }))).toBeNull();
  });
});

describe('human bridge relay frames', () => {
  it('hello may carry a mode; quick_answer is a relay-to-agent frame', () => {
    expect(parseAgentToRelay('{"t":"hello","expiresAt":1,"secret":"s","mode":"question"}')).toMatchObject({ mode: 'question' });
    expect(parseAgentToRelay('{"t":"hello","expiresAt":1,"secret":"s","mode":"other"}')).toBeNull();
    expect(parseRelayToAgent('{"t":"quick_answer","choice":0}')).toEqual({ t: 'quick_answer', choice: 0 });
    expect(parseRelayToAgent('{"t":"quick_answer","choice":9}')).toBeNull();
  });
});
