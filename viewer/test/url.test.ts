import { describe, it, expect } from 'vitest';
import { parseFragment, sessionIdFromPath, wsUrlFor } from '../src/url';

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

  it('wsUrlFor maps http(s) to ws(s)', () => {
    expect(wsUrlFor('http://127.0.0.1:5000', 'abc')).toBe('ws://127.0.0.1:5000/ws/abc');
    expect(wsUrlFor('https://box.example.com', 'abc')).toBe('wss://box.example.com/ws/abc');
  });
});
