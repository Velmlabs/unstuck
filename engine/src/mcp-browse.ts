// Unstuck Browser's MCP tools: fetch_page and the session tools, on the browser BrowserSession drives. A human check a
// page shows is rescued inside the tool call; a person who needs longer gets the link, and resume_after_human finishes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RescueOutcome, SiteSession, TakeoverResult } from '@velmlabs/unstuck-protocol';
import { deleteCookies, readCookies, siteOf, type Guard, type LinkInfo, type TakeoverControl } from '@velmlabs/unstuck-core';
import type { BrowserSession } from './browser/session';
import { extractPage, type ContentFormat } from './browser/extract';
import type { DirectCdp } from './direct-cdp';
import { DEFAULT_WAIT_S, linkLead, MAX_WAIT_S, START_TOOL, structured, text, WAIT_TOOL, within, type Out, type TwoStep, type TwoStepRegistry } from './mcp';

export const FETCH_TOOL = 'fetch_page';
export const SESSION_TOOL = 'get_session';
export const FORGET_TOOL = 'forget_site';
export const REMEMBER_TOOL = 'remember_site';
export const RESUME_TOOL = 'resume_after_human';
export const BROWSE_TOOL_NAMES = [FETCH_TOOL, SESSION_TOOL, FORGET_TOOL, REMEMBER_TOOL, RESUME_TOOL] as const;

const LOAD_TIMEOUT_MS = 30_000;
const TERMS = "A person solves any human check (CAPTCHA, Cloudflare's \"verify you are human\"); never try to solve one yourself. The site's terms still apply.";

/** A browsing tool's rescue that outlived the call: resume_after_human finishes it. */
export interface BrowseRescue {
  outcome: Promise<RescueOutcome>;
  finish(): Promise<Out>;
}

const sessionOut = (s: SiteSession): Out => ({ site: s.site, user_agent: s.userAgent, cookies: s.cookies, cookie_header: s.cookieHeader });

/** A rescue that ended without the person getting past it. */
const failedOut = (o: RescueOutcome): CallToolResult =>
  structured(
    {
      status: o.status,
      ...(o.detail ? { detail: o.detail } : {}),
      check: { kind: o.check.kind, ...(o.check.vendor ? { vendor: o.check.vendor } : {}), site: o.check.site },
    },
    true,
  );

/** The finished tool result once the rescue (if any) is over. Errors in `finish` are the tool's error text. */
async function done(o: RescueOutcome | null, finish: () => Promise<Out>): Promise<CallToolResult> {
  if (o && o.status !== 'resolved') return failedOut(o);
  try {
    const out = await finish();
    return structured(o ? { ...out, rescued: true, waited_s: o.waitedS } : out, false);
  } catch (e) {
    return text((e as Error).message, true);
  }
}

