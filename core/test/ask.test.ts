// Question sessions: no browser page; the person answers on a private page (or, for a non-private question, with a
// Telegram button the relay hands over as a quick answer), and the agent gets the answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RESUME_WINDOW_MS, type TakeoverResult } from '@velmlabs/unstuck-protocol';
import { FakeTransport } from '../src/testing';
import { MemoryEventLog } from '../src/events';
import { importSecret, newSecret } from '../src/session/tokens';
import { checkAsk, runAsk, ASK_LIMITS, type AskSessionOptions } from '../src/session/ask';
import { cleanLine, cleanReason, type LinkInfo, type TakeoverControl } from '../src/session/takeover';
import { settle } from './settle';

async function setup(o: Partial<AskSessionOptions> = {}, transport = new FakeTransport()) {
  const log = new MemoryEventLog();
  const key = await importSecret(newSecret());
  const links: LinkInfo[] = [];
  const controls: TakeoverControl[] = [];
  const session = runAsk(
    { transport, key, log, now: () => Date.now() },
    {
      question: 'Ship the release today?',
      choices: ['Yes', 'No'],
      allowText: false,
      details: 'All checks are green.',
      timeoutS: 600,
      agentName: 'Ava',
      quickAnswers: false,
      onLink: (l, c) => (links.push(l), controls.push(c)),
      ...o,
    },
  );
  let result: TakeoverResult | undefined;
  void session.result.then((r) => (result = r));
  await settle();
  const token = () => new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
  const id = () => links[0]!.sessionId;
  const join = async (extra: object = {}) => {
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token: token(), ...extra });
    await settle();
    return v;
  };
  const finished = async () => {
    await settle();
    return session.result;
  };
  return { transport, log, links, controls, session, join, finished, id, result: () => result };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('question session', () => {
  it('question session: mode frame carries the question; a choice answers it', async () => {
    const t = await setup();
    expect(t.links[0]).toMatchObject({ reason: 'Ship the release today?', kind: 'question', mode: 'question' });
    expect(t.links[0]!.code).toBeUndefined();
    expect(t.transport.modes.get(t.id())).toBe('question');
    const v = await t.join();
    const [ready, mode, ...rest] = v.json();
    expect(ready).toEqual({ t: 'ready', reason: 'Ship the release today?', site: '', expiresAt: t.links[0]!.expiresAt, resumeKey: expect.any(String) });
    expect(mode).toEqual({
      t: 'mode',
      mode: 'question',
      reason: 'Ship the release today?',
      site: '',
      agentName: 'Ava',
      question: { text: 'Ship the release today?', choices: ['Yes', 'No'], allowText: false, details: 'All checks are green.' },
    });
    expect(rest).toEqual([]);
    expect(t.controls[0]!.joined()).toBe(true);

    v.push({ t: 'answer', choice: 1 });
    const r = await t.finished();
    expect(r).toMatchObject({ status: 'answered', answer: { choice: 1, label: 'No' }, via: 'page', sessionId: t.id(), url: t.links[0]!.url });
    expect(r.answer).toEqual({ choice: 1, label: 'No' });
    expect(t.transport.unpublished).toEqual([t.id()]);
    // The audit log never holds the question or the answer.
    const logged = JSON.stringify(t.log.events);
    expect(logged).not.toContain('Ship');
    expect(logged).not.toContain('No"');
    expect(t.log.events.find((e) => e.type === 'finished')?.data).toMatchObject({ status: 'answered', via: 'page' });
    expect(t.log.events.map((e) => e.type)).toEqual(['created', 'status', 'published', 'status', 'link', 'status', 'viewer_joined', 'finished']);
  });

  it('a question without choices or agent name leaves them out of the mode frame', async () => {
    const t = await setup({ choices: undefined, details: undefined, agentName: undefined, allowText: true });
    const v = await t.join();
    expect(v.json()[1]).toEqual({ t: 'mode', mode: 'question', reason: 'Ship the release today?', site: '', question: { text: 'Ship the release today?', allowText: true } });
    v.push({ t: 'answer', text: 'Tomorrow' });
    expect(await t.finished()).toMatchObject({ status: 'answered', answer: { text: 'Tomorrow' }, via: 'page' });
  });

  it('typed text is cleaned to one line and capped at 500', async () => {
    const t = await setup({ choices: undefined, allowText: true });
    const v = await t.join();
    v.push({ t: 'answer', text: '  Wait\nfor the‮  QA​team\t ' });
    const r = await t.finished();
    expect(r.answer).toEqual({ text: 'Wait for the QA team' });
    expect(JSON.stringify(t.log.events)).not.toContain('Wait');

    expect(cleanLine('x'.repeat(600), 500)).toBe('x'.repeat(500));
    expect(cleanLine(' a b ', 500)).toBe('a b');
    // The "Can't solve" reason keeps its own rules.
    expect(cleanReason('y'.repeat(300))).toBe('y'.repeat(200));

    const t2 = await setup({ choices: undefined, allowText: true });
    const v2 = await t2.join();
    v2.push({ t: 'answer', text: 'z'.repeat(500) });
    expect((await t2.finished()).answer).toEqual({ text: 'z'.repeat(500) });
  });

  it('a choice and typed text together when both are allowed', async () => {
    const t = await setup({ allowText: true });
    const v = await t.join();
    v.push({ t: 'answer', choice: 0, text: ' after lunch ' });
    expect((await t.finished()).answer).toEqual({ choice: 0, label: 'Yes', text: 'after lunch' });
  });

  it('text refused when allowText is false; empty answer refused (bad_message, no close)', async () => {
    const t = await setup();
    const v = await t.join();
    v.push({ t: 'answer', choice: 0, text: 'and more' });
    v.push({ t: 'answer', text: 'just text' });
    v.push({ t: 'answer' });
    v.push({ t: 'answer', choice: 2 }); // out of range for two choices
    await settle();
    const errors = v.json().filter((m) => m.t === 'error');
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e.code === 'bad_message')).toBe(true);
    expect(v.closed).toBeNull();
    expect(t.result()).toBeUndefined();

    const t2 = await setup({ choices: undefined, allowText: true });
    const v2 = await t2.join();
    v2.push({ t: 'answer', text: ' \n​ ' }); // nothing left once cleaned
    v2.push({ t: 'answer', choice: 0 }); // there are no choices
    await settle();
    expect(v2.json().filter((m) => m.t === 'error').map((e) => e.code)).toEqual(['bad_message', 'bad_message']);
    expect(v2.closed).toBeNull();

    v.push({ t: 'answer', choice: 0 });
    expect(await t.finished()).toMatchObject({ status: 'answered', answer: { choice: 0, label: 'Yes' } });
    t2.controls[0]!.cancel('test_over');
    await t2.finished();
  });

  it('page messages other than answer and ping are refused', async () => {
    const t = await setup();
    const v = await t.join();
    for (const m of [{ t: 'done' }, { t: 'approved' }, { t: 'switch_control' }, { t: 'cant_solve' }, { t: 'credit', v: 1 }, { t: 'ack', seq: 1 }, { t: 'text', text: 'hi' }])
      v.push(m);
    v.push({ t: 'ping' });
    await settle();
    const replies = v.json().slice(2);
    expect(replies.slice(0, 7).every((m) => m.t === 'error' && m.code === 'bad_message')).toBe(true);
    expect(replies[7]).toEqual({ t: 'pong' });
    expect(v.closed).toBeNull();
    t.controls[0]!.cancel('test_over');
    expect(await t.finished()).toMatchObject({ status: 'cancelled', detail: 'test_over' });
  });

  it('state echoes the answer to the viewer before closing', async () => {
    const t = await setup();
    const v = await t.join();
    v.push({ t: 'answer', choice: 1 });
    await t.finished();
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'answered', answer: { choice: 1, label: 'No' } });
    expect(v.closed).toMatchObject({ code: 1000, reason: 'answered' });
    // Nobody gets in after it ended.
    expect(() => t.transport.connect(t.links[0]!.url)).toThrow(/not published/);
  });

  it('quick answer ends it with via telegram when private: false', async () => {
    const t = await setup({ quickAnswers: true });
    const v = await t.join();
    // Out of range or not an index: ignored.
    for (const c of [2, -1, 0.5, Number.NaN]) t.transport.quickAnswer(t.id(), c);
    await settle();
    expect(t.result()).toBeUndefined();
    t.transport.quickAnswer(t.id(), 0);
    const r = await t.finished();
    expect(r).toMatchObject({ status: 'answered', answer: { choice: 0, label: 'Yes' }, via: 'telegram' });
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'answered', answer: { choice: 0, label: 'Yes' } });
    expect(t.log.events.find((e) => e.type === 'finished')?.data).toMatchObject({ status: 'answered', via: 'telegram' });
    // A later tap (another phone, or after it ended) changes nothing.
    t.transport.quickAnswer(t.id(), 1);
    await settle();
    expect(await t.session.result).toEqual(r);
  });

  it('a quick answer needs nobody on the page, and the first answer wins', async () => {
    const t = await setup({ quickAnswers: true });
    t.transport.quickAnswer(t.id(), 1);
    expect(await t.finished()).toMatchObject({ status: 'answered', answer: { choice: 1, label: 'No' }, via: 'telegram' });

    const t2 = await setup({ quickAnswers: true });
    const v2 = await t2.join();
    v2.push({ t: 'answer', choice: 0 });
    await settle();
    t2.transport.quickAnswer(t2.id(), 1);
    expect(await t2.finished()).toMatchObject({ answer: { choice: 0, label: 'Yes' }, via: 'page' });
  });

  it('quick answer ignored when not opted in', async () => {
    const t = await setup({ quickAnswers: false });
    expect(t.transport.hasQuickAnswerHandler(t.id())).toBe(false);
    t.transport.quickAnswer(t.id(), 0);
    await settle();
    expect(t.result()).toBeUndefined();
    t.controls[0]!.cancel('test_over');
    expect((await t.finished()).status).toBe('cancelled');
  });

  it('a quick answer with no choices to pick is ignored', async () => {
    const t = await setup({ quickAnswers: true, choices: undefined, allowText: true });
    t.transport.quickAnswer(t.id(), 0);
    await settle();
    expect(t.result()).toBeUndefined();
    t.controls[0]!.fail('test_over');
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'test_over' });
  });

  it('a transport without quick answers still runs the question', async () => {
    const transport = new FakeTransport();
    (transport as { onQuickAnswer?: unknown }).onQuickAnswer = undefined;
    const t = await setup({ quickAnswers: true }, transport);
    const v = await t.join();
    v.push({ t: 'answer', choice: 0 });
    expect(await t.finished()).toMatchObject({ status: 'answered', via: 'page' });
  });

  it('one device: a second viewer gets token_used', async () => {
    const t = await setup();
    const v = await t.join();
    const v2 = await t.join();
    expect(v2.json()).toEqual([{ t: 'error', code: 'token_used', message: expect.any(String) }]);
    expect(v2.closed).toMatchObject({ code: 1008 });
    expect(v.closed).toBeNull();
    // The same device comes back with its resume key.
    const resumeKey = v.json()[0].resumeKey;
    const v3 = await t.join({ resumeKey });
    expect(v.closed).toMatchObject({ reason: 'replaced' });
    expect(v3.json()[1]).toMatchObject({ t: 'mode', mode: 'question' });
    v3.push({ t: 'answer', choice: 0 });
    expect(await t.finished()).toMatchObject({ status: 'answered' });
  });

  it('a 6-digit code goes with the link when required', async () => {
    const t = await setup({ requireCode: true });
    expect(t.links[0]!.code).toMatch(/^\d{6}$/);
    const v = await t.join();
    expect(v.json()).toEqual([{ t: 'error', code: 'code_required', message: expect.any(String) }]);
    const v2 = await t.join({ code: t.links[0]!.code });
    expect(v2.json()[0]).toMatchObject({ t: 'ready' });
    t.controls[0]!.cancel('test_over');
    await t.finished();
  });

  it('timeout ends timed_out', async () => {
    const t = await setup({ timeoutS: 30 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const r = await t.finished();
    expect(r).toMatchObject({ status: 'timed_out', sessionId: t.id() });
    expect(r.answer).toBeUndefined();
    expect(r.via).toBeUndefined();
    expect(r.durationS).toBe(30);
  });

  it('a viewer who leaves and does not come back ends it failed/viewer_left; the relay being down pauses that', async () => {
    const t = await setup({ timeoutS: 3600 });
    const v = await t.join();
    v.close();
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS - 1);
    t.transport.setStatus(t.id(), 'down');
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS * 2);
    expect(t.result()).toBeUndefined();
    t.transport.setStatus(t.id(), 'up'); // the window restarts in full
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS - 1);
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'viewer_left' });
    t.transport.setStatus(t.id(), 'up'); // after the end: nothing happens
  });

  it('a resume within the window keeps it going', async () => {
    const t = await setup();
    const v = await t.join();
    const resumeKey = v.json()[0].resumeKey;
    v.close();
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS - 1_000);
    const v2 = await t.join({ resumeKey });
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS);
    expect(t.result()).toBeUndefined();
    v2.push({ t: 'answer', choice: 1 });
    expect(await t.finished()).toMatchObject({ status: 'answered' });
  });

  it('a publish the relay refuses fails with its detail; other publish errors are reported', async () => {
    const transport = new FakeTransport();
    transport.publish = () => Promise.reject(Object.assign(new Error('nope'), { detail: 'relay_quota_exceeded' }));
    const t = await setup({}, transport);
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'relay_quota_exceeded', url: '' });
    expect(t.links).toHaveLength(0);
    expect(transport.unpublished).toEqual([]);

    const transport2 = new FakeTransport();
    transport2.publish = () => Promise.reject(new Error('port in use'));
    const t2 = await setup({}, transport2);
    expect(await t2.finished()).toMatchObject({ status: 'failed', detail: 'publish_error: port in use' });
  });

  it('ended while publishing: unpublishes and never hands out a link', async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    const publish = transport.publish.bind(transport);
    transport.publish = (id, o) => new Promise((r) => (release = () => r(publish(id, o))));
    const unpublish = transport.unpublish.bind(transport);
    transport.unpublish = (id) => unpublish(id).then(() => Promise.reject(new Error('relay gone')));
    const key = await importSecret(newSecret());
    const links: LinkInfo[] = [];
    const s = runAsk({ transport, key, now: () => Date.now() }, { question: 'Q?', allowText: true, timeoutS: 600, quickAnswers: true, onLink: (l) => links.push(l) });
    await settle();
    s.cancel('engine_closed');
    release();
    await settle();
    expect(await s.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    expect(links).toHaveLength(0);
    expect(transport.published.size).toBe(0);
    expect(transport.hasQuickAnswerHandler([...transport.expiries.keys()][0]!)).toBe(false);
  });

  it('a link handler that throws does not stop the question; no handler is fine too', async () => {
    const t = await setup({
      onLink: () => {
        throw new Error('boom');
      },
    });
    expect(t.result()).toBeUndefined();
    t.session.cancel('test_over');
    expect(await t.finished()).toMatchObject({ status: 'cancelled' });

    const transport = new FakeTransport();
    const s = runAsk({ transport, key: await importSecret(newSecret()), now: () => Date.now() }, { question: 'Q?', allowText: true, timeoutS: 10, quickAnswers: false });
    await settle();
    expect(s.joined()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(await s.ended).toMatchObject({ status: 'timed_out' });
  });

  it('a transport that throws while wiring the link fails it as a publish error', async () => {
    const transport = new FakeTransport();
    transport.onConnection = () => {
      throw new Error('kaput');
    };
    const t = await setup({}, transport);
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'publish_error: kaput' });
    expect(transport.unpublished).toHaveLength(1);
  });

  it('an unexpected error after publishing fails it with internal_error', async () => {
    const transport = new FakeTransport();
    transport.onQuickAnswer = () => {
      throw new Error('kaput');
    };
    const t = await setup({ quickAnswers: true }, transport);
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'internal_error: kaput' });
    expect(t.links).toHaveLength(0);

    const transport2 = new FakeTransport();
    transport2.onQuickAnswer = () => {
      throw 'not an Error';
    };
    const t2 = await setup({ quickAnswers: true }, transport2);
    expect(await t2.finished()).toMatchObject({ status: 'failed', detail: 'internal_error: not an Error' });
  });

  it('ended while the link was being signed: no link is handed out', async () => {
    const transport = new FakeTransport();
    const holder: { s?: { cancel(d: string): void } } = {};
    transport.onStatus = () => holder.s!.cancel('engine_closed');
    const unpublish = transport.unpublish.bind(transport);
    transport.unpublish = (id) => unpublish(id).then(() => Promise.reject(new Error('relay gone'))); // still ends cleanly
    const links: LinkInfo[] = [];
    const s = runAsk({ transport, key: await importSecret(newSecret()), now: () => Date.now() }, { question: 'Q?', allowText: true, timeoutS: 600, quickAnswers: true, onLink: (l) => links.push(l) });
    holder.s = s;
    await settle();
    expect(await s.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed', url: '' });
    expect(links).toHaveLength(0);
    expect(transport.published.size).toBe(0);
  });

  it('ending twice keeps the first end; the relay coming back with the viewer still there changes nothing', async () => {
    const t = await setup();
    const v = await t.join({ vn: 'abcdefghijklmnop' });
    expect(v.json()[0]).toMatchObject({ t: 'ready', vn: 'abcdefghijklmnop' });
    t.transport.setStatus(t.id(), 'down');
    t.transport.setStatus(t.id(), 'up');
    v.push({ t: 'answer', choice: 0 });
    await settle();
    t.session.cancel('too_late');
    t.session.fail('too_late');
    expect(await t.finished()).toMatchObject({ status: 'answered', answer: { choice: 0, label: 'Yes' } });
  });
});

