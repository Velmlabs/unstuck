import { describe, it, expect } from 'vitest';
import { alertKindOf, PROTOCOL_MINOR, Methods } from '../src';

describe('guard and rpc additions', () => {
  it('maps check kinds to alert kinds', () => {
    expect(['challenge', 'approval', 'login', '2fa', 'ask'].map((k) => alertKindOf(k as never))).toEqual(['challenge', 'approval', 'login', 'login', 'other']);
  });
  it('minor 2 with ask methods', () => {
    expect(PROTOCOL_MINOR).toBe(2);
    expect(Methods.ask).toBe('ask');
    expect(Methods.askLink).toBe('ask.link');
  });
});
