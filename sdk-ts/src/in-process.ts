import {
  buildRelayTransport,
  cloudAlertsFor,
  createCloudAlerter,
  createEngine,
  hostnames,
  selectTransport,
  sendTakeoverAlert,
  type AlertOutcome,
  type CdpClient,
  type CloudAlerter,
  type Engine,
  type PopupSource,
  type TransportChoice,
} from '@velmlabs/unstuck-core';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { attachPage, PageClosedError, type AttachedPage } from './attach';
import { startKeepAlive, toCdpClient } from './cdp-adapter';
import { UnstuckConfigError } from './errors';
import { callUserOnLink, optionEnv, validateOptions, type TakeoverLink, type TakeoverOptions, type UnstuckOptions } from './options';
import { VERSION } from './version';

/** What the in-process entry says when no relay is configured (the Node entry passes its own wording). */
export const NO_RELAY_EDGE = 'in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey';

/**
 * The default link handler (console.log: Workers have no stderr, and their logs are stored). With a phone alert on its way
 * it waits for the outcome and logs the link only when no paired phone got it, since then the log is the only way to reach
 * a human; with `'required'` that case fails the takeover (alert_failed: the link was never shown to anyone, so nobody can
 * have joined), so nothing is logged. Without an alert (a self-hosted relay, or `alerts: false`) the log is the only
 * channel, so the link is logged at once. Never prints a 6-digit code: requireCode needs its own onLink.
 */
function defaultOnLink(l: TakeoverLink, alert: Promise<AlertOutcome> | null, alerts: TakeoverOptions['alerts']): void {
  const full = () => console.log(`Unstuck: a human is needed (${l.reason}) → ${l.url}`);
  if (!alert) return full();
  void alert.then((r) => {
    if (r.delivered > 0) console.log(`Unstuck: a human is needed (${l.reason}), link sent to ${r.delivered} paired phone(s) (session ${l.sessionId})`);
    else if (alerts !== 'required') full();
  });
}

/** Playwright and Puppeteer pages are event emitters that emit 'popup' with the new page (attachPage needs `on`). */
type PageEvents = { on(e: string, cb: (p: unknown) => void): unknown; off?(e: string, cb: (p: unknown) => void): unknown };

function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Unstuck running core's engine in this JavaScript runtime (Workers, or `mode: 'in-process'` on Node). */
export class InProcessUnstuck {
  private readonly env: Record<string, string | undefined>;
  private readonly choice: TransportChoice;
  private readonly alerter: CloudAlerter | null;
  private engine: Engine | null = null;
  /** Bumped by close(): a takeover that was still attaching when it ran must not start a new engine. */
  private generation = 0;
  private readonly inFlight = new Set<Promise<TakeoverResult>>();

  constructor(
    private readonly opts: UnstuckOptions,
    env: Record<string, string | undefined>,
    private readonly noRelay = NO_RELAY_EDGE,
  ) {
    validateOptions(opts);
    this.env = { ...env, ...optionEnv(opts) };
    this.choice = selectTransport({}, this.env);
    const cloud = cloudAlertsFor(this.choice, this.env);
    this.alerter = cloud ? createCloudAlerter({ ...cloud, fetch: opts.fetch }) : null;
  }

  async takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    const run = this.run(page, o);
    this.inFlight.add(run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  private async run(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    if (this.choice.kind !== 'relay') throw new UnstuckConfigError(this.noRelay);
    // The choice is a relay here, so no alerter means the relay is not Unstuck Cloud's (relay, or UNSTUCK_RELAY_URL).
    if (o.alerts === 'required' && !this.alerter)
      throw new UnstuckConfigError("alerts: 'required' needs Unstuck Cloud (apiKey): a self-hosted relay sends no phone alerts");
    const requireCode = o.requireCode ?? this.opts.requireCode ?? this.env.UNSTUCK_REQUIRE_CODE === '1';
    if (requireCode && !this.opts.onLink)
      throw new TypeError('requireCode needs an onLink handler that sends the 6-digit code by a different channel than the link (printed together, the code protects nothing)');
    const generation = this.generation;
    let attached: AttachedPage;
    try {
      attached = await attachPage(page);
    } catch (e) {
      if (e instanceof PageClosedError) return { status: 'failed', sessionId: '', url: '', durationS: 0, detail: 'page_closed' };
      throw e;
    }
    if (generation !== this.generation) {
      // close() ran while the page was attaching: cancelled like the takeovers it ended (core's engine_closed shape).
      await attached.detach();
      return { status: 'cancelled', sessionId: '', url: '', durationS: 0, detail: 'engine_closed' };
    }
    const cdp = toCdpClient(attached);
    const stopKeepAlive = startKeepAlive(cdp);
    const popups: AttachedPage[] = [];
    const popupCbs = new Set<(popup: CdpClient) => void>();
    let ended = false;
    // Follow popups (e.g. a CAPTCHA provider's window) while the human is in control.
    const onPopup = async (popupPage: unknown) => {
      try {
        const popup = await attachPage(popupPage);
        // Attached after the takeover ended: nobody follows it any more.
        if (ended) return void (await popup.detach());
        popups.push(popup);
        const client = toCdpClient(popup);
        for (const cb of [...popupCbs]) cb(client);
      } catch {
        // a popup that closes before we can attach is simply not followed
      }
    };
    const source: PopupSource = {
      onPopup(cb) {
        popupCbs.add(cb);
        return () => void popupCbs.delete(cb);
      },
    };
    const events = page as PageEvents;
    events.on('popup', onPopup);
    const site = siteOf(attached.url());
    const userOnLink = this.opts.onLink;
    try {
      return await this.ensureEngine().takeover(cdp, {
        reason: o.reason,
        timeoutS: o.timeoutS ?? this.opts.timeoutS,
        site,
        requireCode,
        allowedSites: hostnames(o.allowedSites),
        popups: source,
        onLink: (info, takeover) => {
          // The alert starts first: whatever the link handler does, the paired phones get the link.
          const alert = sendTakeoverAlert(this.alerter, o.alerts, info, site, takeover);
          const link: TakeoverLink = { url: info.url, reason: info.reason, sessionId: info.sessionId, expiresAt: info.expiresAt, ...(info.code ? { code: info.code } : {}) };
          if (userOnLink) callUserOnLink(userOnLink, link);
          else defaultOnLink(link, alert, o.alerts);
        },
      });
    } finally {
      ended = true;
      stopKeepAlive();
      events.off?.('popup', onPopup);
      for (const popup of popups) await popup.detach();
      await attached.detach();
    }
  }

  /**
   * Cancels running takeovers (`engine_closed`), also those still attaching their page, closes the relay sockets and
   * resolves once they have all ended. A later takeover starts a new engine.
   */
  async close(): Promise<void> {
    this.generation++;
    const engine = this.engine;
    this.engine = null;
    await engine?.close();
    await Promise.allSettled([...this.inFlight]);
  }

  private ensureEngine(): Engine {
    // Only called once the choice is a relay.
    const choice = this.choice as Extract<TransportChoice, { kind: 'relay' }>;
    this.engine ??= createEngine({ transport: buildRelayTransport(choice, { env: this.env, version: VERSION, warn: (l) => console.error(l) }) });
    return this.engine;
  }
}
