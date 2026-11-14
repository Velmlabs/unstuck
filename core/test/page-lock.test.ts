import { describe, it, expect } from 'vitest';
import { FakeCdp } from '../src/testing';
import { lockPage, safeInput, siteOf, urlAllowed } from '../src/session/page-lock';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('siteOf: the site a takeover page belongs to', () => {
  it('is the last two labels of the host', () => {
    expect(siteOf('shop.example.com')).toBe('example.com');
    expect(siteOf('a.b.example.com')).toBe('example.com');
    expect(siteOf('example.com')).toBe('example.com');
  });
  it('uses the public suffix list: country codes, hosting platforms and multi-tenant services are tenant-sized', () => {
    expect(siteOf('www.shop.co.uk')).toBe('shop.co.uk');
    expect(siteOf('me.github.io')).toBe('me.github.io');
    expect(siteOf('app.vercel.app')).toBe('app.vercel.app');
    expect(siteOf('x.y.workers.dev')).toBe('y.workers.dev');
    expect(siteOf('shop.co.at')).toBe('shop.co.at');
    expect(siteOf('a.b.run.app')).toBe('a.b.run.app'); // *.run.app is itself a public suffix
    expect(siteOf('store.myshopify.com')).toBe('store.myshopify.com');
  });
  it('is the exact host for IP addresses, localhost and single labels', () => {
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('[::1]')).toBe('[::1]');
    expect(siteOf('localhost')).toBe('localhost');
  });
  it('ignores case and a trailing dot', () => {
    expect(siteOf('WWW.Example.COM.')).toBe('example.com');
  });
});

describe('urlAllowed', () => {
  const allowed = ['example.com', 'accounts.google.com'];
  it('allows the site, its subdomains and listed sites over http(s)', () => {
    expect(urlAllowed('https://example.com/a', allowed)).toBe(true);
    expect(urlAllowed('https://login.example.com/a', allowed)).toBe(true);
    expect(urlAllowed('http://example.com:8080/', allowed)).toBe(true);
    expect(urlAllowed('https://accounts.google.com/o/oauth2', allowed)).toBe(true);
  });
  it('refuses other sites, look-alikes and parents of a listed host', () => {
    expect(urlAllowed('https://mail.google.com/', allowed)).toBe(false);
    expect(urlAllowed('https://google.com/', allowed)).toBe(false);
    expect(urlAllowed('https://evilexample.com/', allowed)).toBe(false);
    expect(urlAllowed('https://example.com.evil.net/', allowed)).toBe(false);
  });
  it('allows blank pages and blob URLs of an allowed origin; refuses data:, file:, javascript: and junk', () => {
    expect(urlAllowed('about:blank', allowed)).toBe(true);
    expect(urlAllowed('blob:https://example.com/0b6c', allowed)).toBe(true);
    expect(urlAllowed('blob:https://evil.net/0b6c', allowed)).toBe(false);
    expect(urlAllowed('data:text/html,hi', allowed)).toBe(false);
    expect(urlAllowed('file:///etc/passwd', allowed)).toBe(false);
    expect(urlAllowed('javascript:alert(1)', allowed)).toBe(false);
    expect(urlAllowed('not a url', allowed)).toBe(false);
  });
});

function page(url = 'https://shop.example.com/checkout') {
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN', url } } }));
  return cdp;
}

