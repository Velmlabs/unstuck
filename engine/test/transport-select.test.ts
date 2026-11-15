import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createEngine } from '@velmlabs/unstuck-core';
import { FakeCdp } from '@velmlabs/unstuck-core/testing';
import { buildTransport } from '../src/transport-select';

describe('buildTransport', () => {
  let wss: WebSocketServer | undefined;
  afterEach(() => wss?.close());

  async function relay(code: number) {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'unstuck-relay.1' });
    wss.on('connection', (ws) => ws.close(code, '{"error":"unauthorized"}'));
    await new Promise((r) => wss!.once('listening', r));
    return (wss.address() as AddressInfo).port;
  }

  it('a wrong UNSTUCK_API_KEY fails fast with relay_unauthorized and prints one line on stderr, without the key', async () => {
    const port = await relay(4401);
    let err = '';
    const { transport, description } = buildTransport({}, { UNSTUCK_API_KEY: 'uk_live_bad', UNSTUCK_CLOUD_URL: `ws://127.0.0.1:${port}` }, { write: (s: string) => (err += s) })!;
    expect(description).toBe(`relay ws://127.0.0.1:${port}`);
    expect(description).not.toContain('uk_live_bad');
    const t0 = Date.now();
    const r = await createEngine({ transport }).takeover(new FakeCdp(), { reason: 'x', timeoutS: 600 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r).toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
    expect(err).toBe('[unstuck] unstuck.sh rejected the API key: check the key in your dashboard\n');
    expect(err).not.toContain('uk_live_bad');
  });

  it('a self-hosted relay prints no API-key hint', async () => {
    const port = await relay(4401);
    let err = '';
    const { transport } = buildTransport({}, { UNSTUCK_RELAY_URL: `ws://127.0.0.1:${port}`, UNSTUCK_AGENT_KEY: 'k' }, { write: (s: string) => (err += s) })!;
    await createEngine({ transport }).takeover(new FakeCdp(), { reason: 'x', timeoutS: 60 });
    expect(err).toBe('');
  });

  it('embedded mode builds nothing here', () => {
    expect(buildTransport({}, {}, { write: () => true })).toBeNull();
  });
});