describe('checkAsk', () => {
  const ok = { question: 'Ship it?' };
  it('accepts a plain question, choices, details and timeouts at the limits', () => {
    expect(checkAsk(ok)).toBeNull();
    expect(checkAsk({ question: 'q'.repeat(300), choices: ['a', 'b'], details: 'd'.repeat(1000), timeoutS: 10 })).toBeNull();
    expect(checkAsk({ ...ok, choices: ['1', '2', '3', '4', '5', 'x'.repeat(80)], timeoutS: 3600 })).toBeNull();
    expect(ASK_LIMITS).toEqual({ question: 300, choices: { min: 2, max: 6, label: 80 }, details: 1000, timeoutS: { min: 10, max: 3600 } });
  });

  it('checkAsk rejects 7 choices, an 81-char label, a 301-char question', () => {
    const choices = 'choices must be 2-6 labels of at most 80 characters';
    expect(checkAsk({ ...ok, choices: ['1', '2', '3', '4', '5', '6', '7'] })).toBe(choices);
    expect(checkAsk({ ...ok, choices: ['a', 'x'.repeat(81)] })).toBe(choices);
    expect(checkAsk({ question: 'q'.repeat(301) })).toBe('question must be 1-300 characters');
  });

  it('a question needs choices or allowText', () => {
    const msg = 'a question needs choices or allowText';
    expect(checkAsk({ ...ok, allowText: false })).toBe(msg);
    expect(checkAsk({ ...ok, allowText: true })).toBeNull();
    expect(checkAsk({ ...ok, choices: ['a', 'b'], allowText: false })).toBeNull();
    expect(checkAsk({ ...ok, choices: ['a', 'b'] })).toBeNull();
  });

  it('rejects every other out-of-range or mistyped field', () => {
    const question = 'question must be 1-300 characters';
    const choices = 'choices must be 2-6 labels of at most 80 characters';
    const details = 'details must be at most 1000 characters';
    const timeout = 'timeoutS must be 10-3600';
    const bad = (p: object) => checkAsk(p as never);
    expect(bad({ question: '' })).toBe(question);
    expect(bad({ question: '   ' })).toBe(question);
    expect(bad({})).toBe(question);
    expect(bad({ question: 7 })).toBe(question);
    expect(bad({ ...ok, choices: ['only'] })).toBe(choices);
    expect(bad({ ...ok, choices: [] })).toBe(choices);
    expect(bad({ ...ok, choices: ['a', ''] })).toBe(choices);
    expect(bad({ ...ok, choices: ['a', 2] })).toBe(choices);
    expect(bad({ ...ok, choices: 'a,b' })).toBe(choices);
    expect(bad({ ...ok, details: 'd'.repeat(1001) })).toBe(details);
    expect(bad({ ...ok, details: 5 })).toBe(details);
    expect(bad({ ...ok, timeoutS: 9 })).toBe(timeout);
    expect(bad({ ...ok, timeoutS: 3601 })).toBe(timeout);
    expect(bad({ ...ok, timeoutS: Number.NaN })).toBe(timeout);
    expect(bad({ ...ok, timeoutS: '60' })).toBe(timeout);
  });
});
