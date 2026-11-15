import { describe, it, expect } from 'vitest';
import { optionEnv, validateOptions } from '../src/options';
import { UnstuckConfigError } from '../src/errors';
import { Unstuck } from '../src/unstuck';

describe('validateOptions', () => {
  it('rejects apiKey with relay', () => {
    expect(() => new Unstuck({ apiKey: 'k', relay: 'wss://r' })).toThrow(UnstuckConfigError);
    expect(() => validateOptions({ apiKey: 'k', relay: 'wss://r' })).toThrow(/either apiKey .* or relay \+ agentKey .*not both/);
  });
  it('rejects apiKey with agentKey', () => {
    expect(() => validateOptions({ apiKey: 'k', agentKey: 'a' })).toThrow(UnstuckConfigError);
    expect(() => validateOptions({ apiKey: 'k', agentKey: 'a' })).toThrow('agentKey is for your own relay (with relay); Unstuck Cloud only needs apiKey');
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

describe('URL options', () => {
  const bad = (o: Parameters<typeof validateOptions>[0], msg: string) => {
    expect(() => validateOptions(o)).toThrow(UnstuckConfigError);
    expect(() => validateOptions(o)).toThrow(msg);
  };
  it('relay and cloudRelay must be wss://, or ws:// to this machine', () => {
    bad({ relay: 'ws://relay.example' }, 'relay must be a wss:// URL (ws:// only to localhost, 127.0.0.1 or [::1])');
    bad({ relay: 'https://relay.example' }, 'relay must be a wss:// URL');
    bad({ relay: 'not a url' }, 'relay must be a wss:// URL');
    bad({ apiKey: 'k', cloudRelay: 'ws://relay.example' }, 'cloudRelay must be a wss:// URL (ws:// only to localhost, 127.0.0.1 or [::1])');
    bad({ relay: 'ws://localhost.evil.example' }, 'relay must be a wss:// URL');
    for (const ok of ['wss://relay.example', 'ws://localhost:8787', 'ws://127.0.0.1:1', 'ws://[::1]:9/x']) {
      expect(() => validateOptions({ relay: ok })).not.toThrow();
      expect(() => validateOptions({ apiKey: 'k', cloudRelay: ok })).not.toThrow();
    }
  });
  it('cloudApi and viewerUrl must be https://, or http:// to this machine', () => {
    bad({ apiKey: 'k', cloudApi: 'http://api.example' }, 'cloudApi must be a https:// URL (http:// only to localhost, 127.0.0.1 or [::1])');
    bad({ apiKey: 'k', cloudApi: 'wss://api.example' }, 'cloudApi must be a https:// URL');
    bad({ viewerUrl: 'http://view.example/v' }, 'viewerUrl must be a https:// URL (http:// only to localhost, 127.0.0.1 or [::1])');
    bad({ viewerUrl: 'javascript:alert(1)' }, 'viewerUrl must be a https:// URL');
    for (const ok of ['https://api.example', 'http://localhost:8787', 'http://127.0.0.1:1/x', 'http://[::1]:3000']) {
      expect(() => validateOptions({ apiKey: 'k', cloudApi: ok })).not.toThrow();
      expect(() => validateOptions({ viewerUrl: ok })).not.toThrow();
    }
  });
  it('an empty string is unset, as before', () => {
    expect(() => validateOptions({ relay: '', viewerUrl: '' })).not.toThrow();
  });
  it('the constructors check them too', () => {
    expect(() => new Unstuck({ relay: 'ws://relay.example' })).toThrow(UnstuckConfigError);
    expect(() => new Unstuck({ viewerUrl: 'http://view.example' })).toThrow(UnstuckConfigError);
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
