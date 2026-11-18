import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AlertOutcome, CloudAlerter, CloudAlerterOptions, LinkInfo } from '@velmlabs/unstuck-core';
import type { AskResult } from '@velmlabs/unstuck-protocol';
import { FakeCdp, FakeTransport } from '@velmlabs/unstuck-core/testing';
import { settle } from '@velmlabs/unstuck-core/testing/settle';
import { InProcessUnstuck } from '../src/in-process';
import { Unstuck as EdgeUnstuck } from '../src/edge';
import { Unstuck, UnstuckConfigError } from '../src/index';
import type { TakeoverLink } from '../src/options';

const h = vi.hoisted(() => ({
  transports: [] as unknown[],
  alerterOptions: [] as unknown[],
  alerts: [] as { info: LinkInfo; site: string | undefined; extra: unknown }[],
  ends: [] as unknown[],
  askCalls: [] as unknown[],
  takeoverCalls: [] as unknown[],
}));
vi.mock('@velmlabs/unstuck-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@velmlabs/unstuck-core')>();
  const { FakeTransport } = await import('@velmlabs/unstuck-core/testing');
  return {
    ...actual,
    buildRelayTransport: vi.fn(() => {
      const t = new FakeTransport();
      h.transports.push(t);
      return t;
    }),
    createCloudAlerter: vi.fn((o: CloudAlerterOptions) => {
      h.alerterOptions.push(o);
      const alert = async (info: LinkInfo, site: string | undefined, extra?: unknown): Promise<AlertOutcome> => {
        h.alerts.push({ info, site, extra });
        return { delivered: 1 };
      };
      return Object.assign(alert, { end: async (e: unknown) => void h.ends.push(e) });
    }),
    createEngine: vi.fn((o: Parameters<typeof actual.createEngine>[0]) => {
      const engine = actual.createEngine(o);
      const ask = engine.ask.bind(engine);
      const takeover = engine.takeover.bind(engine);
      engine.ask = (call) => (h.askCalls.push(call), ask(call));
      engine.takeover = (cdp, call) => (h.takeoverCalls.push(call), takeover(cdp, call));
      return engine;
    }),
  };
});

const lastTransport = () => h.transports.at(-1) as FakeTransport;
const API = { apiKey: 'uk_live_secret' };

async function join(transport: FakeTransport, url: string) {
  const v = transport.connect(url);
  v.push({ t: 'hello', token: new URLSearchParams(new URL(url).hash.slice(1)).get('t')! });
  await settle();
  return v;
}

