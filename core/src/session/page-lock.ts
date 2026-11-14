import type { ViewerInput } from '@velmlabs/unstuck-protocol';
import { getDomain, getPublicSuffix } from 'tldts';
import type { CdpClient } from '../cdp';

/**
 * Keeps a takeover on its own site. The human holding the link may act on the page they were handed, not on whatever
 * else the agent's browser is logged in to: the top frame can't navigate to another site (downloads from another
 * site are navigations too, so they are stopped the same way).
 * Frames inside the page stay unrestricted (CAPTCHA widgets are cross-site iframes).
 *
 * "Site" is the registrable domain from the public suffix list (private suffixes included, so github.io or
 * myshopify.com tenants are separate sites). An agent whose flow crosses sites (SSO, 3-D Secure) lists the extra
 * sites in `allowedSites`.
 */

/** The site a host belongs to: its registrable domain, or the exact host for IPs, localhost and single labels. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) return h;
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

/** True for a bare public suffix ("com", "co.uk", "github.io"): never a site an agent may allow wholesale. */
export function isPublicSuffix(host: string): boolean {
  const h = host.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return !h.includes('.') || getPublicSuffix(h, { allowPrivateDomains: true }) === h;
}

/** Whether a top-frame navigation to `url` stays on one of `sites` (each also covers its subdomains). */
export function urlAllowed(url: string, sites: readonly string[]): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  let u: URL;
  try {
    u = new URL(url.startsWith('blob:') ? url.slice(5) : url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return sites.some((s) => host === s || host.endsWith(`.${s}`));
}

export interface PageLockOptions {
  /** Sites besides the page's own that the top frame may visit (e.g. an SSO or 3-D Secure provider). */
  allowedSites?: readonly string[];
  /** Called with each URL the lock stopped. */
  onBlocked?(url: string): void;
  /** Whether the page's current site is allowed too (default true). Popups pass false: only the takeover's sites. */
  ownSite?: boolean;
}

export interface PageLock {
  /** The sites the top frame may visit. */
  readonly sites: readonly string[];
  /** Whether the page was on an allowed site (or blank) when locked. */
  readonly onAllowedPage: boolean;
  stop(): Promise<void>;
}

interface Paused {
  requestId: string;
  frameId?: string;
  request: { url: string };
}

/** Locks `cdp`'s page to its current site plus `allowedSites` until stop(). */
export async function lockPage(cdp: CdpClient, opts: PageLockOptions): Promise<PageLock> {
  let mainFrame: string | null = null;
  let current = 'about:blank';
  try {
    const tree = await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree');
    mainFrame = tree.frameTree.frame.id;
    current = tree.frameTree.frame.url;
  } catch {
    // Unknown main frame: every document request is checked until a top-frame navigation tells us which one it is.
  }
  const sites = [...(opts.allowedSites ?? []).map((s) => s.toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''))];
  try {
    const own = new URL(current);
    if (opts.ownSite !== false && (own.protocol === 'https:' || own.protocol === 'http:')) sites.push(siteOf(own.hostname));
  } catch {
    // about:blank or similar: only the listed sites
  }
  let lastAllowed = current;
  const allowTop = (url: string): boolean => urlAllowed(url, sites);
  const blocked = (url: string) => opts.onBlocked?.(url);

  const offPaused = cdp.on('Fetch.requestPaused', (e: Paused) => {
    const top = mainFrame === null || e.frameId === undefined || e.frameId === mainFrame;
    // Aborted (not BlockedByClient): the navigation is cancelled and the current page stays, with no error page.
    if (top && !allowTop(e.request.url)) {
      blocked(e.request.url);
      void cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Aborted' }).catch(() => {});
    } else void cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
  });
  // Back/forward can restore a page from cache without a request: if the top frame lands off-site anyway, go back.
  const offNavigated = cdp.on('Page.frameNavigated', (e: { frame: { id: string; parentId?: string; url: string } }) => {
    if (e.frame.parentId) return;
    mainFrame = e.frame.id;
    if (allowTop(e.frame.url)) lastAllowed = e.frame.url;
    else {
      blocked(e.frame.url);
      void cdp.send('Page.navigate', { url: lastAllowed }).catch(() => {});
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  // A service worker can answer a navigation without any request reaching Fetch: bypass them while locked.
  await cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});

  let stopped = false;
  return {
    sites,
    onAllowedPage: urlAllowed(current, sites),
    async stop() {
      if (stopped) return;
      stopped = true;
      offPaused();
      offNavigated();
      await cdp.send('Fetch.disable').catch(() => {});
      await cdp.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => {});
    },
  };
}

const ALT = 1;
const META = 4;
const SHIFT = 8;
const HISTORY_KEYS = new Set(['BrowserBack', 'BrowserForward', 'BrowserHome']);

/**
 * What a link holder's input may do to the page, enforced by the engine (a modified viewer can send anything):
 * plain left clicks only (Ctrl/Cmd/Shift/Alt-clicks open tabs and windows or download links; middle and right clicks
 * open tabs and menus), no modified Enter/Space (they open a focused link elsewhere), no context menu, and no
 * browser history keys. Returns null to drop the message.
 */
export function safeInput(msg: ViewerInput): ViewerInput | null {
  if (msg.t === 'mouse') {
    if (msg.button === 'middle' || msg.button === 'right') return null;
    return msg.modifiers === 0 ? msg : { ...msg, modifiers: 0 };
  }
  if (msg.t === 'key') {
    if (HISTORY_KEYS.has(msg.key) || msg.key === 'ContextMenu' || (msg.key === 'F10' && msg.modifiers & SHIFT)) return null;
    // On a focused link, a modified Enter or Space opens it in another tab or window: send it plain.
    if ((msg.key === 'Enter' || msg.key === ' ') && msg.modifiers !== 0) return { ...msg, modifiers: 0 };
    if (msg.modifiers === ALT && (msg.key === 'ArrowLeft' || msg.key === 'ArrowRight')) return null;
    if (msg.modifiers === META && (msg.key === '[' || msg.key === ']')) return null;
  }
  return msg;
}
