// Throwaway spike: which CDP features Unstuck needs does Cloudflare Browser Rendering support?
import puppeteer from '@cloudflare/puppeteer';

interface Env {
  BROWSER: Fetcher;
}

const FIXTURE = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:60px">Click me</button>
<input id="i" style="position:absolute;left:100px;top:200px;width:300px;height:30px">
<script>window.clicks=0;document.getElementById('b').onclick=()=>{window.clicks++}</script></body></html>`;

async function check(results: Record<string, unknown>, name: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    results[name] = { ok: true, ms: Date.now() - t0, detail: await fn() };
  } catch (e) {
    results[name] = { ok: false, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const results: Record<string, unknown> = {};
    const shots: Record<string, string> = {};
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });
      await page.setContent(FIXTURE);
      const cdp = await page.createCDPSession();

      await check(results, 'Runtime.evaluate', async () => (await cdp.send('Runtime.evaluate', { expression: '6*7', returnByValue: true })).result.value);

      await check(results, 'Page.startScreencast', async () => {
        const frames: { bytes: number; w: number; h: number }[] = [];
        cdp.on('Page.screencastFrame', (f: any) => {
          frames.push({ bytes: f.data.length, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight });
          cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        });
        const t0 = Date.now();
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1600 });
        for (let i = 0; i < 20; i++) {
          await cdp.send('Runtime.evaluate', { expression: `document.body.style.background='hsl(${i * 18},80%,90%)'` });
          await new Promise((r) => setTimeout(r, 150));
        }
        await cdp.send('Page.stopScreencast');
        const secs = (Date.now() - t0) / 1000;
        if (!frames.length) throw new Error('no frames');
        return { frames: frames.length, fps: +(frames.length / secs).toFixed(1), first: frames[0] };
      });

      await check(results, 'Page.captureScreenshot', async () => (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })).data.length);

      await check(results, 'Input.dispatchMouseEvent', async () => {
        for (const type of ['mousePressed', 'mouseReleased'] as const)
          await cdp.send('Input.dispatchMouseEvent', { type, x: 200, y: 130, button: 'left', clickCount: 1 });
        const clicks = await page.evaluate('window.clicks');
        if (clicks !== 1) throw new Error(`clicks=${clicks}`);
        return clicks;
      });

      await check(results, 'Input.insertText', async () => {
        await page.focus('#i');
        await cdp.send('Input.insertText', { text: 'héllo 日本' });
        const v = await page.evaluate("document.getElementById('i').value");
        if (v !== 'héllo 日本') throw new Error(`value=${v}`);
        return v;
      });

      await check(results, 'Input.dispatchKeyEvent', async () => {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
        return await page.evaluate("document.getElementById('i').value");
      });

      for (const [name, url] of [
        ['recaptcha', 'https://www.google.com/recaptcha/api2/demo'],
        ['hcaptcha', 'https://accounts.hcaptcha.com/demo'],
        ['turnstile', 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=x'],
      ] as const) {
        await check(results, `${name} render`, async () => {
          const p = await browser.newPage();
          await p.setViewport({ width: 1280, height: 720 });
          if (name === 'turnstile') {
            await p.goto('https://example.com/');
            await p.setContent(
              '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div>',
            );
          } else await p.goto(url, { waitUntil: 'load', timeout: 20000 });
          await new Promise((r) => setTimeout(r, 5000));
          shots[name] = (await p.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' })) as string;
          const frames = p.frames().map((f) => f.url().slice(0, 60));
          await p.close();
          return { frames };
        });
      }

      await check(results, 'popup (window.open) reported', async () => {
        const popup = new Promise((resolve) => browser.once('targetcreated', (t: any) => resolve(t.url())));
        await page.evaluate("window.open('about:blank#popup','_blank')");
        return await Promise.race([popup, new Promise((_, rej) => setTimeout(() => rej(new Error('no targetcreated in 5 s')), 5000))]);
      });
    } finally {
      await browser.close();
    }
    return Response.json({ results, shots });
  },
};
