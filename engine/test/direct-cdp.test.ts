import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connectCdp, normalizeCdpUrl, pickTarget, type TargetInfo } from '../src/direct-cdp';
import { startChromium, type DebugChromium } from './chromium';

let chrome: DebugChromium;
beforeAll(async () => {
  chrome = await startChromium();
}, 30_000);
afterAll(async () => {
  await chrome?.stop();
});

const t = (id: string, type: string, url = 'https://x.test/'): TargetInfo => ({ targetId: id, type, url, title: '', attached: false });

describe('normalizeCdpUrl', () => {
  it.each([
    ['http://127.0.0.1:9222', 'http://127.0.0.1:9222'],
    ['http://127.0.0.1:9222/', 'http://127.0.0.1:9222'],
    ['https://cdp.example.com', 'https://cdp.example.com'],
    ['127.0.0.1:9222', 'http://127.0.0.1:9222'],
    ['localhost:9222', 'http://localhost:9222'],
    ['ws://127.0.0.1:9222/devtools/browser/abc', 'ws://127.0.0.1:9222/devtools/browser/abc'],
    ['wss://cdp.example.com/devtools/browser/abc?token=x', 'wss://cdp.example.com/devtools/browser/abc?token=x'],
  ])('%s → %s', (input, out) => {
    expect(normalizeCdpUrl(input)).toBe(out);
  });

  it('rejects things that are not CDP endpoints', () => {
    expect(() => normalizeCdpUrl('')).toThrow(/not a CDP URL/);
    expect(() => normalizeCdpUrl('ftp://x')).toThrow(/not a CDP URL/);
  });
});

describe('pickTarget (Review Focus 3)', () => {
  const targets = [t('sw', 'service_worker'), t('dev', 'page', 'devtools://devtools/inspector.html'), t('a', 'page'), t('b', 'page'), t('i', 'iframe')];
  it('picks the requested target id', () => {
    expect(pickTarget(targets, 'b').targetId).toBe('b');
  });
  it('defaults to the first real page, never a worker or devtools', () => {
    expect(pickTarget(targets).targetId).toBe('a');
  });
  it('errors for an unknown id or when there is no page', () => {
    expect(() => pickTarget(targets, 'zzz')).toThrow('target zzz not found');
    expect(() => pickTarget([t('sw', 'service_worker')])).toThrow('no page target to take over');
  });
});

