import { describe, it, expect } from 'vitest';
import { parseFragment, sessionIdFromPath, wsUrlFor } from '../src/url';

describe('url helpers', () => {
  it('parseFragment reads t= from the hash', () => {
    expect(parseFragment('#t=abc.def')).toEqual({ token: 'abc.def' });
    expect(parseFragment('#x=1&t=abc')).toEqual({ token: 'abc' });
    expect(parseFragment('')).toBeNull();
    expect(parseFragment('#t=')).toBeNull();
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
