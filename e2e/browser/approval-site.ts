// A sign-in that waits for a push approval on the person's phone, for the approval end-to-end tests. /login shows the
// prompt and polls /__state; once the test (standing in for the person's phone) calls approve(), the page moves on to
// /inbox by itself, as a real sign-in does after the push is approved.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const PROMPT_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Sign in to Example Mail</title></head><body>' +
  '<h1>Approve sign-in request</h1><p>We sent a notification to your phone. Open the Example Authenticator app and approve the request to continue.</p>' +
  `<script>const t = setInterval(() => fetch('/__state').then((r) => r.text()).then((s) => { if (s === 'approved') { clearInterval(t); location.href = '/inbox'; } }), 500);</script>` +
  '</body></html>';
export const INBOX_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Inbox</title></head><body><h1>Inbox</h1><p>You have 3 new messages.</p></body></html>';

export interface ApprovalSite {
  url: string;
  /** The person approved the push on their phone: the prompt's next state poll sees it and moves on. */
  approve(): void;
  /** A new sign-in, not approved yet (and the hit counts start again). */
  reset(): void;
  hits(path: string): number;
  close(): void;
}

export async function startApprovalSite(): Promise<ApprovalSite> {
  let approved = false;
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    const html = (body: string) => void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    if (p === '/__state') return void res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(approved ? 'approved' : 'waiting');
    if (p === '/login') return html(PROMPT_HTML);
    if (p === '/inbox') return html(INBOX_HTML);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    approve: () => void (approved = true),
    reset: () => {
      approved = false;
      hits.clear();
    },
    hits: (p) => hits.get(p) ?? 0,
    close: () => server.close(),
  };
}
