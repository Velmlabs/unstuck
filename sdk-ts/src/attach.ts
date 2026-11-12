/** A CDP session on the developer's page, regardless of automation library. */
export interface AttachedPage {
  pageId: string;
  url(): string;
  send(method: string, params?: object): Promise<unknown>;
  subscribe(event: string, cb: (params: unknown) => void): void;
  onClose(cb: (reason: string) => void): void;
  detach(): Promise<void>;
}

interface CdpSessionLike {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, cb: (params: unknown) => void): unknown;
  detach(): Promise<unknown>;
}
interface PageLike {
  on(event: string, cb: () => void): unknown;
  off?(event: string, cb: () => void): unknown;
  url?(): string;
}

/** The page was already closed when Unstuck tried to attach. */
export class PageClosedError extends Error {
  constructor() {
    super('page closed');
    this.name = 'PageClosedError';
  }
}

let counter = 0;
const newPageId = () => `page-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Opens a CDP session on a Playwright or Puppeteer Page. */
export async function attachPage(page: unknown): Promise<AttachedPage> {
  const p = page as Record<string, any> | null;
  const isPlaywright = !!p && typeof p.context === 'function' && typeof p.context()?.newCDPSession === 'function';
  const isPuppeteer = !!p && typeof p.createCDPSession === 'function';
  if (!isPlaywright && !isPuppeteer) throw new TypeError('Unsupported page object: pass a Playwright or Puppeteer Page');
  const isClosed = () => (typeof p!.isClosed === 'function' ? Boolean(p!.isClosed()) : false);
  if (isClosed()) throw new PageClosedError();
  let session: CdpSessionLike;
  try {
    session = isPlaywright ? await p!.context().newCDPSession(p) : await p!.createCDPSession();
  } catch (e) {
    if (isClosed()) throw new PageClosedError();
    throw e;
  }
  const pageObj = p as unknown as PageLike;
  const closeCbs: ((reason: string) => void)[] = [];
  let closedReason: string | null = null;
  const fire = (reason: string) => () => {
    if (closedReason !== null) return;
    closedReason = reason;
    for (const cb of closeCbs) cb(reason);
  };
  const onPageClose = fire('page closed');
  const onCrash = fire('page crashed');
  pageObj.on('close', onPageClose);
  pageObj.on('crash', onCrash);

  return {
    pageId: newPageId(),
    url: () => pageObj.url?.() ?? '',
    send: (method, params) => session.send(method, params),
    subscribe: (event, cb) => void session.on(event, cb),
    onClose: (cb) => {
      if (closedReason !== null) cb(closedReason);
      else closeCbs.push(cb);
    },
    async detach() {
      pageObj.off?.('close', onPageClose);
      pageObj.off?.('crash', onCrash);
      await session.detach().catch(() => {});
    },
  };
}
