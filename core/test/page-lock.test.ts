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
  it('keeps three labels under shared suffixes (country codes and hosting platforms)', () => {
    expect(siteOf('www.shop.co.uk')).toBe('shop.co.uk');
    expect(siteOf('me.github.io')).toBe('me.github.io');
    expect(siteOf('app.vercel.app')).toBe('app.vercel.app');
    expect(siteOf('x.y.workers.dev')).toBe('y.workers.dev');
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

  it('denies downloads while locked, and stop() undoes everything', async () => {
    const cdp = page();
    const lock = await lockPage(cdp, {});
    expect(cdp.calls.find((c) => c.method === 'Page.setDownloadBehavior')?.params).toEqual({ behavior: 'deny' });
    await lock.stop();
    expect(cdp.methods().slice(-2)).toEqual(['Fetch.disable', 'Page.setDownloadBehavior']);
    expect(cdp.calls.at(-1)?.params).toEqual({ behavior: 'default' });
    expect(cdp.listenerCount('Fetch.requestPaused')).toBe(0);
    expect(cdp.listenerCount('Page.frameNavigated')).toBe(0);
    await lock.stop(); // twice is harmless
  });

  it('never leaves a request hanging when CDP calls fail, and a failing download setting does not stop the lock', async () => {
    const cdp = page();
    cdp.respond('Page.setDownloadBehavior', () => {
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

describe('lockPage for popups (adoptFirstSite)', () => {
  it('a popup opened on about:blank adopts the site of its first page, then is locked to it', async () => {
    const cdp = page('about:blank');
    await lockPage(cdp, { adoptFirstSite: true });
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://pay.provider.com/3ds' } });
    cdp.emit('Fetch.requestPaused', { requestId: 'r2', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://www.provider.com/ok' } });
    cdp.emit('Fetch.requestPaused', { requestId: 'r3', frameId: 'MAIN', resourceType: 'Document', request: { url: 'https://evil.net/' } });
    await settle();
    expect(cdp.calls.filter((c) => c.method.startsWith('Fetch.') && c.method !== 'Fetch.enable').map((c) => c.method)).toEqual(['Fetch.continueRequest', 'Fetch.continueRequest', 'Fetch.failRequest']);
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
    const text = { t: 'text' as const, text: 'x' };
    expect(safeInput(text)).toBe(text);
  });
});
