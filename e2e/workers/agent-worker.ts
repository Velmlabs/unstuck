// An agent inside a Durable Object: it drives a real Chromium over CDP and hands the page to a person through a relay.
// No nodejs_compat (see wrangler.toml): `@velmlabs/unstuck` resolves to the SDK's edge entry under the workerd condition.
import { Unstuck, type TakeoverLink, type TakeoverResult } from '@velmlabs/unstuck';
import { createCdpPage } from './cdp-page';

interface Env {
  AGENT: DurableObjectNamespace;
}

interface RunRequest {
  /** Chromium's DevTools HTTP endpoint, e.g. http://127.0.0.1:9222. */
  cdpUrl: string;
  relay: string;
  agentKey: string;
  /** The URL of the page to hand over (one tab of that Chromium). */
  pageUrl: string;
  timeoutS?: number;
}

export class AgentDO {
  private link: TakeoverLink | null = null;
  private result: TakeoverResult | { status: 'error'; detail: string } | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && pathname === '/run') {
      const run = (await req.json()) as RunRequest;
      this.link = null;
      this.result = null;
      // Returns at once: the takeover keeps running in this object (waitUntil, as the docs recommend) while the test
      // polls /link and /result.
      this.ctx.waitUntil(this.takeover(run).then(
        (r) => (this.result = r),
        (e) => (this.result = { status: 'error', detail: String((e as Error)?.message ?? e) }),
      ));
      return new Response(null, { status: 202 });
    }
    if (pathname === '/link') return this.link ? Response.json(this.link) : new Response(null, { status: 204 });
    if (pathname === '/result') return this.result ? Response.json(this.result) : new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  }

  private async takeover(run: RunRequest): Promise<TakeoverResult> {
    const { webSocketDebuggerUrl } = (await (await fetch(`${run.cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const targets = (await (await fetch(`${run.cdpUrl}/json/list`)).json()) as { id: string; type: string; url: string }[];
    const target = targets.find((t) => t.type === 'page' && t.url === run.pageUrl);
    if (!target) throw new Error(`no page at ${run.pageUrl}`);
    const page = await createCdpPage(webSocketDebuggerUrl, target.id);
    const unstuck = new Unstuck({ relay: run.relay, agentKey: run.agentKey, onLink: (l) => void (this.link = l), timeoutS: run.timeoutS });
    try {
      return await unstuck.takeover(page, { reason: 'Solve the CAPTCHA' });
    } finally {
      await unstuck.close();
    }
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    if (new URL(req.url).pathname === '/healthz') return new Response('ok');
    const name = new URL(req.url).searchParams.get('agent') ?? 'default';
    return env.AGENT.get(env.AGENT.idFromName(name)).fetch(req);
  },
};
