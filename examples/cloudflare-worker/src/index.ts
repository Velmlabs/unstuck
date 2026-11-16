// A Durable Object opens a page in Cloudflare Browser Rendering, reaches a step it can't do, hands it to a person
// with Unstuck, and carries on once they tap Done. The pattern is the one in https://unstuck.sh/docs/cloudflare-workers/
//
//   POST /start   starts a run (202), or reports the one already running
//   GET  /status  { status, detail }: idle, running, then resolved / cancelled / timed_out / failed
//
// Both need `Authorization: Bearer <CONTROL_TOKEN>`.
import puppeteer from '@cloudflare/puppeteer';
import { Unstuck, UnstuckConfigError, type UnstuckOptions } from '@velmlabs/unstuck';
import { DurableObject } from 'cloudflare:workers';

interface Env {
  BROWSER: Fetcher;
  PORTAL_AGENT: DurableObjectNamespace<PortalAgent>;
  /** Shared secret for /start and /status. */
  CONTROL_TOKEN?: string;
  /** Unstuck Cloud. */
  UNSTUCK_API_KEY?: string;
  /** Or your own relay (wss://…) and its agent key. */
  UNSTUCK_RELAY_URL?: string;
  UNSTUCK_AGENT_KEY?: string;
  /** The page to open. */
  TARGET_URL?: string;
  /** Phone alerts with Unstuck Cloud: 'on' (default), 'required' or 'off'. */
  UNSTUCK_ALERTS?: string;
}

/** What the object stores: the outcome, never the link. */
type State = { status: 'idle' } | { status: 'running'; startedAt: number } | { status: string; detail?: string };

const TIMEOUT_S = 900;
/** A run older than this was cut short (the object was evicted mid-run and never reached `finally`): start again. */
const STALE_MS = (TIMEOUT_S + 120) * 1000;
/** Browser Rendering's inactivity timeout, in ms (20 minutes, its maximum at the time of writing). */
const KEEP_ALIVE_MS = 1_200_000;

export class PortalAgent extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const state = (await this.ctx.storage.get<State>('state')) ?? { status: 'idle' };
    if (req.method === 'POST' && pathname === '/start') {
      const running = state.status === 'running' && 'startedAt' in state && Date.now() - state.startedAt < STALE_MS;
      if (!running) {
        await this.ctx.storage.put('state', { status: 'running', startedAt: Date.now() });
        this.ctx.waitUntil(this.run());
        return Response.json({ status: 'running' }, { status: 202 });
      }
      return Response.json(state, { status: 202 }); // already running: don't start a second browser
    }
    if (req.method === 'GET' && pathname === '/status') return Response.json(state);
    return new Response('not found', { status: 404 });
  }

  async run(): Promise<void> {
    let outcome: State = { status: 'failed', detail: 'error' };
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    try {
      const { options, alerts } = unstuckConfig(this.env);
      const unstuck = new Unstuck(options); // throws UnstuckConfigError on a bad setup, before a browser is launched

      // keep_alive is Browser Rendering's inactivity timeout. Unstuck also pings the page every 60 s during a takeover.
      browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
      const page = await browser.newPage();
      await page.goto(targetUrl(this.env));

      // The agent's own work would go here. This demo pretends it reached a login it can't do.
      const result = await unstuck.takeover(page, {
        reason: 'Demo: look at the page, then tap Done to hand it back',
        timeoutS: TIMEOUT_S,
        alerts,
      });
      outcome = { status: result.status, detail: result.detail };

      if (result.status === 'resolved') {
        // Carry on in the same page: it has whatever the person did (a login, a solved CAPTCHA).
        console.log(`Back from the person: carrying on at "${await page.title()}"`);
      }
    } catch (e) {
      // Only setup mistakes reject (UnstuckConfigError); everything else here is a browser or network error.
      outcome = { status: 'failed', detail: e instanceof UnstuckConfigError ? `config: ${e.message}` : 'error' };
      console.error('PortalAgent run failed:', e instanceof Error ? e.message : e);
    } finally {
      await this.ctx.storage.put('state', outcome);
      await browser?.close().catch(() => {});
      // Or call a webhook with `outcome` here, so the caller doesn't have to poll.
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const denied = await checkControlToken(req, env);
    if (denied) return denied;
    return env.PORTAL_AGENT.get(env.PORTAL_AGENT.idFromName('portal-check')).fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** Unstuck Cloud when UNSTUCK_API_KEY is set, else your own relay. */
function unstuckConfig(env: Env): { options: UnstuckOptions; alerts: boolean | 'required' } {
  const mode = (env.UNSTUCK_ALERTS ?? 'on').trim().toLowerCase();
  if (!['on', 'off', 'required'].includes(mode)) throw new UnstuckConfigError("UNSTUCK_ALERTS must be 'on', 'off' or 'required'");
  const alerts = mode === 'required' ? 'required' : mode === 'on';
  if (env.UNSTUCK_API_KEY) return { options: { apiKey: env.UNSTUCK_API_KEY }, alerts };
  // A self-hosted relay sends no phone alerts ('required' would throw), so the link is logged.
  return { options: { relay: env.UNSTUCK_RELAY_URL, agentKey: env.UNSTUCK_AGENT_KEY }, alerts: false };
}

function targetUrl(env: Env): string {
  const url = new URL(env.TARGET_URL || 'https://example.com');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('TARGET_URL must be an http(s) URL');
  return url.href;
}

/** A Response refusing the request, or undefined when it carries `Authorization: Bearer <CONTROL_TOKEN>`. */
async function checkControlToken(req: Request, env: Env): Promise<Response | undefined> {
  if (!env.CONTROL_TOKEN) return new Response('set the CONTROL_TOKEN secret first (npx wrangler secret put CONTROL_TOKEN)', { status: 503 });
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  // Compare digests so the comparison takes the same time whatever the input's length.
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(given), digest(env.CONTROL_TOKEN)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  return undefined;
}