describe('lockPage', () => {
  it('intercepts document requests and blocks the top frame from leaving the allowed sites, without an error page', async () => {
    const cdp = page();
    const blocked: string[] = [];
    await lockPage(cdp, { allowedSites: ['accounts.google.com'], onBlocked: (u) => blocked.push(u) });
    expect(cdp.calls.find((c) => c.method === 'Fetch.enable')?.params).toEqual({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://mail.google.com/' } });
    cdp.emit('Fetch.requestPaused', { requestId: 'r2', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://www.example.com/next' } });
    cdp.emit('Fetch.requestPaused', { requestId: 'r3', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://accounts.google.com/signin' } });
    await settle();
    const fetches = cdp.calls.filter((c) => c.method.startsWith('Fetch.') && c.method !== 'Fetch.enable');
    expect(fetches).toEqual([
      { method: 'Fetch.failRequest', params: { requestId: 'r1', errorReason: 'Aborted' } },
      { method: 'Fetch.continueRequest', params: { requestId: 'r2' } },
      { method: 'Fetch.continueRequest', params: { requestId: 'r3' } },
    ]);
    expect(blocked).toEqual(['https://mail.google.com/']);
  });

  it('lets frames inside the page load anything (CAPTCHA widgets live in cross-site iframes)', async () => {
    const cdp = page();
    await lockPage(cdp, {});
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'IFRAME', resourceType: 'Document', request: { url: 'https://captcha-provider.net/widget' } });
    await settle();
    expect(cdp.calls.at(-1)).toEqual({ method: 'Fetch.continueRequest', params: { requestId: 'r1' } });
  });

  it('goes straight back if the top frame still lands on another site (e.g. history back from cache)', async () => {
    const cdp = page();
    const blocked: string[] = [];
    await lockPage(cdp, { onBlocked: (u) => blocked.push(u) });
    cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://shop.example.com/step2' } });
    cdp.emit('Page.frameNavigated', { frame: { id: 'SUB', parentId: 'MAIN', url: 'https://ads.net/' } });
    cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://bank.com/account' } });
    await settle();
    expect(cdp.calls.filter((c) => c.method === 'Page.navigate')).toEqual([{ method: 'Page.navigate', params: { url: 'https://shop.example.com/step2' } }]);
    expect(blocked).toEqual(['https://bank.com/account']);
  });

  it('a page that started on about:blank is locked to the agent-listed sites only', async () => {
    const cdp = page('about:blank');
    await lockPage(cdp, { allowedSites: ['example.org'] });
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://example.com/' } });
    cdp.emit('Fetch.requestPaused', { requestId: 'r2', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://example.org/' } });
    await settle();
    expect(cdp.calls.filter((c) => c.method.startsWith('Fetch.') && c.method !== 'Fetch.enable').map((c) => c.method)).toEqual(['Fetch.failRequest', 'Fetch.continueRequest']);
  });

  it('bypasses service workers while locked (they could serve an off-site page without a request), and never touches the agent\'s download setting; stop() undoes everything', async () => {
    const cdp = page();
    const lock = await lockPage(cdp, {});
    expect(cdp.calls.find((c) => c.method === 'Network.setBypassServiceWorker')?.params).toEqual({ bypass: true });
    expect(cdp.methods()).not.toContain('Page.setDownloadBehavior');
    await lock.stop();
    expect(cdp.methods().slice(-2)).toEqual(['Fetch.disable', 'Network.setBypassServiceWorker']);
    expect(cdp.calls.at(-1)?.params).toEqual({ bypass: false });
    expect(cdp.listenerCount('Fetch.requestPaused')).toBe(0);
    expect(cdp.listenerCount('Page.frameNavigated')).toBe(0);
    await lock.stop(); // twice is harmless
  });

  it('never leaves a request hanging when CDP calls fail, and a failing download setting does not stop the lock', async () => {
    const cdp = page();
    cdp.respond('Network.setBypassServiceWorker', () => {
      throw new Error('not supported');
    });
    cdp.respond('Fetch.continueRequest', () => {
      throw new Error('gone');
    });
    await lockPage(cdp, {});
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://example.com/' } });
    await settle();
    expect(cdp.methods()).toContain('Fetch.continueRequest');
  });

  it('a page whose frame tree cannot be read is still locked (to the listed sites) and every top-frame request is checked', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Page.getFrameTree', () => {
      throw new Error('detached');
    });
    await lockPage(cdp, { allowedSites: ['example.com'] });
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', resourceType: 'Document', request: { url: 'https://evil.net/' } });
    await settle();
    expect(cdp.calls.at(-1)).toEqual({ method: 'Fetch.failRequest', params: { requestId: 'r1', errorReason: 'Aborted' } });
  });
});

describe('popups', () => {
  it('a popup is locked to the given sites only: it never gets the site it happens to open on', async () => {
    const cdp = page('about:blank');
    await lockPage(cdp, { allowedSites: ['example.com'], ownSite: false });
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://mail.google.com/' } });
    cdp.emit('Fetch.requestPaused', { requestId: 'r2', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://www.example.com/ok' } });
    await settle();
    expect(cdp.calls.filter((c) => c.method.startsWith('Fetch.') && c.method !== 'Fetch.enable').map((c) => c.method)).toEqual(['Fetch.failRequest', 'Fetch.continueRequest']);
  });
  it('reports whether the page is already somewhere it may not be', async () => {
    expect((await lockPage(page('https://mail.google.com/'), { allowedSites: ['example.com'], ownSite: false })).onAllowedPage).toBe(false);
    expect((await lockPage(page('about:blank'), { allowedSites: ['example.com'], ownSite: false })).onAllowedPage).toBe(true);
    expect((await lockPage(page('https://a.example.com/'), { allowedSites: ['example.com'], ownSite: false })).onAllowedPage).toBe(true);
  });
});

describe('safeInput: what a link holder may send to the page', () => {
  const mouse = (button: 'left' | 'right' | 'middle' | 'none', modifiers: number) => ({ t: 'mouse' as const, action: 'down' as const, x: 1, y: 2, button, clickCount: 1, modifiers });
  it('plain left clicks and moves pass; modifiers are removed from clicks (Ctrl/Cmd/Shift/Alt-click open tabs, windows, downloads)', () => {
    expect(safeInput(mouse('left', 0))).toEqual(mouse('left', 0));
    expect(safeInput(mouse('left', 2 | 4 | 8 | 1))).toEqual(mouse('left', 0));
    expect(safeInput(mouse('none', 8))).toEqual(mouse('none', 0));
  });
  it('middle and right clicks are dropped (new tab, context menu)', () => {
    expect(safeInput(mouse('middle', 0))).toBeNull();
    expect(safeInput(mouse('right', 0))).toBeNull();
  });
  it('browser history keys are dropped; everything else passes untouched', () => {
    const key = (k: string, modifiers = 0) => ({ t: 'key' as const, action: 'down' as const, key: k, code: k, modifiers });
    expect(safeInput(key('BrowserBack'))).toBeNull();
    expect(safeInput(key('BrowserForward'))).toBeNull();
    expect(safeInput(key('ArrowLeft', 1))).toBeNull(); // Alt+Left: back
    expect(safeInput(key('ArrowRight', 1))).toBeNull();
    expect(safeInput(key('[', 4))).toBeNull(); // Cmd+[: back (macOS)
    expect(safeInput(key(']', 4))).toBeNull();
    expect(safeInput(key('ArrowLeft', 4))).toEqual(key('ArrowLeft', 4)); // Cmd+Left in a field: line start
    expect(safeInput(key('a'))).toEqual(key('a'));
    // On a focused link, Ctrl/Shift/Cmd/Alt+Enter or Space open it in another tab or window: sent without modifiers.
    for (const m of [1, 2, 4, 8, 2 | 8]) {
      expect(safeInput(key('Enter', m))).toEqual(key('Enter'));
      expect(safeInput(key(' ', m))).toEqual(key(' '));
    }
    expect(safeInput(key('ContextMenu'))).toBeNull();
    expect(safeInput(key('F10', 8))).toBeNull(); // Shift+F10: context menu
    expect(safeInput(key('A', 8))).toEqual(key('A', 8)); // Shift+letter stays
    const text = { t: 'text' as const, text: 'x' };
    expect(safeInput(text)).toBe(text);
  });
});