export function registerBrowseTools(
  server: McpServer,
  d: { session: BrowserSession; twoSteps: TwoStepRegistry; inToolWaitMs: number; lookup: (id: string) => TwoStep | CallToolResult },
): void {
  const { session } = d;

  /** Runs one browsing action with the guard; a person who needs longer than inToolWaitMs gets the link instead. */
  async function guarded(action: (tab: { cdp: DirectCdp; guard: Guard }) => Promise<RescueOutcome | null>, finish: () => Promise<Out>): Promise<CallToolResult> {
    if (session.holder) return structured({ error: 'human_takeover_active', takeover_id: session.holder }, true);
    let tab: { cdp: DirectCdp; guard: Guard };
    try {
      tab = await session.tab();
    } catch (e) {
      return text((e as Error).message, true);
    }
    let onLink!: (v: { info: LinkInfo; control: TakeoverControl }) => void;
    const linked = new Promise<{ info: LinkInfo; control: TakeoverControl }>((r) => (onLink = r));
    const off = session.onTakeoverStart((info, control) => onLink({ info, control }));
    const outcome = action(tab);
    outcome.catch(() => {}).finally(off);
    let quick: { o: RescueOutcome | null } | undefined;
    try {
      quick = await within(
        outcome.then((o) => ({ o })),
        d.inToolWaitMs,
      );
      // Past the in-call wait: whichever comes first, the end of the rescue or its link.
      const next = quick ?? (await Promise.race([outcome.then((o) => ({ o })), linked.then((l) => ({ l }))]));
      if ('o' in next) return done(next.o, finish);
      const { info, control } = next.l;
      const result = outcome.then(
        (o): TakeoverResult => o?.takeover ?? { status: 'failed', sessionId: info.sessionId, url: info.url, durationS: o?.waitedS ?? 0, detail: o?.status ?? 'no_rescue' },
        (e): TakeoverResult => ({ status: 'failed', sessionId: info.sessionId, url: info.url, durationS: 0, detail: (e as Error).message }),
      );
      let memo: Promise<CallToolResult> | null = null;
      const browse: BrowseRescue = { outcome: outcome.then((o) => o!), finish };
      const t: TwoStep & { answer?: () => Promise<CallToolResult> } = { id: info.sessionId, info, control, result, final: null, returned: false, byAgent: false, browse };
      t.answer = () => (memo ??= outcome.then((o) => done(o, finish)));
      d.twoSteps.add(t);
      const expiresInS = Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000));
      const out: Out = { status: 'human_needed', takeover_id: t.id, link: info.url, ...(info.code ? { code: info.code } : {}), expires_in_s: expiresInS, reason: info.reason };
      const lead = linkLead(info, { expiresInS, next: `Then call ${RESUME_TOOL} with takeover_id "${t.id}"; while it answers "waiting", call it again.` });
      return structured(out, false, lead);
    } catch (e) {
      return text((e as Error).message, true);
    }
  }

  server.registerTool(
    FETCH_TOOL,
    {
      title: 'Fetch a page in a real browser',
      description:
        'Open a URL in a real browser tab and return its readable content (markdown by default, or text or html), the final URL and the HTTP ' +
        'status. Use it when a plain download is blocked or the page needs JavaScript. If the page shows a human check, a person is brought ' +
        `in: a quick one is solved within this call (rescued: true); a longer one returns status "human_needed" with a link to show the person, ` +
        `then call ${RESUME_TOOL}. include_session adds the site's cookies and user agent (for curl or an HTTP client). ` +
        TERMS,
      inputSchema: {
        url: z.string().describe('The http or https URL to open.'),
        format: z.enum(['markdown', 'text', 'html']).optional().describe('markdown (default): the readable article; text: plain text; html: the whole page.'),
        include_session: z.boolean().optional().describe("Also return the site's cookies, Cookie header and user agent."),
      },
    },
    async ({ url, format, include_session }) => {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        // not a URL
      }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return text('fetch_page opens http and https URLs only', true);
      let status = 0;
      let cdpRef: DirectCdp | null = null;
      let guardRef: Guard | null = null;
      return guarded(
        async ({ cdp, guard }) => {
          cdpRef = cdp;
          guardRef = guard;
          const pre = await guard.before({ url });
          if (pre && pre.status !== 'resolved') return pre;
          let frameId = '';
          const offResponse = cdp.on('Network.responseReceived', (p: { type?: string; frameId?: string; response?: { status?: number } }) => {
            if (p.type === 'Document' && (!frameId || p.frameId === frameId)) status = p.response?.status ?? status;
          });
          try {
            let loaded!: () => void;
            const load = new Promise<void>((r) => (loaded = r));
            const offLoad = cdp.on('Page.loadEventFired', () => loaded());
            const nav = await cdp.send<{ frameId: string; errorText?: string }>('Page.navigate', { url });
            frameId = nav.frameId;
            if (nav.errorText) {
              offLoad();
              throw new Error(`could not open ${url}: ${nav.errorText}`);
            }
            await within(load, LOAD_TIMEOUT_MS);
            offLoad();
            return await guard.after({ requestedUrl: url });
          } finally {
            // The status of the page the person left behind counts too (a challenge's own reload).
            void Promise.resolve().then(() => setTimeout(offResponse, 0));
          }
        },
        async () => {
          const cdp = cdpRef!;
          const page = await extractPage(cdp, (format ?? 'markdown') as ContentFormat);
          const finalUrl = (await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value ?? url;
          return {
            final_url: finalUrl,
            status,
            title: page.title,
            content: page.content,
            ...(page.truncated ? { truncated: true } : {}),
            ...(include_session ? { session: sessionOut(await guardRef!.getSession(siteOf(new URL(finalUrl).hostname))) } : {}),
          };
        },
      );
    },
  );

  const domainInput = { domain: z.string().min(1).describe('The site, e.g. "example.com" (its subdomains are included).') };
  /** A session tool: refused while a person holds the tab, otherwise runs on the guard. */
  async function onGuard(fn: (tab: { cdp: DirectCdp; guard: Guard }) => Promise<Out>): Promise<CallToolResult> {
    if (session.holder) return structured({ error: 'human_takeover_active', takeover_id: session.holder }, true);
    try {
      return structured(await fn(await session.tab()), false);
    } catch (e) {
      return text((e as Error).message, true);
    }
  }

  server.registerTool(
    SESSION_TOOL,
    {
      title: "Get a site's session",
      description: `The browser's cookies, Cookie header and user agent for a site, e.g. to download a file with curl after ${FETCH_TOOL} got past a check. Treat them like a password.`,
      inputSchema: domainInput,
    },
    ({ domain }) => onGuard(async ({ guard }) => sessionOut(await guard.getSession(siteOf(domain)))),
  );

  server.registerTool(
    FORGET_TOOL,
    {
      title: 'Forget a site',
      description: "Delete a site's remembered cookies from this profile (and from the browser, when Unstuck started it).",
      inputSchema: domainInput,
    },
    ({ domain }) =>
      onGuard(async ({ cdp, guard }) => {
        const site = siteOf(domain);
        await guard.forgetSite(site);
        if (session.launched) await deleteCookies(cdp, await readCookies(cdp, site));
        return { forgotten: domain };
      }),
  );

  server.registerTool(
    REMEMBER_TOOL,
    {
      title: 'Remember a site',
      description: "Save a site's cookies to this profile now, so the next visit (even after a restart) starts signed in or past its check.",
      inputSchema: domainInput,
    },
    ({ domain }) =>
      onGuard(async ({ guard }) => {
        const site = siteOf(domain);
        await guard.rememberSite(site);
        return { remembered: domain, cookies: (await session.store.load(site))?.cookies.length ?? 0 };
      }),
  );

  server.registerTool(
    RESUME_TOOL,
    {
      title: 'Resume after a person',
      description:
        `Finish a browsing call that returned status "human_needed". Returns that call's result once the person is done (with rescued: true), or ` +
        `{status: "waiting", joined, expires_in_s} after max_wait_s seconds (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}): then call it again. ` +
        'It never opens the page again.',
      inputSchema: {
        takeover_id: z.string().min(1).describe(`The takeover_id the "human_needed" result gave.`),
        max_wait_s: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`Seconds to wait before answering "waiting" (default ${DEFAULT_WAIT_S}).`),
      },
    },
    async ({ takeover_id, max_wait_s }, extra) => {
      const known = d.twoSteps.get(takeover_id);
      if (known && !known.browse) return text(`takeover_id "${takeover_id}" was started with ${START_TOOL}; use ${WAIT_TOOL}`, true);
      if (!known) {
        const t = d.lookup(takeover_id);
        return 'content' in t ? t : text(`No takeover with takeover_id "${takeover_id}" on this Unstuck server.`, true);
      }
      const t = known as TwoStep & { answer: () => Promise<CallToolResult> };
      const settled = await within(t.browse!.outcome, (max_wait_s ?? DEFAULT_WAIT_S) * 1000, extra.signal);
      if (!settled)
        return structured(
          { status: 'waiting', takeover_id, joined: t.control.joined(), expires_in_s: Math.max(0, Math.round((t.info.expiresAt - Date.now()) / 1000)) },
          false,
          `The person ${t.control.joined() ? 'is in the takeover' : 'has not opened the link and tapped Start yet'}. Call ${RESUME_TOOL} again with takeover_id "${takeover_id}".`,
        );
      t.returned = true;
      return t.answer();
    },
  );
}