describe('connectCdp against real Chromium (Review Focus 3)', () => {
  it.each(['http', 'bare', 'ws'] as const)('connects via %s URL form and evaluates', async (form) => {
    const url = form === 'http' ? `http://127.0.0.1:${chrome.port}` : form === 'bare' ? `127.0.0.1:${chrome.port}` : chrome.wsUrl;
    const cdp = await connectCdp(url);
    await expect(cdp.send('Runtime.evaluate', { expression: '6*7', returnByValue: true })).resolves.toMatchObject({ result: { value: 42 } });
    await cdp.close();
  });

  it('attaches to the requested tab among several and receives its events', async () => {
    const browser = await connectCdp(`127.0.0.1:${chrome.port}`);
    const { targetId } = await browser.browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    await browser.close();
    const cdp = await connectCdp(`127.0.0.1:${chrome.port}`, { targetId });
    expect(cdp.targetId).toBe(targetId);
    const got = vi.fn();
    cdp.on('Runtime.consoleAPICalled', got);
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.evaluate', { expression: "console.log('hi')" });
    await vi.waitFor(() => expect(got).toHaveBeenCalled());
    await cdp.close();
  });

  it('closing the tab fires onClose once with "target closed"', async () => {
    const b = await connectCdp(`127.0.0.1:${chrome.port}`);
    const { targetId } = await b.browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const cdp = await connectCdp(`127.0.0.1:${chrome.port}`, { targetId });
    const closed = vi.fn();
    cdp.onClose(closed);
    await b.browser.send('Target.closeTarget', { targetId });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith('target closed'));
    const late = vi.fn();
    cdp.onClose(late);
    expect(late).toHaveBeenCalledWith('target closed');
    expect(closed).toHaveBeenCalledTimes(1);
    await cdp.close();
    await b.close();
  });

  it('reports popups the tab opens as attached CDP clients (Review Focus 4)', async () => {
    const b = await connectCdp(`127.0.0.1:${chrome.port}`);
    const { targetId } = await b.browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    await b.close();
    const cdp = await connectCdp(`127.0.0.1:${chrome.port}`, { targetId });
    const seen: import('@velmlabs/unstuck-core').CdpClient[] = [];
    const off = cdp.popups.onPopup((p) => seen.push(p));
    await cdp.send('Runtime.evaluate', { expression: "window.open('about:blank#popup', '_blank')", userGesture: true });
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    const href = await seen[0]!.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    expect(href.result.value).toBe('about:blank#popup');
    const closed = vi.fn();
    seen[0]!.onClose(closed);
    await seen[0]!.send('Runtime.evaluate', { expression: 'window.close()' });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith('target closed'), { timeout: 5000 });
    off();
    await cdp.send('Runtime.evaluate', { expression: "window.open('about:blank#second', '_blank')", userGesture: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toHaveLength(1);
    await cdp.close();
  });

  it('createUrl opens a new tab on this same connection and attaches to it', async () => {
    const cdp = await connectCdp(`127.0.0.1:${chrome.port}`, { createUrl: 'about:blank#created' });
    await vi.waitFor(async () => {
      const r = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      expect(r.result.value).toBe('about:blank#created');
    });
    await cdp.browser.send('Target.closeTarget', { targetId: cdp.targetId });
    await cdp.close();
  });

  it('unknown targetId rejects with "target … not found"', async () => {
    await expect(connectCdp(`127.0.0.1:${chrome.port}`, { targetId: 'nope' })).rejects.toThrow('target nope not found');
  });

  it('failed commands reject with the CDP error message', async () => {
    const cdp = await connectCdp(`127.0.0.1:${chrome.port}`);
    await expect(cdp.send('No.suchMethod')).rejects.toThrow(/wasn't found|not found/);
    await cdp.close();
  });

  it('an unreachable endpoint rejects clearly', async () => {
    await expect(connectCdp('127.0.0.1:1')).rejects.toThrow(/could not reach the browser at http:\/\/127\.0\.0\.1:1/);
  });

  it('close() closes the socket, rejects later sends and fires onClose("browser disconnected")', async () => {
    const cdp = await connectCdp(`127.0.0.1:${chrome.port}`);
    const closed = vi.fn();
    cdp.onClose(closed);
    await cdp.close();
    expect(closed).toHaveBeenCalledWith('browser disconnected');
    await expect(cdp.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow(/browser disconnected/);
  });
});

describe('connectCdp against a scripted DevTools server', () => {
  it('Final M6: commands pending on a tab that detaches are rejected, so later input never stalls', async () => {
    const { WebSocketServer } = await import('ws');
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      const port = (server.address() as import('node:net').AddressInfo).port;
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
    });
    const wss = new WebSocketServer({ server });
    let sock!: import('ws').WebSocket;
    wss.on('connection', (ws) => {
      sock = ws;
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        const reply = (result: object) => ws.send(JSON.stringify({ id: m.id, result }));
        if (m.method === 'Target.getTargets') reply({ targetInfos: [{ targetId: 'T', type: 'page', url: 'https://x/', title: '', attached: false }] });
        else if (m.method === 'Target.attachToTarget') reply({ sessionId: 'S' });
        else if (m.method === 'Runtime.evaluate') {
          /* never answered */
        } else reply({});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const cdp = await connectCdp(`127.0.0.1:${port}`);
    const pending = cdp.send('Runtime.evaluate', { expression: '1' });
    await new Promise((r) => setTimeout(r, 50));
    sock.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S' } }));
    await expect(pending).rejects.toThrow('target closed');
    await expect(cdp.send('Runtime.evaluate', { expression: '2' })).rejects.toThrow('target closed');
    await cdp.close();
    wss.close();
    server.close();
  });
});
