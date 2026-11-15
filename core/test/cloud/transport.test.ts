import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRelayTransport, cloudAlertsFor, selectTransport, viewerUrlFor } from '../../src/cloud/transport';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWs.all.push(this);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('selectTransport', () => {
  it('flags beat UNSTUCK_RELAY_URL, which beats UNSTUCK_API_KEY, which beats embedded', () => {
    const env = { UNSTUCK_RELAY_URL: 'wss://own.example', UNSTUCK_AGENT_KEY: 'AK', UNSTUCK_API_KEY: 'uk_live_x' };
    expect(selectTransport({ relay: 'wss://flag.example', agentKey: 'FK' }, env)).toEqual({ kind: 'relay', url: 'wss://flag.example', agentKey: 'FK', source: 'flag' });
    expect(selectTransport({}, env)).toEqual({ kind: 'relay', url: 'wss://own.example', agentKey: 'AK', source: 'UNSTUCK_RELAY_URL' });
    expect(selectTransport({}, { UNSTUCK_API_KEY: 'uk_live_x' })).toEqual({ kind: 'relay', url: 'wss://relay.unstuck.sh', agentKey: 'uk_live_x', source: 'UNSTUCK_API_KEY' });
    expect(selectTransport({}, { UNSTUCK_API_KEY: 'uk_live_x', UNSTUCK_CLOUD_URL: 'wss://staging.example' })).toMatchObject({ url: 'wss://staging.example' });
    expect(selectTransport({}, {})).toEqual({ kind: 'embedded' });
    expect(selectTransport({}, { UNSTUCK_RELAY_URL: 'wss://open.example' })).toEqual({ kind: 'relay', url: 'wss://open.example', agentKey: undefined, source: 'UNSTUCK_RELAY_URL' });
  });
});

describe('cloudAlertsFor', () => {
  it('only an UNSTUCK_API_KEY relay gets alerts; the API base defaults to unstuck.sh and UNSTUCK_CLOUD_API overrides it', () => {
    const env = { UNSTUCK_API_KEY: 'uk_live_x' };
    expect(cloudAlertsFor(selectTransport({}, env), env)).toEqual({ apiBase: 'https://unstuck.sh', apiKey: 'uk_live_x' });
    const own = { ...env, UNSTUCK_CLOUD_API: 'https://staging.unstuck.sh/' };
    expect(cloudAlertsFor(selectTransport({}, own), own)).toEqual({ apiBase: 'https://staging.unstuck.sh', apiKey: 'uk_live_x' });
    const selfHosted = { ...env, UNSTUCK_RELAY_URL: 'wss://own.example' };
    expect(cloudAlertsFor(selectTransport({}, selfHosted), selfHosted)).toBeNull();
    expect(cloudAlertsFor(selectTransport({ relay: 'wss://f.example' }, env), env)).toBeNull();
    expect(cloudAlertsFor(selectTransport({}, {}), {})).toBeNull();
  });
});


describe('buildRelayTransport', () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.stubGlobal('WebSocket', FakeWs);
  });
  afterEach(() => vi.unstubAllGlobals());

  const refuse = async (source: 'UNSTUCK_API_KEY' | 'UNSTUCK_RELAY_URL', warn: (l: string) => void) => {
    const t = buildRelayTransport({ kind: 'relay', url: 'ws://127.0.0.1:1', agentKey: 'sk_secret', source }, { env: {}, version: '0.2.0', warn });
    const p = t.publish('SESSION_0123456789ab', { expiresAt: 1 });
    const rejected = expect(p).rejects.toMatchObject({ detail: 'relay_unauthorized' });
    await until(() => FakeWs.all.length > 0);
    FakeWs.all[0]!.readyState = 1;
    FakeWs.all[0]!.onopen?.();
    FakeWs.all[0]!.close(4401);
    await rejected;
  };

  it('warns once per rejected publish for Cloud keys, without the key', async () => {
    const warn = vi.fn();
    await refuse('UNSTUCK_API_KEY', warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[unstuck] unstuck.sh rejected the API key: check the key in your dashboard');
    expect(warn.mock.calls.flat().join()).not.toContain('sk_secret');
  });

  it('does not warn for a self-hosted relay key', async () => {
    const warn = vi.fn();
    await refuse('UNSTUCK_RELAY_URL', warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the hosted viewer pinned to the version for the Cloud relay', async () => {
    const transport = buildRelayTransport({ kind: 'relay', url: 'wss://relay.unstuck.sh', agentKey: 'k', source: 'UNSTUCK_API_KEY' }, { env: {}, version: '0.2.0', warn: () => {} });
    const p = transport.publish('SESSION_0123456789ab', { expiresAt: 1 });
    await until(() => FakeWs.all.length > 0);
    const ws = FakeWs.all[0]!;
    ws.readyState = 1;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ t: 'registered' }) });
    const { baseUrl } = await p;
    expect(baseUrl).toBe(`https://view.unstuck.sh/v/0.2.0/s/SESSION_0123456789ab?r=${encodeURIComponent('wss://relay.unstuck.sh')}`);
    await transport.unpublish('SESSION_0123456789ab');
  });
});

describe('viewerUrlFor', () => {
  it('Unstuck Cloud links open the viewer pinned to this engine version on its own origin; UNSTUCK_VIEWER_URL overrides', () => {
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://relay.unstuck.sh', source: 'UNSTUCK_API_KEY' }, {}, '9.8.7')).toBe('https://view.unstuck.sh/v/9.8.7');
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://relay.unstuck.sh', source: 'flag' }, {}, '9.8.7')).toBe('https://view.unstuck.sh/v/9.8.7');
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://own.example', source: 'UNSTUCK_RELAY_URL' }, {}, '9.8.7')).toBeUndefined();
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://staging.example', source: 'UNSTUCK_API_KEY' }, { UNSTUCK_VIEWER_URL: 'https://view-staging.example/v/x' }, '9.8.7')).toBe('https://view-staging.example/v/x');
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://own.example', source: 'UNSTUCK_RELAY_URL' }, { UNSTUCK_VIEWER_URL: 'http://evil.example' }, '9.8.7')).toBeUndefined(); // https only
    expect(viewerUrlFor({ kind: 'relay', url: 'ws://127.0.0.1:1', source: 'flag' }, { UNSTUCK_VIEWER_URL: 'http://127.0.0.1:5000/v/x' }, '9.8.7')).toBe('http://127.0.0.1:5000/v/x'); // or http on this machine
  });

});
