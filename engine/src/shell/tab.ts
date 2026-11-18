import { connectBrowser, normalizeCdpUrl } from '../direct-cdp';

/** A usage or config problem a shell command reports with exit 2 (`code` is the JSON `error`). */
export class ShellError extends Error {
  constructor(
    readonly code: string,
    readonly extra?: Record<string, unknown>,
    message: string = code,
  ) {
    super(message);
  }
}

export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
  /** The browser-level DevTools WebSocket URL (to open the paint probe tab, and as the browser's cache key). */
  browserWsUrl: string;
}

interface Target {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

const PAGE_WS = /^(wss?):\/\/([^/]+)\/devtools\/page\/([^/?#]+)/;

async function browserWs(url: string, fetchImpl: typeof fetch): Promise<string> {
  if (/^wss?:\/\//.test(url)) return url;
  let res: Response;
  try {
    res = await fetchImpl(`${url}/json/version`);
  } catch (e) {
    throw new ShellError('unreachable', undefined, `could not reach the browser at ${url}: ${(e as Error).message}`);
  }
  const v = res.ok ? ((await res.json().catch(() => ({}))) as { webSocketDebuggerUrl?: string }) : {};
  if (!v.webSocketDebuggerUrl) throw new ShellError('unreachable', undefined, `could not reach the browser at ${url}: HTTP ${res.status}`);
  return v.webSocketDebuggerUrl;
}

async function listTargets(wsUrl: string): Promise<Target[]> {
  let b: Awaited<ReturnType<typeof connectBrowser>>;
  try {
    b = await connectBrowser(wsUrl);
  } catch (e) {
    throw new ShellError('unreachable', undefined, (e as Error).message);
  }
  try {
    return (await b.send<{ targetInfos: Target[] }>('Target.getTargets')).targetInfos;
  } finally {
    await b.close();
  }
}

const isPage = (t: Target) => t.type === 'page' && !t.url.startsWith('devtools://');
const brief = (t: Target) => ({ targetId: t.targetId, url: t.url, title: t.title });

/**
 * The agent's tab: `tabId` (a CDP targetId), the tab a page-level ws://…/devtools/page/<id> URL names, or the only page
 * tab. Several page tabs without `tabId` is `several_tabs` (listing them): a wrong guess would hand the person a tab
 * the agent isn't using.
 */
export async function resolveTab(
  cdpUrl: string,
  tabId?: string,
  o: { fetchImpl?: typeof fetch; list?: (browserWsUrl: string) => Promise<Target[]> } = {},
): Promise<TabInfo> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const page = PAGE_WS.exec(cdpUrl.trim());
  let url: string;
  try {
    url = page ? `${page[1] === 'wss' ? 'https' : 'http'}://${page[2]}` : normalizeCdpUrl(cdpUrl);
  } catch (e) {
    throw new ShellError('bad_cdp_url', undefined, (e as Error).message);
  }
  const ws = await browserWs(url, fetchImpl);
  const pages = (await (o.list ?? listTargets)(ws)).filter(isPage);
  const wanted = tabId ?? page?.[3];
  if (wanted) {
    const t = pages.find((x) => x.targetId === wanted);
    if (!t) throw new ShellError('tab_not_found', { tabs: pages.map(brief) }, `no tab ${wanted} in this browser`);
    return { ...brief(t), browserWsUrl: ws };
  }
  if (pages.length === 0) throw new ShellError('no_tabs', undefined, 'the browser has no open tab');
  if (pages.length > 1) throw new ShellError('several_tabs', { tabs: pages.map(brief) }, 'several tabs are open: pass --tab <targetId>');
  return { ...brief(pages[0]!), browserWsUrl: ws };
}
