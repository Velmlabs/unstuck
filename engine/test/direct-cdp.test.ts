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
