import type { Browser, Page } from 'playwright';

/**
 * The tab your agent is working in, in a browser you connected to over CDP.
 * Only web pages (http/https) count, never a blank or chrome:// tab. With `urlPart` (pass it when several tabs are open),
 * the tab whose URL contains it, or an error if none does; without it, a web page.
 */
export async function agentPage(browser: Browser, urlPart?: string): Promise<Page> {
  const web = browser.contexts().flatMap((c) => c.pages()).filter((p) => /^https?:/.test(p.url()));
  if (urlPart) {
    const match = web.filter((p) => p.url().includes(urlPart)).at(-1);
    if (!match) throw new Error(`no open tab matches "${urlPart}"`);
    return match;
  }
  const page = web.at(-1);
  if (!page) throw new Error('no page to take over');
  return page;
}
