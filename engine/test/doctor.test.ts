import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { PNG } from 'pngjs';
import { connectBrowser, connectCdp, type DirectCdp } from '../src/direct-cdp';
import { formatReport, runDoctor, serve } from '../src/doctor';
import net from 'node:net';
import { main } from '../src/cli';
import { startChromium, type DebugChromium } from './chromium';

let chrome: DebugChromium;
beforeAll(async () => {
  chrome = await startChromium();
}, 30_000);
afterAll(async () => {
  await chrome?.stop();
});

const whitePng = () => {
  const png = new PNG({ width: 1280, height: 720 });
  png.data.fill(255);
  return PNG.sync.write(png).toString('base64');
};

/** Wraps real connectCdp so selected page methods misbehave (a browser that paints/works differently). */
function wrapped(overrides: Record<string, (params?: object) => unknown>): typeof connectCdp {
  return async (url, opts) => {
    const real = await connectCdp(url, opts);
    return {
      ...real,
      send: <T>(method: string, params?: object) => (method in overrides ? Promise.resolve().then(() => overrides[method]!(params) as T) : real.send<T>(method, params)),
    } as DirectCdp;
  };
}

async function pageTargetCount(): Promise<number> {
  const b = await connectCdp(`127.0.0.1:${chrome.port}`);
  const { targetInfos } = await b.browser.send<{ targetInfos: { type: string }[] }>('Target.getTargets');
  await b.close();
  return targetInfos.filter((t) => t.type === 'page').length;
}

describe('runDoctor', () => {
  it('real Chromium: full, every check passes, and every tab the doctor opened is closed', async () => {
    const before = await pageTargetCount();
    const r = await runDoctor(`127.0.0.1:${chrome.port}`);
    expect(r).toMatchObject({
      capabilities: { screencast: true, insertText: true, input: true },
      crossOriginIframePaint: true,
      popupTracking: true,
      verdict: 'full',
      notes: [],
    });
    expect(r.browser).toMatch(/Chrome/);
    expect(await pageTargetCount()).toBe(before);
  }, 30_000);

  it('a browser that leaves cross-origin iframes blank is limited, with a note', async () => {
    const r = await runDoctor(`127.0.0.1:${chrome.port}`, { connect: wrapped({ 'Page.captureScreenshot': () => ({ data: whitePng() }) }) });
    expect(r.crossOriginIframePaint).toBe(false);
    expect(r.verdict).toBe('limited');
    expect(r.notes).toContain('CAPTCHA widgets in cross-origin iframes will not be visible; use Chromium for CAPTCHAs');
  }, 30_000);

  it('Final I5: when the browser cannot load the test page the verdict is limited, not full', async () => {
    const blind: typeof connectCdp = async (url, opts) => {
      const real = await connectCdp(url, opts);
      return {
        ...real,
        send: <T>(method: string, params?: object) =>
          method === 'Runtime.evaluate' && JSON.stringify(params).includes('__childLoaded')
            ? (Promise.resolve({ result: { value: false } }) as Promise<T>)
            : real.send<T>(method, params),
      } as DirectCdp;
    };
    const r = await runDoctor(`127.0.0.1:${chrome.port}`, { connect: blind });
    expect(r.crossOriginIframePaint).toBe('unknown');
    expect(r.verdict).toBe('limited');
    expect(r.notes).toContain(
      'could not load the test page from the browser (it may not reach this machine): CAPTCHA support was not checked',
    );
  }, 40_000);

  it('a browser without input is unsupported', async () => {
    const r = await runDoctor(`127.0.0.1:${chrome.port}`, {
      connect: wrapped({ 'Input.dispatchMouseEvent': () => Promise.reject(new Error('no input')) }),
    });
    expect(r.capabilities.input).toBe(false);
    expect(r.verdict).toBe('unsupported');
  }, 30_000);

  it('missing screencast or insertText is noted as a fallback but stays full', async () => {
    const r = await runDoctor(`127.0.0.1:${chrome.port}`, {
      connect: wrapped({ 'Page.startScreencast': () => Promise.reject(new Error('nope')), 'Input.insertText': () => Promise.reject(new Error('nope')) }),
    });
    expect(r.verdict).toBe('full');
    expect(r.notes).toEqual(['no screencast: Unstuck will poll screenshots (about 5 fps)', 'no insertText: Unstuck will type text key by key']);
  }, 30_000);

  it('creates its tab on the same connection it uses (Obscura scopes tabs per connection)', async () => {
    const calls: { createUrl?: string; targetId?: string }[] = [];
    const counting: typeof connectCdp = async (url, opts) => {
      calls.push({ ...opts });
      return connectCdp(url, opts);
    };
    const r = await runDoctor(`127.0.0.1:${chrome.port}`, { connect: counting });
    expect(r.verdict).toBe('full');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.createUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  }, 30_000);

  it('works on a browser with no open tabs (e.g. a fresh obscura serve)', async () => {
    const fresh = await startChromium();
    try {
      const b = await connectBrowser(`127.0.0.1:${fresh.port}`);
      const { targetInfos } = await b.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      for (const t of targetInfos.filter((x) => x.type === 'page')) await b.send('Target.closeTarget', { targetId: t.targetId });
      await b.close();
      const r = await runDoctor(`127.0.0.1:${fresh.port}`);
      expect(r.verdict).toBe('full');
    } finally {
      await fresh.stop();
    }
  }, 40_000);

  it('an unreachable browser rejects', async () => {
    await expect(runDoctor('127.0.0.1:1')).rejects.toThrow(/could not reach the browser/);
  });
});

describe('serve (doctor fixture server)', () => {
  it('close() does not wait for a connection with a request still in flight', async () => {
    const srv = await serve('127.0.0.1', () => 'ok');
    const sock = net.connect(srv.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n'); // headers never finished: request in flight
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await srv.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    sock.destroy();
  });
});

describe('formatReport', () => {
  it('prints one line per check, then the verdict and notes', () => {
    const out = formatReport({
      browser: 'Chrome/150',
      capabilities: { screencast: true, insertText: false, input: true },
      crossOriginIframePaint: 'unknown',
      popupTracking: false,
      verdict: 'limited',
      notes: ['n1'],
    });
    expect(out).toBe(
      [
        'Browser: Chrome/150',
        '✓ live view (screencast)',
        '✗ paste (insertText)',
        '✓ mouse and keyboard input',
        '? cross-origin iframes painted (CAPTCHA widgets)',
        '✗ popups reported',
        'Verdict: LIMITED',
        '  - n1',
        '',
      ].join('\n'),
    );
  });
});

describe('unstuck-engine doctor', () => {
  const io = () => {
    let out = '';
    let err = '';
    const stdout = new PassThrough();
    stdout.on('data', (d) => (out += d));
    return { stdin: new PassThrough(), stdout, stderr: { write: (s: string) => ((err += s), true) }, env: {}, assets: {}, out: () => out, err: () => err };
  };

  it('prints the report and exits 0 for a full browser', async () => {
    const x = io();
    await expect(main(['doctor', '--cdp', `127.0.0.1:${chrome.port}`], x)).resolves.toBe(0);
    expect(x.out()).toContain('Verdict: FULL');
  }, 30_000);

  it('exits 1 when the browser cannot be reached, and 2 without --cdp', async () => {
    const a = io();
    await expect(main(['doctor', '--cdp', '127.0.0.1:1'], a)).resolves.toBe(1);
    expect(a.err()).toContain('could not reach the browser');
    const b = io();
    await expect(main(['doctor'], b)).resolves.toBe(2);
  });
});
