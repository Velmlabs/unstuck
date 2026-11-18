import type { CheckKind, HumanCheck, RescueOutcome, SiteSession } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { siteOf } from '../session/page-lock';
import { readCookies, sessionFor, setMissingCookies } from './cookies';
import { detectHumanCheck } from './detect';
import { trackMainDocument } from './main-document';
import { createRateLimiter } from './rate-limit';
import type { RenderCheck } from './render-check';
import { rescue, type TakeoverRunner } from './rescue';
import { waitForNavigation } from './settle';
import type { SessionStore } from './store';

export interface GuardOptions {
  cdp: CdpClient;
  takeover: TakeoverRunner;
  store: SessionStore;
  profile?: string;
  rescue?: readonly CheckKind[];
  remember?: boolean;
  maxRescuesPerHour?: number;
  allowedSites?: readonly string[];
  onRescue?: (o: RescueOutcome) => void;
  widgetGraceMs?: number;
  now?: () => number;
  canRenderCaptcha?: RenderCheck;
  /** How long an approval takeover waits for the person (default 300 s). */
  approvalTimeoutS?: number;
}

/** Watches one page: checks it around the agent's actions and brings in a person when a human check appears. */
export interface Guard {
  /** Before an action: loads remembered cookies for `url`'s site, and checks a page that navigated by itself. */
  before(o?: { url?: string }): Promise<RescueOutcome | null>;
  /** After an action (or navigation): looks for a check and rescues it. */
  after(o?: { requestedUrl?: string; mayNavigate?: boolean }): Promise<RescueOutcome | null>;
  check(): Promise<RescueOutcome | null>;
  /** Asks a person for something only they can do (login, a code); counts toward the hourly limit. */
  askHuman(reason: string): Promise<RescueOutcome>;
  rememberSite(domain: string): Promise<void>;
  getSession(domain?: string): Promise<SiteSession>;
  forgetSite(domain: string): Promise<void>;
  forgetAll(): Promise<void>;
  readonly lastRescue: RescueOutcome | null;
  close(): Promise<void>;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

export async function createGuard(o: GuardOptions): Promise<Guard> {
  const { cdp, store } = o;
  const scope = o.rescue ?? (['challenge', 'approval'] as const);
  const limiter = createRateLimiter(store, { maxPerHour: o.maxRescuesPerHour, now: o.now });
  await cdp.send('Page.enable');
  const tracker = await trackMainDocument(cdp);
  let dirty = false;
  let lastRescue: RescueOutcome | null = null;
  const loaded = new Set<string>();
  const offNav = cdp.on('Page.frameNavigated', (p: { frame?: { parentId?: string } }) => {
    if (!p.frame?.parentId) dirty = true;
  });

  const currentUrl = async () => (await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value ?? '';
  const userAgent = async () => (await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result?.value ?? '';
  const save = async (site: string) => {
    const cookies = await readCookies(cdp, site);
    if (cookies.length > 0) await store.save(site, cookies, await userAgent());
  };

  const run = async (check: HumanCheck, reason?: string): Promise<RescueOutcome> => {
    const outcome = await rescue(cdp, check, { takeover: o.takeover, limiter, profile: o.profile, scope, now: o.now, canRenderCaptcha: o.canRenderCaptcha, approvalTimeoutS: o.approvalTimeoutS, ...(reason ? { reason } : {}) });
    lastRescue = outcome;
    o.onRescue?.(outcome);
    if (o.remember && outcome.status === 'resolved') {
      for (const site of new Set([check.site, ...(o.allowedSites ?? []).map((s) => siteOf(s))])) await save(site);
    }
    return outcome;
  };

  // One look (detection and its rescue) at a time per page: calls that overlap (waitForNavigation and click together)
  // share it, so one check brings in one person, once.
  let looking: Promise<RescueOutcome | null> | null = null;
  const look = (requestedUrl?: string): Promise<RescueOutcome | null> => {
    if (looking) return looking;
    dirty = false;
    const p = (async () => {
      const check = await detectHumanCheck(cdp, { scope, requestedUrl, document: tracker.last(), widgetGraceMs: o.widgetGraceMs });
      return check ? run(check) : null;
    })().finally(() => {
      if (looking === p) looking = null;
    });
    looking = p;
    return p;
  };

  return {
    async before({ url } = {}) {
      if (o.remember && url) {
        const site = siteOf(hostOf(url));
        if (site && !loaded.has(site)) {
          loaded.add(site);
          const rec = await store.load(site);
          if (rec) await setMissingCookies(cdp, rec.cookies);
        }
      }
      return dirty ? look() : null;
    },
    async after({ requestedUrl, mayNavigate } = {}) {
      if (mayNavigate) await waitForNavigation(cdp);
      return look(requestedUrl);
    },
    check: () => look(),
    async askHuman(reason) {
      const url = await currentUrl();
      return run({ kind: 'ask', ruleId: 'ask_human', evidence: [reason], url, site: siteOf(hostOf(url)) }, reason);
    },
    rememberSite: (domain) => save(siteOf(domain)),
    async getSession(domain) {
      return sessionFor(cdp, domain ?? siteOf(hostOf(await currentUrl())));
    },
    forgetSite: (domain) => store.forget(domain),
    forgetAll: () => store.forgetAll(),
    get lastRescue() {
      return lastRescue;
    },
    async close() {
      offNav();
      tracker.stop();
    },
  };
}
