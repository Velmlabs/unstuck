import type { HookKind } from './hooks';

/** Which Playwright Page and Locator methods the guard wraps. */
export const PLAYWRIGHT_HOOKS = {
  page: {
    goto: { navigates: true, requestedUrl: (a: unknown[]) => (typeof a[0] === 'string' ? a[0] : undefined) },
    reload: { navigates: true },
    goBack: { navigates: true },
    goForward: { navigates: true },
    waitForNavigation: { navigates: true },
    waitForURL: { navigates: true },
    click: { navigates: false, mayNavigate: true },
    press: { navigates: false, mayNavigate: true },
    fill: { navigates: false, mayNavigate: false },
  } satisfies Record<string, HookKind>,
  locatorFactories: ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId'],
  locatorChain: ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'filter', 'first', 'last', 'nth', 'and', 'or'],
  locatorActions: ['click', 'dblclick', 'tap', 'fill', 'press', 'pressSequentially', 'check', 'uncheck', 'selectOption'],
} as const;

type PwPage = { context(): { newCDPSession?: unknown; browser(): object | null; newPage(): Promise<unknown> } };

export const isPlaywrightPage = (p: unknown): boolean => {
  const page = p as { context?: unknown } | null;
  if (!page || typeof page.context !== 'function') return false;
  try {
    return typeof (page as PwPage).context()?.newCDPSession === 'function';
  } catch {
    return false;
  }
};

/** The browser a page lives in (the context, for a persistent context without a Browser). */
export const playwrightBrowserKey = (page: unknown): object => (page as PwPage).context().browser() ?? (page as PwPage).context();

/** A new tab in the same context (the paint probe). */
export const playwrightNewPage = (page: unknown): Promise<unknown> => (page as PwPage).context().newPage();
