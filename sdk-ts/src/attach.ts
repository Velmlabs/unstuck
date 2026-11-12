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

let counter = 0;
const newPageId = () => `page-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Opens a CDP session on a Playwright or Puppeteer Page. */
export async function attachPage(page: unknown): Promise<AttachedPage> {
  const p = page as Record<string, any> | null;
  let session: CdpSessionLike;
  if (p && typeof p.context === 'function' && typeof p.context()?.newCDPSession === 'function') {
    session = await p.context().newCDPSession(p);
  } else if (p && typeof p.createCDPSession === 'function') {
    session = await p.createCDPSession();
  } else {
    throw new TypeError('Unsupported page object: pass a Playwright or Puppeteer Page');
  }
  const pageObj = p as unknown as PageLike;
  const closeCbs: ((reason: string) => void)[] = [];
  let closed = false;
  const fire = (reason: string) => () => {
    if (closed) return;
    closed = true;
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
    onClose: (cb) => void closeCbs.push(cb),
    async detach() {
      pageObj.off?.('close', onPageClose);
      pageObj.off?.('crash', onCrash);
      await session.detach().catch(() => {});
    },
  };
}
