import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AskResult } from '@velmlabs/unstuck-protocol';
import { FakeTransport } from '../src/testing';
import { createEngine, type AskCallOptions, type LinkInfo } from '../src/engine';
import { MemoryEventLog } from '../src/events';
import { settle } from './settle';

function setup(call: Partial<AskCallOptions> = {}, engineOpts: { requireCode?: boolean } = {}) {
  const transport = new FakeTransport();
  const log = new MemoryEventLog();
  const links: LinkInfo[] = [];
  const engine = createEngine({ transport, log, onLink: (l) => links.push(l), ...engineOpts });
  let result: AskResult | undefined;
  const done = engine.ask({ question: 'Which plan?', ...call }).then((r) => (result = r));
  const token = () => new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
  const join = async () => {
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token: token(), ...(links[0]!.code ? { code: links[0]!.code } : {}) });
    await settle();
    return v;
  };
  const finished = async () => {
    await settle();
    await done;
    return result!;
  };
  return { transport, log, links, engine, done, join, finished, result: () => result };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('engine.ask', () => {
  it('maps the session result to an AskResult (no url)', async () => {
    const t = setup({ choices: ['Free', 'Pro'], agentName: 'Ava' });
    await settle();
    expect(t.links[0]).toMatchObject({ reason: 'Which plan?', kind: 'question', mode: 'question' });
    const v = await t.join();
    expect(v.json()[1]).toEqual({ t: 'mode', mode: 'question', reason: 'Which plan?', site: '', agentName: 'Ava', question: { text: 'Which plan?', choices: ['Free', 'Pro'], allowText: false } });
    v.push({ t: 'answer', choice: 1 });
    const r = await t.finished();
    expect(r).toEqual({ status: 'answered', answer: { choice: 1, label: 'Pro' }, via: 'page', durationS: expect.any(Number), sessionId: t.links[0]!.sessionId });
  });

  it('defaults: typed text without choices, private, 600 s', async () => {
    const t = setup();
    await settle();
    expect(t.links[0]!.expiresAt - Date.now()).toBe(600_000);
    expect(t.transport.hasQuickAnswerHandler(t.links[0]!.sessionId)).toBe(false);
    const v = await t.join();
    expect(v.json()[1].question).toEqual({ text: 'Which plan?', allowText: true });
    v.push({ t: 'answer', text: 'The cheap one' });
    expect(await t.finished()).toMatchObject({ status: 'answered', answer: { text: 'The cheap one' } });
  });

  it('allowText can be turned on next to choices', async () => {
    const t = setup({ choices: ['Free', 'Pro'], allowText: true, details: 'Billing starts today.' });
    await settle();
    const v = await t.join();
    expect(v.json()[1].question).toEqual({ text: 'Which plan?', choices: ['Free', 'Pro'], allowText: true, details: 'Billing starts today.' });
    v.push({ t: 'answer', choice: 0, text: 'for now' });
    expect((await t.finished()).answer).toEqual({ choice: 0, label: 'Free', text: 'for now' });
  });

  it('quick answer ends it with via telegram when private: false', async () => {
    const t = setup({ choices: ['Free', 'Pro'], private: false });
    await settle();
    t.transport.quickAnswer(t.links[0]!.sessionId, 0);
    expect(await t.finished()).toMatchObject({ status: 'answered', answer: { choice: 0, label: 'Free' }, via: 'telegram' });
  });

  it('quick answer ignored when not opted in (private: true)', async () => {
    const t = setup({ choices: ['Free', 'Pro'], private: true, timeoutS: 10 });
    await settle();
    const id = t.links[0]!.sessionId;
    expect(t.transport.hasQuickAnswerHandler(id)).toBe(false);
    t.transport.quickAnswer(id, 0);
    await settle();
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await t.finished();
    expect(r).toEqual({ status: 'timed_out', durationS: 10, sessionId: id });
  });

  it('a call link handler replaces the engine one; the engine code default applies', async () => {
    const own: LinkInfo[] = [];
    const t = setup({ onLink: (l) => own.push(l) }, { requireCode: true });
    await settle();
    expect(t.links).toHaveLength(0);
    expect(own[0]!.code).toMatch(/^\d{6}$/);
    await t.engine.close();
    expect(await t.finished()).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
  });

  it('timeout ends timed_out; engine close ends cancelled engine_closed', async () => {
    const t = setup({ timeoutS: 30 });
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await t.finished()).toMatchObject({ status: 'timed_out' });

    const t2 = setup();
    await settle();
    const v = await t2.join();
    await t2.engine.close();
    const r = await t2.finished();
    expect(r).toMatchObject({ status: 'cancelled', detail: 'engine_closed', sessionId: t2.links[0]!.sessionId });
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'cancelled' });
    expect(t2.transport.closed).toBe(true);
    // Later questions end the same way without publishing.
    const later = await t2.engine.ask({ question: 'Still there?' });
    expect(later).toEqual({ status: 'cancelled', sessionId: '', durationS: 0, detail: 'engine_closed' });
    expect(t2.links).toHaveLength(1);
  });

  it('bad params reject with the checkAsk message as a TypeError, and publish nothing', async () => {
    const transport = new FakeTransport();
    const engine = createEngine({ transport });
    const p = engine.ask({ question: 'Pick', choices: ['1', '2', '3', '4', '5', '6', '7'] });
    await expect(p).rejects.toThrow(new TypeError('choices must be 2-6 labels of at most 80 characters'));
    await expect(p).rejects.toBeInstanceOf(TypeError);
    await expect(engine.ask({ question: 'q'.repeat(301) })).rejects.toThrow('question must be 1-300 characters');
    await expect(engine.ask({ question: 'ok', timeoutS: 5 })).rejects.toThrow('timeoutS must be 10-3600');
    expect(transport.published.size).toBe(0);
  });
});
