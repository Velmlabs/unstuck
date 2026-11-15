import { describe, it, expect } from 'vitest';
import { optionEnv, validateOptions } from '../src/options';
import { UnstuckConfigError } from '../src/errors';
import { Unstuck } from '../src/unstuck';

describe('validateOptions', () => {
  it('rejects apiKey with relay', () => {
    expect(() => new Unstuck({ apiKey: 'k', relay: 'wss://r' })).toThrow(UnstuckConfigError);
    expect(() => validateOptions({ apiKey: 'k', relay: 'wss://r' })).toThrow(/either apiKey .* or relay \+ agentKey .*not both/);
  });
  it('rejects cloudApi or cloudRelay without apiKey', () => {
    expect(() => validateOptions({ cloudApi: 'https://staging' })).toThrow(/only apply with apiKey/);
    expect(() => validateOptions({ cloudRelay: 'wss://s' })).toThrow(UnstuckConfigError);
  });
  it('accepts consistent options and names the error', () => {
    expect(() => validateOptions({ apiKey: 'k', cloudApi: 'https://a', cloudRelay: 'wss://s' })).not.toThrow();
    expect(() => validateOptions({ relay: 'wss://r', agentKey: 'x' })).not.toThrow();
    expect(new UnstuckConfigError('x').name).toBe('UnstuckConfigError');
  });
});

describe('optionEnv', () => {
  it('maps options to engine env', () =>
    expect(optionEnv({ apiKey: 'k', cloudRelay: 'wss://s', cloudApi: 'https://a', viewerUrl: 'https://v' })).toEqual({
      UNSTUCK_API_KEY: 'k',
      UNSTUCK_RELAY_URL: undefined,
      UNSTUCK_AGENT_KEY: undefined,
      UNSTUCK_CLOUD_URL: 'wss://s',
      UNSTUCK_CLOUD_API: 'https://a',
      UNSTUCK_VIEWER_URL: 'https://v',
    }));
  it('maps relay and agentKey', () => expect(optionEnv({ relay: 'wss://r', agentKey: 'a' })).toEqual({ UNSTUCK_RELAY_URL: 'wss://r', UNSTUCK_AGENT_KEY: 'a' }));
  it('adds no key for unset options', () => expect(optionEnv({})).toEqual({}));
});