beforeEach(() => {
  for (const a of Object.values(h)) a.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InProcessUnstuck.ask', () => {
  it('answers through a fake relay transport and tells the alerter how it ended', async () => {
    const links: TakeoverLink[] = [];
    const u = new InProcessUnstuck({ ...API, onLink: (l) => links.push(l) }, {});
    let result: AskResult | undefined;
    void u.ask('Which plan?', { choices: ['Free', 'Pro'] }).then((r) => (result = r));
    await settle();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ reason: 'Which plan?', sessionId: expect.any(String) });
    const v = await join(lastTransport(), links[0]!.url);
    v.push({ t: 'answer', choice: 1 });
    await settle();
    expect(result).toMatchObject({ status: 'answered', answer: { choice: 1, label: 'Pro' }, via: 'page' });
    // Private by default: the alert carries no question; the end carries no label.
    expect(h.alerts[0]).toMatchObject({ info: { kind: 'question' }, site: undefined });
    expect(h.alerts[0]!.extra).toBeUndefined();
    expect(h.ends[0]).not.toHaveProperty('label');
    expect(h.askCalls[0]).toMatchObject({ question: 'Which plan?', choices: ['Free', 'Pro'] });
    await u.close();
  });

  it('private: false with choices sends the alert as a quick answer; a per-call onLink beats the option', async () => {
    const calls: string[] = [];
    const u = new InProcessUnstuck({ ...API, onLink: () => calls.push('option') }, {});
    void u.ask('Which plan?', { choices: ['Free', 'Pro'], private: false, onLink: () => calls.push('call') });
    await settle();
    expect(calls).toEqual(['call']);
    expect(h.alerts[0]!.extra).toEqual({ quick: { question: 'Which plan?', choices: ['Free', 'Pro'] } });
    await u.close();
  });

  it('private: false without choices is not a quick question', async () => {
    const u = new InProcessUnstuck({ ...API, onLink: () => {} }, {});
    void u.ask('Name?', { private: false });
    await settle();
    expect(h.alerts[0]!.extra).toBeUndefined();
    await u.close();
  });

  it('the default printer logs the link when no phone got the alert, and a short line when one did', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const u = new InProcessUnstuck(API, {});
    void u.ask('Q?');
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Unstuck: a human is needed \(Q\?\), link sent to 1 paired phone\(s\) \(session /));
    expect(log.mock.calls.join('')).not.toContain('http');
    await u.close();
    const selfHosted = new InProcessUnstuck({ relay: 'wss://relay.example', agentKey: 'k' }, {});
    log.mockClear();
    void selfHosted.ask('Q2?');
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Unstuck: a human is needed \(Q2\?\) → http:\/\/fake\.test\/s\//));
    await selfHosted.close();
  });

  it('rejects bad params with UnstuckConfigError (the checkAsk message) before anything else, even without a relay', async () => {
    const u = new InProcessUnstuck({}, {});
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    await expect(u.ask('Q?', { choices: seven })).rejects.toBeInstanceOf(UnstuckConfigError);
    await expect(u.ask('Q?', { choices: seven })).rejects.toThrow('choices must be 2-6 labels of at most 80 characters');
    expect(h.transports).toHaveLength(0);
    await expect(u.ask('Q?')).rejects.toThrow('in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey');
  });

  it('agentName reaches the alerter and engine.ask / engine.takeover (cleaned by the alerter and the engine); the env is the fallback', async () => {
    const u = new InProcessUnstuck({ ...API, agentName: 'Ava', onLink: () => {} }, {});
    expect(h.alerterOptions[0]).toMatchObject({ agentName: 'Ava' });
    void u.ask('Q?');
    await settle();
    expect(h.askCalls[0]).toMatchObject({ agentName: 'Ava' });
    const page = {
      url: () => 'https://shop.example/x',
      isClosed: () => false,
      on() {},
      off() {},
      createCDPSession: async () => ({ send: (m: string, p?: object) => new FakeCdp().send(m, p), on() {}, detach: async () => {} }),
    };
    void u.takeover(page, { reason: 'x', mode: 'approval', kind: 'approval', timeoutS: 77 });
    await settle();
    expect(h.takeoverCalls[0]).toMatchObject({ agentName: 'Ava', mode: 'approval', kind: 'approval', timeoutS: 77, site: 'shop.example' });
    await u.close();
    const viaEnv = new InProcessUnstuck(API, { UNSTUCK_AGENT_NAME: 'Envy' });
    expect(h.alerterOptions[1]).toMatchObject({ agentName: 'Envy' });
    await viaEnv.close();
  });

  it('a plain takeover reaches the engine with kind other and no mode', async () => {
    const u = new InProcessUnstuck({ ...API, onLink: () => {} }, {});
    const page = {
      url: () => 'https://shop.example/x',
      isClosed: () => false,
      on() {},
      off() {},
      createCDPSession: async () => ({ send: (m: string, p?: object) => new FakeCdp().send(m, p), on() {}, detach: async () => {} }),
    };
    void u.takeover(page, { reason: 'x' });
    await settle();
    expect(h.takeoverCalls[0]).toMatchObject({ kind: 'other' });
    expect(h.takeoverCalls[0]).not.toHaveProperty('mode');
    await u.close();
  });

  it('close() ends a question in flight with engine_closed', async () => {
    const u = new InProcessUnstuck({ ...API, onLink: () => {} }, {});
    let result: AskResult | undefined;
    void u.ask('Q?').then((r) => (result = r));
    await settle();
    await u.close();
    expect(result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
  });
});

describe('ask on the public classes', () => {
  it('edge and Node (in-process) Unstuck expose ask, edge also rejects bad params', async () => {
    const edge = new EdgeUnstuck(API);
    await expect(edge.ask('Q?', { choices: ['only one'] })).rejects.toBeInstanceOf(UnstuckConfigError);
    const node = new Unstuck({ ...API, mode: 'in-process', onLink: () => {} });
    void node.ask('Q?');
    void edge.ask('Q?');
    await settle();
    expect(h.askCalls).toHaveLength(2);
    await edge.close();
    await node.close();
  });
});
