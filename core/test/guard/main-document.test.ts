import { describe, it, expect } from 'vitest';
import { trackMainDocument } from '../../src/guard/main-document';
import { FakeCdp } from '../../src/testing/fake-cdp';

const fresh = () => {
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN' } } }));
  return cdp;
};
const response = (o: { type?: string; frameId?: string; url?: string; status?: number; headers?: Record<string, string> }) => ({
  type: o.type ?? 'Document',
  frameId: o.frameId ?? 'MAIN',
  response: { url: o.url ?? 'https://shop.example/', status: o.status ?? 200, headers: o.headers ?? {} },
});

describe('trackMainDocument', () => {
  it('records the main frame document response with lower-cased header names', async () => {
    const cdp = fresh();
    const t = await trackMainDocument(cdp);
    expect(cdp.methods()).toContain('Network.enable');
    expect(t.last()).toBeNull();
    cdp.emit('Network.responseReceived', response({ status: 503, headers: { 'CF-Mitigated': 'challenge' } }));
    expect(t.last()).toEqual({ url: 'https://shop.example/', status: 503, headers: { 'cf-mitigated': 'challenge' } });
  });

  it('ignores subresources and child frames', async () => {
    const cdp = fresh();
    const t = await trackMainDocument(cdp);
    cdp.emit('Network.responseReceived', response({ type: 'Script' }));
    cdp.emit('Network.responseReceived', response({ frameId: 'CHILD' }));
    expect(t.last()).toBeNull();
  });

  it('stop() removes its listener', async () => {
    const cdp = fresh();
    const t = await trackMainDocument(cdp);
    expect(cdp.listenerCount('Network.responseReceived')).toBe(1);
    t.stop();
    expect(cdp.listenerCount('Network.responseReceived')).toBe(0);
    cdp.emit('Network.responseReceived', response({}));
    expect(t.last()).toBeNull();
  });
});
