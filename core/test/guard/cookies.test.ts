import { describe, it, expect } from 'vitest';
import { readCookies, setMissingCookies, deleteCookies, cookieHeader, sessionFor } from '../../src/guard/cookies';
import { FakeCdp } from '../../src/testing/fake-cdp';
import { cookie } from '../store-conformance';

const live = [
  { name: 'sid', value: 'live', domain: 'shop.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', size: 7, session: true },
  { name: 'cf', value: 'y', domain: '.www.shop.example', path: '/', expires: 2e9, httpOnly: false, secure: true },
  { name: 'other', value: 'z', domain: 'other.example', path: '/', expires: -1, httpOnly: false, secure: false },
  { name: 'evil', value: 'z', domain: 'notshop.example', path: '/', expires: -1, httpOnly: false, secure: false },
];

describe('cookies over CDP', () => {
  it('reads only the site and its subdomains, as StoredCookies', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Storage.getCookies', () => ({ cookies: live }));
    expect(await readCookies(cdp, 'shop.example')).toEqual([
      { name: 'sid', value: 'live', domain: 'shop.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'cf', value: 'y', domain: '.www.shop.example', path: '/', expires: 2e9, httpOnly: false, secure: true },
    ]);
  });

  it("prefers Network.getAllCookies: on a page's session it reads that page's own browser context", async () => {
    const cdp = new FakeCdp();
    // Storage.getCookies on a page session answers for the browser's default context, not the page's.
    cdp.respond('Storage.getCookies', () => ({ cookies: [] }));
    cdp.respond('Network.getAllCookies', () => ({ cookies: live }));
    expect((await readCookies(cdp, 'shop.example')).map((c) => c.name)).toEqual(['sid', 'cf']);
  });

  it('falls back to Storage.getCookies when Network.getAllCookies is refused', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Network.getAllCookies', () => {
      throw new Error("'Network.getAllCookies' wasn't found");
    });
    cdp.respond('Storage.getCookies', () => ({ cookies: live }));
    expect((await readCookies(cdp, 'shop.example')).map((c) => c.name)).toEqual(['sid', 'cf']);
  });

  it('falls back to Network.getAllCookies when Storage.getCookies is refused', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Storage.getCookies', () => {
      throw new Error("'Storage.getCookies' wasn't found");
    });
    cdp.respond('Network.getAllCookies', () => ({ cookies: live }));
    expect((await readCookies(cdp, 'shop.example')).map((c) => c.name)).toEqual(['sid', 'cf']);
  });

  it('sets only cookies the browser lacks', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Storage.getCookies', () => ({ cookies: [live[0]] }));
    expect(await setMissingCookies(cdp, [cookie('sid', 'stale', 'shop.example'), cookie('cf_clearance', 'x', 'shop.example')])).toBe(1);
    expect(cdp.calls.find((c) => c.method === 'Network.setCookies')!.params).toEqual({ cookies: [expect.objectContaining({ name: 'cf_clearance', value: 'x', domain: 'shop.example' })] });
  });

  it('sets nothing when nothing is missing', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Storage.getCookies', () => ({ cookies: [live[0]] }));
    expect(await setMissingCookies(cdp, [cookie('sid', 'stale', 'shop.example')])).toBe(0);
    expect(cdp.methods()).not.toContain('Network.setCookies');
  });

  it('deletes cookies by name, domain and path', async () => {
    const cdp = new FakeCdp();
    await deleteCookies(cdp, [cookie('a', '1', 'shop.example'), cookie('b', '1', '.shop.example')]);
    expect(cdp.calls.filter((c) => c.method === 'Network.deleteCookies').map((c) => c.params)).toEqual([
      { name: 'a', domain: 'shop.example', path: '/' },
      { name: 'b', domain: '.shop.example', path: '/' },
    ]);
  });

  it('builds a Cookie header and a session with the user agent', async () => {
    expect(cookieHeader([cookie('a', '1', 'x'), cookie('b', '2', 'x')])).toBe('a=1; b=2');
    const cdp = new FakeCdp();
    cdp.respond('Storage.getCookies', () => ({ cookies: [live[0]] }));
    cdp.respond('Runtime.evaluate', () => ({ result: { value: 'Mozilla/5.0 Test' } }));
    expect(await sessionFor(cdp, 'www.shop.example')).toEqual({ site: 'shop.example', userAgent: 'Mozilla/5.0 Test', cookies: [expect.objectContaining({ name: 'sid' })], cookieHeader: 'sid=live' });
  });
});
