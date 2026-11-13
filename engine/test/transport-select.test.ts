import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createEngine } from '@unstuck/core';
import { FakeCdp } from '@unstuck/core/testing';
import { buildTransport, selectTransport } from '../src/transport-select';

describe('selectTransport', () => {
  it('flags beat UNSTUCK_RELAY_URL, which beats UNSTUCK_API_KEY, which beats embedded', () => {
    const env = { UNSTUCK_RELAY_URL: 'wss://own.example', UNSTUCK_AGENT_KEY: 'AK', UNSTUCK_API_KEY: 'uk_live_x' };
    expect(selectTransport({ relay: 'wss://flag.example', agentKey: 'FK' }, env)).toEqual({ kind: 'relay', url: 'wss://flag.example', agentKey: 'FK', source: 'flag' });
    expect(selectTransport({}, env)).toEqual({ kind: 'relay', url: 'wss://own.example', agentKey: 'AK', source: 'UNSTUCK_RELAY_URL' });
    expect(selectTransport({}, { UNSTUCK_API_KEY: 'uk_live_x' })).toEqual({ kind: 'relay', url: 'wss://unstuck.sh', agentKey: 'uk_live_x', source: 'UNSTUCK_API_KEY' });
    expect(selectTransport({}, { UNSTUCK_API_KEY: 'uk_live_x', UNSTUCK_CLOUD_URL: 'wss://staging.example' })).toMatchObject({ url: 'wss://staging.example' });
    expect(selectTransport({}, {})).toEqual({ kind: 'embedded' });
    expect(selectTransport({}, { UNSTUCK_RELAY_URL: 'wss://open.example' })).toEqual({ kind: 'relay', url: 'wss://open.example', agentKey: undefined, source: 'UNSTUCK_RELAY_URL' });
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

  it('embedded mode builds nothing here', () => {
    expect(buildTransport({}, {}, { write: () => true })).toBeNull();
  });
});
