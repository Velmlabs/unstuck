import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRelayTransport, createEngine, CLOUD_RELAY_URL, type TakeoverCallOptions } from '@velmlabs/unstuck-core';
import { FakeCdp, FakeTransport } from '@velmlabs/unstuck-core/testing';
import { exportDevicePublicKey, newDeviceKeyPair, type TakeoverResult } from '@velmlabs/unstuck-protocol';
import { settle } from '@velmlabs/unstuck-core/testing/settle';
import { InProcessUnstuck } from '../src/in-process';
import { Unstuck, UnstuckConfigError } from '../src/index';
import type { TakeoverLink } from '../src/options';

// The relay is replaced by core's FakeTransport unless a test asks for the real one (h.real).
const h = vi.hoisted(() => ({ real: false, transports: [] as unknown[], calls: [] as unknown[], onCall: null as null | (() => void) }));
vi.mock('@velmlabs/unstuck-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@velmlabs/unstuck-core')>();
  const { FakeTransport } = await import('@velmlabs/unstuck-core/testing');
  return {
    ...actual,
    buildRelayTransport: vi.fn((...a: Parameters<typeof actual.buildRelayTransport>) => {
      const t = h.real ? actual.buildRelayTransport(...a) : new FakeTransport();
      h.transports.push(t);
      return t;
    }),
    createEngine: vi.fn((o: Parameters<typeof actual.createEngine>[0]) => {
      const engine = actual.createEngine(o);
      const takeover = engine.takeover.bind(engine);
      engine.takeover = (cdp, call) => {
        h.calls.push(call);
        const result = takeover(cdp, call);
        h.onCall?.();
        return result;
      };
      return engine;
    }),
  };
});

/** A Puppeteer-shaped page whose CDP session is a FakeCdp. */
class FakePage {
  readonly cdp = new FakeCdp();
  closed = false;
  detached = 0;
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>();
  constructor(private readonly href = 'https://shop.example/cart') {}
  url() {
    return this.href;
  }
  isClosed() {
    return this.closed;
  }
  async createCDPSession() {
    return { send: (m: string, p?: object) => this.cdp.send(m, p), on: (e: string, cb: (p: unknown) => void) => this.cdp.on(e, cb), detach: async () => void this.detached++ };
  }
  on(e: string, cb: (arg?: unknown) => void) {
    this.listeners.set(e, (this.listeners.get(e) ?? new Set()).add(cb));
  }
  off(e: string, cb: (arg?: unknown) => void) {
    this.listeners.get(e)?.delete(cb);
  }
  emit(e: string, arg?: unknown) {
    for (const cb of [...(this.listeners.get(e) ?? [])]) cb(arg);
  }
  listenerCount(e: string) {
    return this.listeners.get(e)?.size ?? 0;
  }
  close() {
    this.closed = true;
    this.cdp.close('page closed');
    this.emit('close');
  }
}

const API_ENV = { UNSTUCK_API_KEY: 'uk_live_secret' };
const lastTransport = () => h.transports.at(-1) as FakeTransport;
const keepAlives = (p: FakePage) => p.cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && (c.params as { expression: string }).expression === '0').length;

/** Joins as the human from a takeover link and waits for `ready`. */
async function join(transport: FakeTransport, url: string) {
  const v = transport.connect(url);
  v.push({ t: 'hello', token: new URLSearchParams(new URL(url).hash.slice(1)).get('t')! });
  await settle();
  expect(v.json()[0]).toMatchObject({ t: 'ready' });
  return v;
}

const box = (t: { box: { result?: TakeoverResult } }) => t.box.result;

function track(p: Promise<TakeoverResult>) {
  const box: { result?: TakeoverResult } = {};
  void p.then((r) => (box.result = r));
  return box;
}

