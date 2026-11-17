import type { HookKind } from './hooks';

/** Which Puppeteer Page and Locator methods the guard wraps. */
export const PUPPETEER_HOOKS = {
  page: {
    goto: { navigates: true, requestedUrl: (a: unknown[]) => (typeof a[0] === 'string' ? a[0] : undefined) },
    reload: { navigates: true },
    goBack: { navigates: true },
    goForward: { navigates: true },
    waitForNavigation: { navigates: true },
    click: { navigates: false, mayNavigate: true },
    type: { navigates: false, mayNavigate: false },
  } satisfies Record<string, HookKind>,
  locatorFactories: ['locator'],
  locatorChain: ['filter', 'map', 'setTimeout', 'setVisibility'],
  locatorActions: ['click', 'fill'],
} as const;

type PpPage = { browser(): object; browserContext(): { newPage(): Promise<unknown> } };

export const isPuppeteerPage = (p: unknown): boolean => {
  const page = p as { createCDPSession?: unknown; browser?: unknown } | null;
  return !!page && typeof page.createCDPSession === 'function' && typeof page.browser === 'function';
};

export const puppeteerBrowserKey = (page: unknown): object => (page as PpPage).browser();

/** A new tab in the same browser context (the paint probe). */
export const puppeteerNewPage = (page: unknown): Promise<unknown> => (page as PpPage).browserContext().newPage();
