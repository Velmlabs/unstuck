import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createEngine } from '@velmlabs/unstuck-core';
import { FakeCdp } from '@velmlabs/unstuck-core/testing';
import { buildTransport, cloudAlertsFor, selectTransport, viewerUrlFor } from '../src/transport-select';

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

describe('Review Focus 5: a wrong UNSTUCK_API_KEY fails fast and says which variable', () => {
  let wss: WebSocketServer | undefined;
  afterEach(() => wss?.close());

  it('returns failed/relay_unauthorized within seconds and hints at UNSTUCK_API_KEY', async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'unstuck-relay.1' });
    wss.on('connection', (ws) => ws.close(4401, '{"error":"unauthorized"}'));
    await new Promise((r) => wss!.once('listening', r));
    const port = (wss.address() as AddressInfo).port;
    let err = '';
    const { transport, description } = buildTransport({}, { UNSTUCK_API_KEY: 'uk_live_bad', UNSTUCK_CLOUD_URL: `ws://127.0.0.1:${port}` }, { write: (s: string) => (err += s) })!;
    expect(description).toBe(`relay ws://127.0.0.1:${port}`);
    expect(description).not.toContain('uk_live_bad');
    const t0 = Date.now();
    const r = await createEngine({ transport }).takeover(new FakeCdp(), { reason: 'x', timeoutS: 600 });
    expect(r).toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toContain('UNSTUCK_API_KEY');
    expect(err).not.toContain('uk_live_bad');
  });

  it('other refusals and self-hosted relays print no API-key hint', async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'unstuck-relay.1' });
    wss.on('connection', (ws) => ws.close(4401));
    await new Promise((r) => wss!.once('listening', r));
    const port = (wss.address() as AddressInfo).port;
    let err = '';
    const { transport } = buildTransport({}, { UNSTUCK_RELAY_URL: `ws://127.0.0.1:${port}`, UNSTUCK_AGENT_KEY: 'k' }, { write: (s: string) => (err += s) })!;
    await createEngine({ transport }).takeover(new FakeCdp(), { reason: 'x', timeoutS: 60 });
    expect(err).toBe('');
  });

  it('Unstuck Cloud links open the viewer pinned to this engine version on its own origin; UNSTUCK_VIEWER_URL overrides', () => {
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://relay.unstuck.sh', source: 'UNSTUCK_API_KEY' }, {}, '9.8.7')).toBe('https://view.unstuck.sh/v/9.8.7');
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://relay.unstuck.sh', source: 'flag' }, {}, '9.8.7')).toBe('https://view.unstuck.sh/v/9.8.7');
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://own.example', source: 'UNSTUCK_RELAY_URL' }, {}, '9.8.7')).toBeUndefined();
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://staging.example', source: 'UNSTUCK_API_KEY' }, { UNSTUCK_VIEWER_URL: 'https://view-staging.example/v/x' }, '9.8.7')).toBe('https://view-staging.example/v/x');
    expect(viewerUrlFor({ kind: 'relay', url: 'wss://own.example', source: 'UNSTUCK_RELAY_URL' }, { UNSTUCK_VIEWER_URL: 'http://evil.example' }, '9.8.7')).toBeUndefined(); // https only
    expect(viewerUrlFor({ kind: 'relay', url: 'ws://127.0.0.1:1', source: 'flag' }, { UNSTUCK_VIEWER_URL: 'http://127.0.0.1:5000/v/x' }, '9.8.7')).toBe('http://127.0.0.1:5000/v/x'); // or http on this machine
  });

  it('embedded mode builds nothing here', () => {
    expect(buildTransport({}, {}, { write: () => true })).toBeNull();
  });
});
