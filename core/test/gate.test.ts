import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RESUME_WINDOW_MS, type ViewerToEngine } from '@velmlabs/unstuck-protocol';
import { FakeViewer } from '../src/testing';
import type { ViewerConnection } from '../src/transport';
import { createViewerGate, HELLO_TIMEOUT_MS, type GateOptions } from '../src/session/gate';
import { importSecret, newSecret, signToken } from '../src/session/tokens';
import { settle } from './settle';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

async function setup(extra: Partial<GateOptions> = {}) {
  const key = await importSecret(newSecret());
  const sessionId = 'sess-1';
  const token = await signToken(key, sessionId, Date.now() + 3_600_000);
  let ended = false;
  const events: { type: string; data?: Record<string, string | number | boolean> }[] = [];
  const attached: { conn: ViewerConnection; vn?: string }[] = [];
  const detached: ViewerConnection[] = [];
  const messages: { conn: ViewerConnection; msg: ViewerToEngine }[] = [];
  const gate = createViewerGate({
    key,
    sessionId,
    now: () => Date.now(),
    isEnded: () => ended,
    emit: (type, data) => void events.push({ type, ...(data ? { data } : {}) }),
    onAttach: async (conn, vn) => {
      attached.push({ conn, vn });
      conn.send(JSON.stringify({ t: 'ready', resumeKey: gate.resumeKey() }));
    },
    onDetach: (conn) => void detached.push(conn),
    onMessage: (conn, msg) => void messages.push({ conn, msg }),
    ...extra,
  });
  const open = () => {
    const v = new FakeViewer();
    gate.onConnection(v);
    return v;
  };
  return { gate, key, token, open, events, attached, detached, messages, end: () => (ended = true) };
}

