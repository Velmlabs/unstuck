import type { Browser, Page } from 'playwright';

/**
 * The tab your agent is working in, in a browser you connected to over CDP.
 * Picks a tab whose URL contains `urlPart` (pass it when several tabs are open); without a match, a tab that isn't blank.
 */
export async function agentPage(browser: Browser, urlPart?: string): Promise<Page> {
  const pages = browser.contexts().flatMap((c) => c.pages());
  const real = pages.filter((p) => p.url() !== 'about:blank');
  const match = urlPart ? real.filter((p) => p.url().includes(urlPart)) : [];
  const page = (match.length ? match : real).at(-1);
  if (!page) throw new Error('no page to take over');
  return page;
}