beforeEach(() => {
  h.real = false;
  h.transports.length = 0;
  h.calls.length = 0;
  h.onCall = null;
  vi.mocked(buildRelayTransport).mockClear();
  vi.mocked(createEngine).mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('InProcessUnstuck', () => {
  it('throws UnstuckConfigError without a relay', async () => {
    const page = new FakePage();
    const p = new InProcessUnstuck({}, {}).takeover(page, { reason: 'x' });
    await expect(p).rejects.toThrow(UnstuckConfigError);
    await expect(p).rejects.toThrow('in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey');
    expect(buildRelayTransport).not.toHaveBeenCalled();
  });

  it('rejects inconsistent options at construction', () => {
    expect(() => new InProcessUnstuck({ apiKey: 'k', relay: 'wss://r.example' }, {})).toThrow(UnstuckConfigError);
  });

  it('resolves when the viewer presses Done, then detaches the page', async () => {
    const page = new FakePage();
    const links: TakeoverLink[] = [];
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', onLink: (l) => links.push(l), fetch: async () => Response.json({ devices: [] }) }, {});
    const box = track(u.takeover(page, { reason: 'Solve it' }));
    await settle();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ reason: 'Solve it', url: expect.stringMatching(/^http:\/\/fake\.test\/s\//), sessionId: expect.any(String), expiresAt: expect.any(Number) });
    expect(links[0]).not.toHaveProperty('code');
    const v = await join(lastTransport(), links[0]!.url);
    v.push({ t: 'done' });
    await settle();
    expect(box.result).toMatchObject({ status: 'resolved', sessionId: links[0]!.sessionId });
    expect(box.result!.durationS).toBeGreaterThanOrEqual(0);
    expect(page.detached).toBe(1);
    expect(page.listenerCount('popup')).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // keep-alive stopped
    // The engine gets the page's site, the timeout default from the options and the Cloud relay choice.
    expect(h.calls[0]).toMatchObject({ reason: 'Solve it', site: 'shop.example' });
    expect(vi.mocked(buildRelayTransport).mock.calls[0]![0]).toMatchObject({ kind: 'relay', url: CLOUD_RELAY_URL, source: 'UNSTUCK_API_KEY' });
    expect(vi.mocked(buildRelayTransport).mock.calls[0]![1]).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+/), env: { UNSTUCK_API_KEY: 'uk_live_secret' } });
    await u.close();
  });

  it('times out with timed_out', async () => {
    const page = new FakePage();
    const u = new InProcessUnstuck({ relay: 'wss://own.example', agentKey: 'ak', timeoutS: 5, onLink: () => {} }, {});
    const box = track(u.takeover(page, { reason: 'x', timeoutS: 2 }));
    await settle();
    expect(h.calls[0]).toMatchObject({ timeoutS: 2 });
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(box.result).toMatchObject({ status: 'timed_out' });
    await u.close();
  });

  it('timeoutS falls back to the client option', async () => {
    const u = new InProcessUnstuck({ relay: 'wss://own.example', timeoutS: 5, onLink: () => {} }, {});
    const box = track(u.takeover(new FakePage(), { reason: 'x' }));
    await settle();
    expect(h.calls[0]).toMatchObject({ timeoutS: 5 });
    await u.close();
    await settle();
    expect(box.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
  });

  it('default onLink logs the link with console.log and never the code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const u = new InProcessUnstuck({ relay: 'wss://own.example' }, {});
    void u.takeover(new FakePage(), { reason: 'Solve it' });
    await settle();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^Unstuck: a human is needed \(Solve it\) → http:\/\/fake\.test\/s\/[A-Za-z0-9_-]+#t=/);
    await u.close();
    // A code is never printed: requireCode without an onLink is refused, from the option or from the environment.
    await expect(u.takeover(new FakePage(), { reason: 'x', requireCode: true })).rejects.toThrow(TypeError);
    await expect(new InProcessUnstuck({ relay: 'wss://own.example', requireCode: true }, {}).takeover(new FakePage(), { reason: 'x' })).rejects.toThrow(/requireCode needs an onLink/);
    await expect(new InProcessUnstuck({ relay: 'wss://own.example' }, { UNSTUCK_REQUIRE_CODE: '1' }).takeover(new FakePage(), { reason: 'x' })).rejects.toThrow(/requireCode needs an onLink/);
  });

  it('an unknown kind or mode is refused before anything starts, like the engine does', async () => {
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    await expect(u.takeover(new FakePage(), { reason: 'x', kind: 'captcha' as never })).rejects.toThrow(new TypeError('kind must be one of challenge, approval, login, question, other'));
    await expect(u.takeover(new FakePage(), { reason: 'x', mode: 'watch' as never })).rejects.toThrow(new TypeError('mode must be control or approval'));
    await u.close();
  });

  it('requireCode hands the code to onLink, apart from the url', async () => {
    const links: TakeoverLink[] = [];
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: (l) => links.push(l) }, { UNSTUCK_REQUIRE_CODE: '1' });
    void u.takeover(new FakePage(), { reason: 'x' });
    await settle();
    expect(h.calls[0]).toMatchObject({ requireCode: true });
    expect(links[0]!.code).toMatch(/^\d{6}$/);
    expect(links[0]!.url).not.toContain(links[0]!.code);
    await u.close();
  });

  it('sends alerts with an apiKey and skips them with alerts: false', async () => {
    const fetch = vi.fn(async () => Response.json({ devices: [] }));
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', cloudApi: 'https://staging.example', onLink: () => {}, fetch }, {});
    void u.takeover(new FakePage(), { reason: 'x', alerts: false });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    void u.takeover(new FakePage(), { reason: 'x' });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['https://staging.example/api/v1/agent/devices', { headers: { Authorization: 'Bearer uk_live_secret' }, signal: expect.any(AbortSignal) }]);
    await u.close();
  });

  it('no alerts for a self-hosted relay', async () => {
    const fetch = vi.fn(async () => Response.json({ devices: [] }));
    const u = new InProcessUnstuck({ relay: 'wss://own.example', agentKey: 'ak', onLink: () => {}, fetch }, { UNSTUCK_API_KEY: 'uk_live_secret' });
    void u.takeover(new FakePage(), { reason: 'x' });
    await settle();
    expect(lastTransport().published.size).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    await u.close();
  });

  describe("alerts: 'required'", () => {
    const phone = async () => {
      const pair = await newDeviceKeyPair();
      return { id: 'd1', label: 'Pixel', publicKey: await exportDevicePublicKey(pair.publicKey) };
    };
    /** Cloud answering the devices lookup and the notify call. */
    const cloud = (devices: () => Response | Promise<Response>, notify: () => Response = () => new Response('', { status: 202 })) =>
      vi.fn(async (url: string) => (url.endsWith('/devices') ? devices() : notify())) as unknown as typeof fetch;
    const required = async (fetch: typeof globalThis.fetch) => {
      const lines: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((l: unknown) => void lines.push(String(l)));
      const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', onLink: () => {}, fetch }, {});
      const page = new FakePage();
      const box = track(u.takeover(page, { reason: 'x', alerts: 'required' }));
      await settle();
      return { u, box, page, lines };
    };

    it('no paired phone → failed/alert_failed at once, the link stops working', async () => {
      const t = await required(cloud(() => Response.json({ devices: [] })));
      expect(box(t)).toMatchObject({ status: 'failed', detail: 'alert_failed' });
      expect(lastTransport().unpublished).toHaveLength(1);
      expect(t.page.detached).toBe(1);
      await t.u.close();
    });
    it('notify answered 500 → failed/alert_failed', async () => {
      const p = await phone();
      const t = await required(cloud(() => Response.json({ devices: [p] }), () => new Response('', { status: 500 })));
      expect(box(t)).toMatchObject({ status: 'failed', detail: 'alert_failed' });
      for (const l of t.lines) expect(l).not.toContain('uk_live_secret');
      await t.u.close();
    });
    it('alerts not allowed for the key → failed/alert_failed', async () => {
      const t = await required(cloud(() => Response.json({ error: 'alerts_not_allowed' }, { status: 403 })));
      expect(box(t)).toMatchObject({ status: 'failed', detail: 'alert_failed' });
      await t.u.close();
    });
    it('delivered to one phone → the takeover goes on', async () => {
      const t = await required(cloud(async () => Response.json({ devices: [await phone()] })));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(box(t)).toBeUndefined();
      await t.u.close();
      await settle();
      expect(box(t)).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    });
    it('someone joined through onLink before the alert came back with no phone → the takeover goes on', async () => {
      let answer!: (r: Response) => void;
      const fetch = vi.fn(() => new Promise<Response>((r) => (answer = r))) as unknown as typeof globalThis.fetch;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const links: TakeoverLink[] = [];
      const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', onLink: (l) => links.push(l), fetch }, {});
      const r = track(u.takeover(new FakePage(), { reason: 'x', alerts: 'required' }));
      await settle();
      const v = await join(lastTransport(), links[0]!.url);
      answer(Response.json({ devices: [] }));
      await settle();
      expect(r.result).toBeUndefined();
      v.push({ t: 'done' });
      await settle();
      expect(r.result).toMatchObject({ status: 'resolved' });
      await u.close();
    });
    it('alerts: true (the default) with no phone keeps waiting, as before', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', onLink: () => {}, fetch: cloud(() => Response.json({ devices: [] })) }, {});
      const r = track(u.takeover(new FakePage(), { reason: 'x', alerts: true }));
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(r.result).toBeUndefined();
      await u.close();
    });
    it('a self-hosted relay has no phone alerts: UnstuckConfigError before the page is attached', async () => {
      const page = new FakePage();
      const attach = vi.spyOn(page, 'createCDPSession');
      const u = new InProcessUnstuck({ relay: 'wss://own.example', agentKey: 'ak', onLink: () => {} }, {});
      const p = u.takeover(page, { reason: 'x', alerts: 'required' });
      await expect(p).rejects.toThrow(UnstuckConfigError);
      await expect(p).rejects.toThrow("alerts: 'required' needs Unstuck Cloud (apiKey): a self-hosted relay sends no phone alerts");
      expect(attach).not.toHaveBeenCalled();
      expect(buildRelayTransport).not.toHaveBeenCalled();
    });
  });

  it('follows a popup opened during the takeover, and detaches it afterwards', async () => {
    const page = new FakePage();
    const links: TakeoverLink[] = [];
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: (l) => links.push(l) }, {});
    const box = track(u.takeover(page, { reason: 'x' }));
    await settle();
    const v = await join(lastTransport(), links[0]!.url);
    const popup = new FakePage('https://accounts.example/');
    page.emit('popup', popup);
    // A popup that is already gone is not followed and does no harm.
    const gone = new FakePage();
    gone.closed = true;
    page.emit('popup', gone);
    await settle();
    expect(popup.cdp.methods()).toContain('Page.startScreencast');
    v.push({ t: 'done' });
    await settle();
    expect(box.result).toMatchObject({ status: 'resolved' });
    expect(popup.detached).toBe(1);
    expect(page.listenerCount('popup')).toBe(0);
    await u.close();
  });

  it('a popup whose attach finishes after the takeover ended is detached at once', async () => {
    const page = new FakePage('not a url');
    const links: TakeoverLink[] = [];
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: (l) => links.push(l) }, {});
    const box = track(u.takeover(page, { reason: 'x' }));
    await settle();
    expect(h.calls[0]).toMatchObject({ site: undefined });
    const late = new FakePage();
    let attach!: () => void;
    const create = late.createCDPSession.bind(late);
    late.createCDPSession = () => new Promise((r) => (attach = () => r(create())));
    page.emit('popup', late);
    const v = await join(lastTransport(), links[0]!.url);
    v.push({ t: 'done' });
    await settle();
    expect(box.result).toMatchObject({ status: 'resolved' });
    attach();
    await settle();
    expect(late.detached).toBe(1);
    expect(late.cdp.methods()).toEqual([]);
    await u.close();
  });

  it('filters allowedSites through hostnames()', async () => {
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    void u.takeover(new FakePage(), { reason: 'x', allowedSites: ['com', 'accounts.google.com'] });
    await settle();
    expect((h.calls[0] as TakeoverCallOptions).allowedSites).toEqual(['accounts.google.com']);
    await u.close();
  });

  it('a page that is already closed → failed/page_closed without starting an engine', async () => {
    const page = new FakePage();
    page.closed = true;
    const u = new InProcessUnstuck({ relay: 'wss://own.example' }, {});
    await expect(u.takeover(page, { reason: 'x' })).resolves.toEqual({ status: 'failed', sessionId: '', url: '', durationS: 0, detail: 'page_closed' });
    await expect(u.takeover({}, { reason: 'x' })).rejects.toThrow(/Unsupported page object/);
  });

  // Review Focus
  it('page closed while the engine is starting → failed/page_closed, keep-alive stopped', async () => {
    const page = new FakePage();
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    const p = u.takeover(page, { reason: 'x' });
    // The CDP session exists (attached), the engine has not published yet.
    await vi.waitFor(() => expect(page.listenerCount('close')).toBe(1));
    page.close();
    const r = await p;
    expect(r).toMatchObject({ status: 'failed', detail: 'page_closed' });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(keepAlives(page)).toBe(0);
    expect(page.detached).toBe(1);
    await u.close();
  });

  it('pings the page every 60 s while waiting for the human', async () => {
    const page = new FakePage();
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    void u.takeover(page, { reason: 'x' });
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(keepAlives(page)).toBe(0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(keepAlives(page)).toBe(2);
    await u.close();
  });

  it('two concurrent takeovers share one engine; close() ends both with engine_closed', async () => {
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    const a = track(u.takeover(new FakePage(), { reason: 'a' }));
    const b = track(u.takeover(new FakePage(), { reason: 'b' }));
    await settle();
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(buildRelayTransport).toHaveBeenCalledTimes(1);
    expect(lastTransport().published.size).toBe(2);
    await u.close();
    await settle();
    expect(a.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    expect(b.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    expect(lastTransport().closed).toBe(true);
    // A later takeover gets a new engine.
    void u.takeover(new FakePage(), { reason: 'c' });
    await settle();
    expect(createEngine).toHaveBeenCalledTimes(2);
    await u.close();
    await expect(u.close()).resolves.toBeUndefined();
  });

  it('close() while the page is still attaching: the takeover ends with engine_closed and never starts an engine', async () => {
    const page = new FakePage();
    let attach!: () => void;
    const create = page.createCDPSession.bind(page);
    page.createCDPSession = () => new Promise((r) => (attach = () => r(create())));
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    const box = track(u.takeover(page, { reason: 'x' }));
    await settle();
    // close() does not wait for the attach (createCDPSession may never answer): the takeover ends at once.
    await u.close();
    await settle();
    expect(box.result).toEqual({ status: 'cancelled', sessionId: '', url: '', durationS: 0, detail: 'engine_closed' });
    expect(page.detached).toBe(0);
    attach(); // the attach finishes later: the page is let go at once
    await settle();
    expect(createEngine).not.toHaveBeenCalled();
    expect(page.detached).toBe(1);
    expect(page.listenerCount('popup')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The client still works afterwards.
    void u.takeover(new FakePage(), { reason: 'y' });
    await settle();
    expect(lastTransport().published.size).toBe(1);
    await u.close();
  });

  it('close() is not held up by a page whose createCDPSession never answers, nor by one that later fails', async () => {
    const hung = new FakePage();
    hung.createCDPSession = () => new Promise(() => {});
    const failing = new FakePage();
    let fail!: () => void;
    failing.createCDPSession = () => new Promise((_, reject) => (fail = () => reject(new Error('target closed'))));
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    const a = track(u.takeover(hung, { reason: 'a' }));
    const b = track(u.takeover(failing, { reason: 'b' }));
    await settle();
    await u.close();
    await settle();
    expect(a.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    expect(b.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    fail(); // no unhandled rejection
    await settle();
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('close() called from inside onLink (sync, or awaited in an async onLink) ends the takeover with engine_closed', async () => {
    for (const style of ['sync', 'awaited'] as const) {
      let closed: Promise<void> | null = null;
      let closedDone = false;
      const u: InProcessUnstuck = new InProcessUnstuck(
        {
          relay: 'wss://own.example',
          onLink:
            style === 'sync'
              ? () => void (closed = u.close().then(() => void (closedDone = true)))
              : async () => {
                  closed = u.close();
                  await closed;
                  closedDone = true;
                },
        },
        {},
      );
      const page = new FakePage();
      const result = await u.takeover(page, { reason: 'x' });
      expect(result, style).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
      await closed;
      await settle();
      expect(closedDone, style).toBe(true);
      expect(page.detached, style).toBe(1);
      expect(lastTransport().closed, style).toBe(true);
      expect(lastTransport().published.size, style).toBe(0);
      expect(vi.getTimerCount(), style).toBe(0);
    }
  });

  it('close() right after the engine got the takeover still cancels it (nothing published, nothing left running)', async () => {
    const page = new FakePage();
    const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: () => {} }, {});
    let closing!: Promise<void>;
    h.onCall = () => (closing = u.close()); // engine.takeover has started and is awaiting its key
    const box = track(u.takeover(page, { reason: 'x' }));
    await vi.waitFor(() => expect(closing).toBeDefined());
    await closing;
    expect(box.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    expect(lastTransport().published.size).toBe(0);
    expect(lastTransport().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('relay_unauthorized → failed/relay_unauthorized and one console.error line without the key', async () => {
    h.real = true;
    RefusingWs.opened = 0;
    vi.stubGlobal('WebSocket', RefusingWs);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', cloudRelay: 'ws://127.0.0.1:1', onLink: () => {} }, {});
    const box = track(u.takeover(new FakePage(), { reason: 'x' }));
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(box.result).toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
    expect(error.mock.calls).toEqual([['[unstuck] unstuck.sh rejected the API key: check the key in your dashboard']]);
    expect(error.mock.calls.flat().join()).not.toContain('uk_live_secret');
    // The relay transport keeps no state from a refused publish: the next takeover on the same engine asks the relay
    // again (a fixed key may now be accepted) and, refused again, says so again.
    const again = track(u.takeover(new FakePage(), { reason: 'y' }));
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(again.result).toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(RefusingWs.opened).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await u.close();
  });

  it('a rejecting keep-alive ping is swallowed', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const page = new FakePage();
      page.cdp.respond('Runtime.evaluate', (p) => ((p as { expression: string }).expression === '0' ? Promise.reject(new Error('target closed')) : {}));
      const links: TakeoverLink[] = [];
      const u = new InProcessUnstuck({ relay: 'wss://own.example', onLink: (l) => links.push(l) }, {});
      const box = track(u.takeover(page, { reason: 'x' }));
      await settle();
      await vi.advanceTimersByTimeAsync(120_000);
      await settle();
      expect(keepAlives(page)).toBe(2);
      const v = await join(lastTransport(), links[0]!.url);
      v.push({ t: 'done' });
      await settle();
      expect(box.result).toMatchObject({ status: 'resolved' });
      expect(unhandled).not.toHaveBeenCalled();
      await u.close();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('link handlers and the phone alert', () => {
  const phone = async () => {
    const pair = await newDeviceKeyPair();
    return { id: 'd1', label: 'Pixel', publicKey: await exportDevicePublicKey(pair.publicKey) };
  };
  const cloud = (devices: () => Response | Promise<Response>) =>
    vi.fn(async (url: string) => (url.endsWith('/devices') ? devices() : new Response('', { status: 202 }))) as unknown as typeof fetch;
  const logs = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => void out.push(String(l)));
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void err.push(String(l)));
    return { out, err };
  };
  const LINK = /http:\/\/fake\.test\/s\/[A-Za-z0-9_-]+#t=/;

  it('a throwing onLink: the alert is still sent, one console.error line without the link, the takeover goes on', async () => {
    const l = logs();
    const fetch = cloud(async () => Response.json({ devices: [await phone()] }));
    let url = '';
    const u = new InProcessUnstuck(
      {
        apiKey: 'uk_live_secret',
        fetch,
        onLink: (link) => {
          url = link.url;
          throw new Error(`could not post ${link.url} (secret ${link.url.split('#')[1]})`);
        },
      },
      {},
    );
    const r = track(u.takeover(new FakePage(), { reason: 'x' }));
    await settle();
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual(['https://unstuck.sh/api/v1/agent/devices', 'https://unstuck.sh/api/v1/agent/notify']);
    const threw = l.err.filter((e) => e.includes('onLink'));
    expect(threw).toHaveLength(1);
    expect(threw[0]).toMatch(/^Unstuck: your onLink handler threw \(could not post <link> \(secret <link secret>\)\); the takeover goes on \(session [A-Za-z0-9_-]+\)$/);
    for (const e of l.err) expect(e).not.toContain(url.split('#')[1]);
    expect(r.result).toBeUndefined();
    await join(lastTransport(), url);
    await u.close();
  });

  it("a throwing onLink with alerts: 'required' and no paired phone still fails at once with alert_failed", async () => {
    const l = logs();
    const u = new InProcessUnstuck(
      {
        apiKey: 'uk_live_secret',
        fetch: cloud(() => Response.json({ devices: [] })),
        onLink: () => {
          throw 'not an Error';
        },
      },
      {},
    );
    const r = track(u.takeover(new FakePage(), { reason: 'x', alerts: 'required' }));
    await settle();
    expect(r.result).toMatchObject({ status: 'failed', detail: 'alert_failed' });
    expect(l.err.filter((e) => e.includes('onLink'))).toEqual([expect.stringMatching(/^Unstuck: your onLink handler threw \(not an Error\);/)]);
    await u.close();
  });

  it('an async onLink that rejects: one redacted console.error line, no unhandled rejection, the takeover goes on', async () => {
    const l = logs();
    let url = '';
    const u = new InProcessUnstuck(
      {
        relay: 'wss://own.example',
        onLink: async (link) => {
          url = link.url;
          throw new Error(`webhook refused token ${new URLSearchParams(link.url.split('#')[1]).get('t')}`);
        },
      },
      {},
    );
    const r = track(u.takeover(new FakePage(), { reason: 'x' }));
    await settle();
    expect(l.err).toEqual([expect.stringMatching(/^Unstuck: your onLink handler threw \(webhook refused token <link secret>\); the takeover goes on \(session [A-Za-z0-9_-]+\)$/)]);
    expect(r.result).toBeUndefined();
    await join(lastTransport(), url);
    await u.close();
  });

  it('default handler, alert delivered: one line naming the phones and the session, never the link', async () => {
    const l = logs();
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', fetch: cloud(async () => Response.json({ devices: [await phone()] })) }, {});
    void u.takeover(new FakePage(), { reason: 'Solve it' });
    await settle();
    expect(l.out).toEqual([expect.stringMatching(/^Unstuck: a human is needed \(Solve it\), link sent to 1 paired phone\(s\) \(session [A-Za-z0-9_-]+\)$/)]);
    const sessionId = (lastTransport().published.keys().next().value as string);
    expect(l.out[0]).toContain(`(session ${sessionId})`);
    for (const line of [...l.out, ...l.err]) expect(line).not.toMatch(/#t=/);
    await u.close();
  });

  it('default handler, no phone got it (alerts on): the full link is logged as the fallback', async () => {
    const l = logs();
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', fetch: cloud(() => Response.json({ devices: [] })) }, {});
    const r = track(u.takeover(new FakePage(), { reason: 'Solve it' }));
    await settle();
    expect(l.out).toEqual([expect.stringMatching(/^Unstuck: a human is needed \(Solve it\) → /)]);
    expect(l.out[0]).toMatch(LINK);
    expect(r.result).toBeUndefined();
    await u.close();
  });

  it("default handler, 'required' and no phone: the takeover failed (alert_failed), so the link is not logged", async () => {
    const l = logs();
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', fetch: cloud(() => Response.json({ devices: [] })) }, {});
    const r = track(u.takeover(new FakePage(), { reason: 'x', alerts: 'required' }));
    await settle();
    expect(r.result).toMatchObject({ status: 'failed', detail: 'alert_failed' });
    expect(l.out).toEqual([]);
    await u.close();
  });

  it('default handler with alerts: false: the log is the only channel, the full link is logged at once', async () => {
    const l = logs();
    const fetch = cloud(() => Response.json({ devices: [] }));
    const u = new InProcessUnstuck({ apiKey: 'uk_live_secret', fetch }, {});
    void u.takeover(new FakePage(), { reason: 'x', alerts: false });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(l.out).toEqual([expect.stringMatching(LINK)]);
    await u.close();
  });
});

describe('Node Unstuck with mode: in-process', () => {
  it('without a relay: UnstuckConfigError that names in-process mode (not a Worker)', async () => {
    vi.stubEnv('UNSTUCK_RELAY_URL', '');
    vi.stubEnv('UNSTUCK_API_KEY', '');
    const p = new Unstuck({ mode: 'in-process' }).takeover(new FakePage(), { reason: 'x' });
    await expect(p).rejects.toThrow(UnstuckConfigError);
    await expect(p).rejects.toThrow('in-process mode needs a relay: set apiKey or relay + agentKey');
  });

  it('Node: mode in-process uses process.env as fallback', async () => {
    vi.stubEnv('UNSTUCK_RELAY_URL', '');
    vi.stubEnv('UNSTUCK_AGENT_KEY', '');
    vi.stubEnv('UNSTUCK_API_KEY', 'uk_live_secret');
    const links: TakeoverLink[] = [];
    const u = new Unstuck({ mode: 'in-process', onLink: (l) => links.push(l), fetch: async () => Response.json({ devices: [] }) });
    const box = track(u.takeover(new FakePage(), { reason: 'x' }));
    await settle();
    expect(links).toHaveLength(1);
    expect(vi.mocked(buildRelayTransport).mock.calls[0]![0]).toEqual({ kind: 'relay', url: CLOUD_RELAY_URL, agentKey: 'uk_live_secret', source: 'UNSTUCK_API_KEY' });
    await u.close();
    await settle();
    expect(box.result).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
  });
});

/** A relay that refuses the key (close code 4401) as soon as the agent socket opens. */
class RefusingWs {
  static opened = 0;
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    RefusingWs.opened++;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      this.close(4401);
    });
  }
  send() {}
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}