describe('viewer gate', () => {
  it('admits a valid hello once, refuses a second device with token_used', async () => {
    const t = await setup();
    const a = t.open();
    a.push({ t: 'hello', token: t.token, vn: 'viewer-nonce-0123456' });
    await settle();
    expect(t.attached).toEqual([{ conn: a, vn: 'viewer-nonce-0123456' }]);
    expect(t.gate.holder()).toBe(a);
    expect(t.gate.joined()).toBe(true);
    expect(t.gate.resumeKey()).toBe(a.json()[0].resumeKey);

    const b = t.open();
    b.push({ t: 'hello', token: t.token });
    await settle();
    expect(b.json()).toEqual([{ t: 'error', code: 'token_used', message: 'This link is already in use on another device.' }]);
    expect(b.closed).toEqual({ code: 1008, reason: 'token_used' });
    expect(t.events).toContainEqual({ type: 'viewer_rejected', data: { code: 'token_used' } });
    expect(t.gate.holder()).toBe(a);
    expect(t.detached).toEqual([]); // a rejected connection is not the holder leaving
  });

  it('asks for the code and locks after 5 wrong ones', async () => {
    const t = await setup({ code: '123456' });
    const v = t.open();
    v.push({ t: 'hello', token: t.token });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'code_required' });
    expect(v.closed).toBeNull();
    for (let i = 0; i < 5; i++) {
      v.push({ t: 'hello', token: t.token, code: '654321' });
      await settle();
    }
    expect(v.json().slice(1).map((m) => m.code)).toEqual(Array(5).fill('code_invalid'));
    expect(v.closed).toBeNull();
    v.push({ t: 'hello', token: t.token, code: '123456' }); // right, but too late
    await settle();
    expect(v.json().at(-1)).toMatchObject({ t: 'error', code: 'session_closed' });
    expect(v.closed).toEqual({ code: 1008, reason: 'session_closed' });
    expect(t.events.at(-1)).toEqual({ type: 'viewer_rejected', data: { code: 'code_locked' } });
    expect(t.attached).toEqual([]);
    expect(t.gate.joined()).toBe(false);
  });

  it('admits the right code', async () => {
    const t = await setup({ code: '123456' });
    const v = t.open();
    v.push({ t: 'hello', token: t.token, code: '123456' });
    await settle();
    expect(t.gate.holder()).toBe(v);
  });

  it('resume key lets the same device back without the code', async () => {
    const t = await setup({ code: '123456' });
    const a = t.open();
    a.push({ t: 'hello', token: t.token, code: '123456' });
    await settle();
    const resumeKey = t.gate.resumeKey()!;
    a.close(1006);
    expect(t.detached).toEqual([a]);
    expect(t.gate.holder()).toBeNull();

    vi.advanceTimersByTime(5_000);
    const b = t.open();
    b.push({ t: 'hello', token: t.token, resumeKey });
    await settle();
    expect(t.gate.holder()).toBe(b);
    expect(t.gate.resumeKey()).not.toBe(resumeKey); // a fresh key for each attach

    // The resume key also takes over from a holder still connected (a reload): the old one is closed as replaced.
    const c = t.open();
    c.push({ t: 'hello', token: t.token, resumeKey: t.gate.resumeKey()! });
    await settle();
    expect(t.gate.holder()).toBe(c);
    expect(b.closed).toEqual({ code: 1000, reason: 'replaced' });
    expect(t.detached).toEqual([a]); // a replaced holder is not "the holder left"
  });

  it('a resume key is refused once the resume window has passed, unless it was renewed', async () => {
    const t = await setup();
    const a = t.open();
    a.push({ t: 'hello', token: t.token });
    await settle();
    expect(t.gate.renewResumeWindow()).toBe(false); // the holder is still here
    a.close();
    vi.advanceTimersByTime(RESUME_WINDOW_MS - 1_000);
    expect(t.gate.renewResumeWindow()).toBe(true);
    vi.advanceTimersByTime(RESUME_WINDOW_MS - 1_000);
    const b = t.open();
    b.push({ t: 'hello', token: t.token, resumeKey: t.gate.resumeKey()! });
    await settle();
    expect(t.gate.holder()).toBe(b); // past the window since leaving, but within it since the renewal

    b.close();
    vi.advanceTimersByTime(RESUME_WINDOW_MS + 1);
    const c = t.open();
    c.push({ t: 'hello', token: t.token, resumeKey: t.gate.resumeKey()! });
    await settle();
    expect(c.json()[0]).toMatchObject({ code: 'token_used' });
    expect(t.gate.holder()).toBeNull();
  });

  it('hello timeout closes a silent connection', async () => {
    const t = await setup();
    const v = t.open();
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS - 1);
    expect(v.closed).toBeNull();
    vi.advanceTimersByTime(1);
    expect(v.closed).toEqual({ code: 1008, reason: 'hello timeout' });
  });

  it('messages sent during hello are delivered after it', async () => {
    const t = await setup();
    const v = t.open();
    v.push({ t: 'hello', token: t.token });
    v.push({ t: 'done' });
    v.push('not json');
    v.push({ t: 'hello', token: t.token });
    await settle();
    expect(t.messages).toEqual([{ conn: v, msg: { t: 'done' } }]);
    // After hello, the gate answers anything unparsable (or a second hello) with bad_message and keeps the connection.
    expect(v.json().slice(1)).toEqual([
      { t: 'error', code: 'bad_message', message: 'Unexpected message.' },
      { t: 'error', code: 'bad_message', message: 'Unexpected message.' },
    ]);
    expect(v.closed).toBeNull();
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS);
    expect(v.closed).toBeNull();
  });

  it('a refused hello leaves the queued messages to be refused too', async () => {
    const t = await setup();
    const v = t.open();
    v.push({ t: 'hello', token: 'nope' });
    v.push({ t: 'done' });
    await settle();
    expect(v.json()[0]).toMatchObject({ code: 'token_invalid' });
    expect(t.events).toContainEqual({ type: 'viewer_rejected', data: { code: 'token_invalid' } });
    expect(t.messages).toEqual([]);
  });

  it('refuses a first message that is not a hello, and a token for another session', async () => {
    const t = await setup();
    const a = t.open();
    a.push({ t: 'done' });
    expect(a.json()[0]).toMatchObject({ code: 'bad_message' });
    expect(a.closed).toEqual({ code: 1008, reason: 'bad_message' });

    const other = await signToken(t.key, 'sess-2', Date.now() + 1000);
    const b = t.open();
    b.push({ t: 'hello', token: other });
    await settle();
    expect(b.json()[0]).toMatchObject({ code: 'token_invalid' });
  });

  it('refuses everyone once the session has ended', async () => {
    const t = await setup();
    const a = t.open();
    a.push({ t: 'hello', token: t.token });
    t.end(); // ends while the token is being checked
    await settle();
    expect(a.json()[0]).toMatchObject({ code: 'session_closed' });
    const b = t.open();
    expect(b.closed).toEqual({ code: 1008, reason: 'session_closed' });
    expect(t.gate.holder()).toBeNull();
  });

  it('end sends state with the answer and closes the holder', async () => {
    const t = await setup();
    const v = t.open();
    v.push({ t: 'hello', token: t.token });
    const silent = t.open();
    await settle();
    t.end();
    t.gate.end('answered', { choice: 1, label: 'Yes' });
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'answered', answer: { choice: 1, label: 'Yes' } });
    expect(v.closed).toEqual({ code: 1000, reason: 'answered' });
    expect(t.gate.holder()).toBeNull();
    expect(t.detached).toEqual([]); // closed by the session ending, not left
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS);
    expect(silent.closed).toBeNull(); // hello timers were cleared
    t.gate.end('answered'); // nobody holding: nothing to do
  });

  it('end without an answer sends the bare state', async () => {
    const t = await setup();
    const v = t.open();
    v.push({ t: 'hello', token: t.token });
    await settle();
    t.gate.end('resolved');
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'resolved' });
  });
});
