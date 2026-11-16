// The same flow as examples/cloudflare-worker, with the Cloudflare Agents SDK: an Agent opens a page in Browser
// Rendering, reaches a step it can't do, hands it to a person with Unstuck, and carries on once they tap Done.
//
//   POST /agents/portal-agent/default/start   starts a run (202), or reports the one already running
//   GET  /agents/portal-agent/default/status  the agent's state: { status, detail }
//
// Both need `Authorization: Bearer <CONTROL_TOKEN>`. Guide: https://unstuck.sh/docs/cloudflare-workers/
import puppeteer from '@cloudflare/puppeteer';
import { Unstuck, UnstuckConfigError, type UnstuckOptions } from '@velmlabs/unstuck';
import { Agent, routeAgentRequest, type Connection } from 'agents';

interface Env {
  BROWSER: Fetcher;
  PortalAgent: DurableObjectNamespace<PortalAgent>;
  /** Shared secret for every request to the agent. */
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

/** The agent's state: the outcome, never the link. `runId` and `launched` guard against running one start twice. */
type State =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number; runId: string; launched?: boolean }
  | { status: string; detail?: string };

/**
 * The run is a scheduled task, and scheduled tasks run in a Durable Object alarm, which has a 15-minute wall-time limit.
 * 10 minutes for the person leaves room to launch the browser and to carry on afterwards.
 */
const TIMEOUT_S = 600;
/** A run older than this was cut short (the object was evicted mid-run): a new /start may begin again. */
const STALE_MS = (TIMEOUT_S + 120) * 1000;
/** Browser Rendering's inactivity timeout, in ms (20 minutes, its maximum at the time of writing). */
const KEEP_ALIVE_MS = 1_200_000;

export class PortalAgent extends Agent<Env, State> {
  initialState: State = { status: 'idle' };

  async onRequest(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const state = this.state;
    if (req.method === 'POST' && pathname.endsWith('/start')) {
      const running = state.status === 'running' && 'startedAt' in state && Date.now() - state.startedAt < STALE_MS;
      if (running) return Response.json(publicState(state), { status: 202 }); // already running: don't start a second browser
      const runId = crypto.randomUUID();
      this.setState({ status: 'running', startedAt: Date.now(), runId });
      // Run in the background, right away. One attempt: a retry would start a second takeover and ping the person twice.
      await this.schedule(0, 'run', { runId }, { retry: { maxAttempts: 1 } });
      return Response.json({ status: 'running' }, { status: 202 });
    }
    if (req.method === 'GET' && pathname.endsWith('/status')) return Response.json(publicState(state));
    return new Response('not found', { status: 404 });
  }

  /** Clients may read the state (over a WebSocket too) but only the agent changes it. */
  validateStateChange(_next: State, source: Connection | 'server'): void {
    if (source !== 'server') throw new Error('the state is read-only');
  }

  async run({ runId }: { runId: string }): Promise<void> {
    const state = this.state;
    if (state.status !== 'running' || !('runId' in state) || state.runId !== runId) return; // finished or superseded
    if (state.launched) {
      // The alarm was delivered again after the object was evicted mid-run. Don't hand the page over a second time.
      this.setState({ status: 'failed', detail: 'interrupted' });
      return;
    }
    this.setState({ ...state, launched: true });

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
      this.setState(outcome); // never throw from here: the scheduled task would be retried
      await browser?.close().catch(() => {});
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const gate = (r: Request) => checkControlToken(r, env);
    return (await routeAgentRequest(req, env, { onBeforeRequest: gate, onBeforeConnect: gate })) ?? new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** `{ status, detail }`, without the bookkeeping fields. */
function publicState(state: State): State {
  if (state.status === 'running' && 'startedAt' in state) return { status: 'running', startedAt: state.startedAt };
  return state;
}

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
