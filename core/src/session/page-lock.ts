import type { ViewerInput } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';

/**
 * Keeps a takeover on its own site. The human holding the link may act on the page they were handed, not on whatever
 * else the agent's browser is logged in to: the top frame can't navigate to another site, and downloads are denied.
 * Frames inside the page stay unrestricted (CAPTCHA widgets are cross-site iframes).
 *
 * "Site" is approximated without a public-suffix list: the last two labels of the host, or three under the shared
 * suffixes below. An agent whose flow crosses sites (SSO, 3-D Secure) lists the extra sites in `allowedSites`.
 */

const SHARED_SUFFIXES = new Set([
  // country-code second levels
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in', 'gov.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.cn', 'net.cn', 'org.cn',
  'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.ph', 'com.vn', 'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'my.id',
  'co.za', 'co.il', 'co.th', 'in.th', 'com.pk', 'com.ng', 'com.eg', 'com.sa', 'com.ua',
  // hosting platforms where every customer has a subdomain
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'appspot.com',
  'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'onrender.com', 'fly.dev',
  'deno.dev', 'glitch.me', 'repl.co', 'replit.app', 'surge.sh', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
  's3.amazonaws.com', 'wixsite.com', 'myshopify.com', 'webflow.io', 'framer.app', 'bubbleapps.io',
]);

/** The site a host belongs to: exact for IPs, localhost and single labels; otherwise see the module comment. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h) || !h.includes('.')) return h;
  const labels = h.split('.');
  const two = labels.slice(-2).join('.');
  return SHARED_SUFFIXES.has(two) && labels.length >= 3 ? labels.slice(-3).join('.') : two;
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
  /** For popups that open on about:blank: the site of the first http(s) page they load becomes their own site. */
  adoptFirstSite?: boolean;
}

export interface PageLock {
  /** The sites the top frame may visit (the page's own first, unless it had none, then the listed ones). */
  readonly sites: readonly string[];
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
    if (own.protocol === 'https:' || own.protocol === 'http:') sites.push(siteOf(own.hostname));
  } catch {
    // about:blank or similar: only the listed sites
  }
  let lastAllowed = current;
  let adopt = opts.adoptFirstSite === true && sites.length === (opts.allowedSites ?? []).length; // no own site yet
  /** Whether the top frame may go to `url`; a popup without a site of its own adopts the first one it loads. */
  const allowTop = (url: string): boolean => {
    if (adopt && /^https?:/i.test(url)) {
      adopt = false;
      try {
        sites.push(siteOf(new URL(url).hostname));
      } catch {
        // unparsable: falls through to the check below, which refuses it
      }
    }
    return urlAllowed(url, sites);
  };
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
  await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

  let stopped = false;
  return {
    sites,
    async stop() {
      if (stopped) return;
      stopped = true;
      offPaused();
      offNavigated();
      await cdp.send('Fetch.disable').catch(() => {});
      await cdp.send('Page.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
    },
  };
}

const ALT = 1;
const META = 4;
const HISTORY_KEYS = new Set(['BrowserBack', 'BrowserForward', 'BrowserHome']);

/**
 * What a link holder's input may do to the page, enforced by the engine (a modified viewer can send anything):
 * plain left clicks only (Ctrl/Cmd/Shift/Alt-clicks open tabs and windows or download links; middle and right clicks
 * open tabs and menus), and no browser history keys. Returns null to drop the message.
 */
export function safeInput(msg: ViewerInput): ViewerInput | null {
  if (msg.t === 'mouse') {
    if (msg.button === 'middle' || msg.button === 'right') return null;
    return msg.modifiers === 0 ? msg : { ...msg, modifiers: 0 };
  }
  if (msg.t === 'key') {
    if (HISTORY_KEYS.has(msg.key)) return null;
    if (msg.modifiers === ALT && (msg.key === 'ArrowLeft' || msg.key === 'ArrowRight')) return null;
    if (msg.modifiers === META && (msg.key === '[' || msg.key === ']')) return null;
  }
  return msg;
}
