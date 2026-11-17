// A site with one page per human-check vendor, for Unstuck Browser's end-to-end tests. Each check stays until the test
// (the "person") calls solve(): Cloudflare and the generic check then reload by themselves into the shop (and set the
// clearance cookie), and the widgets fill their token, as the real ones do.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures/human-checks');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
export const SHOP = '<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1><p>Welcome to the shop. Everything is in stock today.</p></body></html>';

/** Polls /__state; once solved, reloads (after 1 s, like Cloudflare) or fills the widget's token field. */
const watcher = (mode: 'reload' | { token: string }) =>
  `<script>const t = setInterval(() => fetch('/__state').then((r) => r.text()).then((s) => { if (s !== 'solved') return; clearInterval(t); ${
    mode === 'reload' ? 'setTimeout(() => location.reload(), 1000);' : `document.querySelector('[name="${mode.token}"]').value = 'XXXX.e2e-token';`
  } }), 200);</script>`;
const withScript = (html: string, script: string) => html.replace('</body>', `${script}</body>`);
const asShop = (html: string) => html.replace(/<title>[^<]*<\/title>/, '<title>Shop</title>');

const WIDGETS: Record<string, { file: string; token: string }> = {
  '/turnstile': { file: 'cloudflare-turnstile.html', token: 'cf-turnstile-response' },
  '/recaptcha': { file: 'recaptcha-v2.html', token: 'g-recaptcha-response' },
  '/hcaptcha': { file: 'hcaptcha.html', token: 'h-captcha-response' },
};

/** The fixture frame for a vendor iframe URL, or null for any other URL. */
export function vendorFrame(url: string): string | null {
  const host = new URL(url).host;
  const name = host === 'challenges.cloudflare.com' ? 'turnstile' : /(^|\.)google\.com$|recaptcha\.net$/.test(host) ? 'recaptcha-anchor' : /hcaptcha\.com$/.test(host) ? 'hcaptcha' : null;
  return name ? fs.readFileSync(path.join(FIXTURES, 'frames', `${name}.html`), 'utf8') : null;
}

export interface ChallengeSite {
  url: string;
  /** Serves the vendor iframe hosts from the fixtures in a Playwright context. */
  vendorRoutes(ctx: { route(glob: string, h: (r: any) => unknown): Promise<unknown> }): Promise<void>;
  /** The person solved it: the next state poll sees it. */
  solve(): void;
  /** A new, unsolved check (the clearance cookie a browser kept still lets it through). */
  reset(): void;
  hits(path: string): number;
  close(): void;
}

export async function startChallengeSite(): Promise<ChallengeSite> {
  let solved = false;
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    const cleared = /(^|;\s*)cf_clearance=e2e(;|$)/.test(req.headers.cookie ?? '');
    const html = (status: number, body: string, headers: Record<string, string> = {}) => void res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body);
    if (p === '/__state') return void res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(solved ? 'solved' : 'waiting');
    if (p === '/article') return html(200, read('article-about-captcha.html'));
    if (p === '/cf' || p === '/verify') {
      if (cleared) return html(200, SHOP);
      if (solved) return html(200, SHOP, { 'set-cookie': 'cf_clearance=e2e; Path=/; HttpOnly' });
      if (p === '/cf') return html(503, withScript(read('cloudflare-interstitial.html'), watcher('reload')), { 'cf-mitigated': 'challenge' });
      return html(200, withScript(read('generic-verify.html'), watcher('reload')));
    }
    const widget = WIDGETS[p];
    if (widget) return html(200, withScript(asShop(read(widget.file)), watcher({ token: widget.token })));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async vendorRoutes(ctx) {
      for (const glob of ['https://challenges.cloudflare.com/**', 'https://www.google.com/recaptcha/**', 'https://*.hcaptcha.com/**'])
        await ctx.route(glob, (route: any) => route.fulfill({ contentType: 'text/html', body: vendorFrame(route.request().url()) ?? '' }));
    },
    solve: () => void (solved = true),
    reset: () => void (solved = false),
    hits: (p) => hits.get(p) ?? 0,
    close: () => server.close(),
  };
}
