import { describe, it, expect } from 'vitest';
import { parseFragment, sessionIdFromPath, takeFragment, forgetFragment, relayFor } from '../src/url';

describe('url helpers', () => {
  const K = 'A'.repeat(43);
  it('parseFragment reads t= and the 32-byte key k= from the hash', () => {
    expect(parseFragment(`#t=abc.def&k=${K}`)).toEqual({ token: 'abc.def', key: new Uint8Array(32) });
    expect(parseFragment('')).toBeNull();
  });

  it('Review Focus 2: a link missing or cutting off part of the fragment is incomplete', () => {
    expect(parseFragment('#t=abc.def')).toEqual({ error: 'incomplete' });
    expect(parseFragment('#t=abc.def&k=abc')).toEqual({ error: 'incomplete' });
    expect(parseFragment(`#k=${K}`)).toEqual({ error: 'incomplete' });
    expect(parseFragment('#t=')).toEqual({ error: 'incomplete' });
  });

  it('sessionIdFromPath reads /s/<id>', () => {
    expect(sessionIdFromPath('/s/AbC_-1')).toBe('AbC_-1');
    expect(sessionIdFromPath('/takeover/AbC')).toBe('AbC');
    expect(sessionIdFromPath('/')).toBeNull();
  });

});

describe('takeFragment: the link secret leaves the address bar', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  it('keeps the fragment for this tab only and removes it from the URL (history, sync and screenshots never see it)', () => {
    const store = mem();
    const replaced: string[] = [];
    // Like window.location: replaceState changes what loc.hash returns afterwards.
    const loc = { hash: '#t=T&k=K', pathname: '/s/ABC', search: '' };
    const hash = takeFragment(loc, store, { replaceState: (_s: unknown, _t: string, u: string) => void (replaced.push(u), (loc.hash = '')) });
    expect(hash).toBe('#t=T&k=K');
    expect(replaced).toEqual(['/s/ABC']);
    expect(store.m.get('unstuck:link:ABC')).toBe('#t=T&k=K');
  });
  it('a reload in the same tab (no fragment any more) gets it back from the tab storage', () => {
    const store = mem();
    store.setItem('unstuck:link:ABC', '#t=T&k=K');
    const replaced: string[] = [];
    expect(takeFragment({ hash: '', pathname: '/s/ABC', search: '' }, store, { replaceState: () => void replaced.push('x') })).toBe('#t=T&k=K');
    expect(replaced).toEqual([]);
  });
  it('no fragment and nothing stored: empty; storage or history that throws is survived', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(takeFragment({ hash: '', pathname: '/s/ABC', search: '' }, broken, { replaceState: () => {} })).toBe('');
    expect(takeFragment({ hash: '#t=T&k=K', pathname: '/s/ABC', search: '?x=1' }, broken, { replaceState: () => { throw new Error('no'); } })).toBe('#t=T&k=K');
  });
  it('forgetFragment removes it when the takeover is over', () => {
    const store = mem();
    store.setItem('unstuck:link:ABC', '#t=T&k=K');
    forgetFragment('ABC', store);
    expect(store.m.size).toBe(0);
    forgetFragment('ABC', { removeItem: () => { throw new Error('denied'); } });
  });
});

describe('relayFor: which relay the viewer talks to', () => {
  it('its own origin when the relay serves the page (self-hosted, local)', () => {
    expect(relayFor('', 'https://relay.example')).toEqual({ ws: 'wss://relay.example', http: 'https://relay.example' });
    expect(relayFor('', 'http://127.0.0.1:5000')).toEqual({ ws: 'ws://127.0.0.1:5000', http: 'http://127.0.0.1:5000' });
  });
  it('the relay named in ?r= when the viewer has its own origin', () => {
    expect(relayFor('?r=wss%3A%2F%2Frelay.unstuck.sh', 'https://view.unstuck.sh')).toEqual({ ws: 'wss://relay.unstuck.sh', http: 'https://relay.unstuck.sh' });
    expect(relayFor('?r=ws%3A%2F%2F127.0.0.1%3A8787%2F', 'https://view.unstuck.sh')).toEqual({ ws: 'ws://127.0.0.1:8787', http: 'http://127.0.0.1:8787' });
  });
  it('refuses anything but wss (or plain ws on this machine), with no path, and falls back to its own origin', () => {
    for (const r of ['ws://evil.example', 'https://relay.example', 'javascript:alert(1)', 'wss://relay.example/x', 'wss://u:p@relay.example', 'nonsense'])
      expect(relayFor(`?r=${encodeURIComponent(r)}`, 'https://view.unstuck.sh')).toEqual({ ws: 'wss://view.unstuck.sh', http: 'https://view.unstuck.sh' });
  });
});
