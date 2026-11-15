import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { attachPage, PageClosedError } from '../src/attach';
import { launch } from './helpers';
import type { Browser } from './helpers';

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});

describe('attachPage', () => {
  it('attaches to a Playwright page and sends CDP commands', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    expect(a.pageId).toMatch(/^[a-z0-9-]{8,}$/);
    await expect(a.send('Runtime.evaluate', { expression: '1+1', returnByValue: true })).resolves.toMatchObject({ result: { value: 2 } });
    await a.detach();
    await page.close();
  });

  it('subscribes to CDP events', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    const got = vi.fn();
    a.subscribe('Runtime.consoleAPICalled', got);
    await a.send('Runtime.enable');
    await page.evaluate(() => console.log('hi'));
    await vi.waitFor(() => expect(got).toHaveBeenCalled());
    await a.detach();
    await page.close();
  });

  it('reports page close once', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    const closed = vi.fn();
    a.onClose(closed);
    await page.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith('page closed'));
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(a.detach()).resolves.toBeUndefined();
  });

  it('Final I6: onClose registered after the page closed fires immediately', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    await page.close();
    const late = vi.fn();
    a.onClose(late);
    expect(late).toHaveBeenCalledWith('page closed');
    await a.detach();
  });

  it('Final I6: attaching to an already-closed page reports PageClosedError', async () => {
    const page = await browser.newPage();
    await page.close();
    await expect(attachPage(page)).rejects.toBeInstanceOf(PageClosedError);
  });

  it('reports a page crash', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    const closed = vi.fn();
    a.onClose(closed);
    (page as unknown as { emit(e: string): void }).emit('crash');
    expect(closed).toHaveBeenCalledWith('page crashed');
    await a.detach();
    await page.close();
  });

  it('supports Puppeteer-style pages (createCDPSession)', async () => {
    const listeners: Record<string, (p: unknown) => void> = {};
    const pageListeners: Record<string, () => void> = {};
    const session = {
      send: vi.fn(async (m: string) => ({ ok: m })),
      on: (e: string, cb: (p: unknown) => void) => void (listeners[e] = cb),
      detach: vi.fn(async () => {}),
    };
    const page = { createCDPSession: async () => session, on: (e: string, cb: () => void) => void (pageListeners[e] = cb), off: vi.fn(), url: () => 'https://x.test/' };
    const a = await attachPage(page);
    await expect(a.send('Page.enable')).resolves.toEqual({ ok: 'Page.enable' });
    const got = vi.fn();
    a.subscribe('Page.screencastFrame', got);
    listeners['Page.screencastFrame']!({ n: 1 });
    expect(got).toHaveBeenCalledWith({ n: 1 });
    const closed = vi.fn();
    a.onClose(closed);
    pageListeners.close!();
    expect(closed).toHaveBeenCalledWith('page closed');
    await a.detach();
    expect(session.detach).toHaveBeenCalled();
  });

  it('a session that fails to open: page closed meanwhile → PageClosedError; otherwise the error itself', async () => {
    let closed = false;
    const page = { createCDPSession: async () => { throw new Error('boom'); }, isClosed: () => closed, on: () => {} };
    await expect(attachPage(page)).rejects.toThrow('boom');
    const closing = { createCDPSession: async () => { closed = true; throw new Error('Target closed'); }, isClosed: () => closed, on: () => {} };
    closed = false;
    await expect(attachPage(closing)).rejects.toBeInstanceOf(PageClosedError);
  });

  it('a crash followed by close reports once, with the first reason; a page without url() reports an empty one', async () => {
    const pageListeners: Record<string, () => void> = {};
    const session = { send: vi.fn(), on: () => {}, detach: vi.fn(async () => {}) };
    const page = { createCDPSession: async () => session, on: (e: string, cb: () => void) => void (pageListeners[e] = cb) };
    const a = await attachPage(page);
    const got = vi.fn();
    a.onClose(got);
    pageListeners.crash!();
    pageListeners.close!();
    expect(got.mock.calls).toEqual([['page crashed']]);
    expect(a.url()).toBe('');
  });

  describe('a dropped browser connection (page close never fires)', () => {
    /** A minimal event emitter like Puppeteer's: listeners keyed by string or symbol, with `emit`. */
    function emitter() {
      const map = new Map<string | symbol, Set<(p?: unknown) => void>>();
      return {
        map,
        on(e: string | symbol, cb: (p?: unknown) => void) {
          (map.get(e) ?? map.set(e, new Set()).get(e)!).add(cb);
          return this;
        },
        off(e: string | symbol, cb: (p?: unknown) => void) {
          map.get(e)?.delete(cb);
          return this;
        },
        emit(e: string | symbol, p?: unknown) {
          for (const cb of [...(map.get(e) ?? [])]) cb(p);
          return true;
        },
        count() {
          let n = 0;
          for (const s of map.values()) n += s.size;
          return n;
        },
      };
    }
    function puppeteerPage() {
      const session = Object.assign(emitter(), { send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) });
      const browser = emitter();
      const page = Object.assign(emitter(), { createCDPSession: async () => session, browser: () => browser, url: () => 'https://x.test/' });
      return { page, session, browser };
    }

    it('Puppeteer: the session emits the Disconnected symbol (current Puppeteer, @cloudflare/puppeteer)', async () => {
      const { page, session } = puppeteerPage();
      const a = await attachPage(page);
      const closed = vi.fn();
      a.onClose(closed);
      // A symbol of its own, like Puppeteer's CDPSessionEvent.Disconnected (never imported here).
      session.emit(Symbol('CDPSession.Disconnected'));
      expect(closed).toHaveBeenCalledWith('browser disconnected');
      session.emit(Symbol('CDPSession.Other'));
      expect(closed).toHaveBeenCalledTimes(1);
      await a.detach();
    });

    it('Puppeteer: the session emits the string event (older Puppeteer)', async () => {
      for (const event of ['CDPSession.Disconnected', 'Disconnected']) {
        const { page, session } = puppeteerPage();
        const a = await attachPage(page);
        const closed = vi.fn();
        a.onClose(closed);
        session.emit(event);
        expect(closed, event).toHaveBeenCalledWith('browser disconnected');
        await a.detach();
      }
    });

    it("Puppeteer: the browser emits 'disconnected'", async () => {
      const { page, browser } = puppeteerPage();
      const a = await attachPage(page);
      const closed = vi.fn();
      a.onClose(closed);
      browser.emit('disconnected');
      expect(closed).toHaveBeenCalledWith('browser disconnected');
      page.emit('close');
      expect(closed).toHaveBeenCalledTimes(1);
      await a.detach();
    });

    it("Playwright: the context's browser emits 'disconnected'", async () => {
      const session = Object.assign(emitter(), { send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) });
      const browser = emitter();
      const context = { newCDPSession: async () => session, browser: () => browser };
      const page = Object.assign(emitter(), { context: () => context, url: () => 'https://x.test/' });
      const a = await attachPage(page);
      const closed = vi.fn();
      a.onClose(closed);
      browser.emit('disconnected');
      expect(closed).toHaveBeenCalledWith('browser disconnected');
      await a.detach();
      expect(browser.count()).toBe(0);
    });

    it('a Playwright context without a browser (persistent context) still attaches', async () => {
      const session = Object.assign(emitter(), { send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) });
      const page = Object.assign(emitter(), { context: () => ({ newCDPSession: async () => session, browser: () => null }) });
      const a = await attachPage(page);
      await expect(a.detach()).resolves.toBeUndefined();
    });

    it('detach removes every listener and restores the session', async () => {
      const { page, session, browser } = puppeteerPage();
      const emit = session.emit;
      const a = await attachPage(page);
      expect(session.count() + browser.count() + page.count()).toBeGreaterThan(0);
      const closed = vi.fn();
      a.onClose(closed);
      await a.detach();
      expect(session.count()).toBe(0);
      expect(browser.count()).toBe(0);
      expect(page.count()).toBe(0);
      expect(session.emit).toBe(emit);
      expect(Object.prototype.hasOwnProperty.call(session, 'emit')).toBe(true);
      session.emit(Symbol('CDPSession.Disconnected'));
      browser.emit('disconnected');
      expect(closed).not.toHaveBeenCalled();
    });

    it("detach leaves an emit wrapped after ours (another library's) in place", async () => {
      const { page, session } = puppeteerPage();
      const a = await attachPage(page);
      const theirs = vi.fn();
      session.emit = theirs;
      await a.detach();
      expect(session.emit).toBe(theirs);
    });

    it('an emitter with removeListener instead of off is cleaned up too; an inherited emit is restored by removing ours', async () => {
      class Session {
        listeners = new Map<string | symbol, (p?: unknown) => void>();
        on(e: string | symbol, cb: (p?: unknown) => void) {
          this.listeners.set(e, cb);
        }
        removeListener(e: string | symbol) {
          this.listeners.delete(e);
        }
        emit(e: string | symbol) {
          this.listeners.get(e)?.();
        }
        send = vi.fn(async () => ({}));
        detach = vi.fn(async () => {});
      }
      const session = new Session();
      const page = { createCDPSession: async () => session, on: () => {} };
      const a = await attachPage(page);
      expect(Object.prototype.hasOwnProperty.call(session, 'emit')).toBe(true);
      await a.detach();
      expect(session.listeners.size).toBe(0);
      expect(Object.prototype.hasOwnProperty.call(session, 'emit')).toBe(false);
    });
  });

  it('rejects objects that are not pages', async () => {
    await expect(attachPage({})).rejects.toThrow(new TypeError('Unsupported page object: pass a Playwright or Puppeteer Page'));
    await expect(attachPage(null)).rejects.toThrow(TypeError);
  });
});
