import { vi } from 'vitest';
import type { HumanCheck, TakeoverResult } from '@velmlabs/unstuck-protocol';
import { FakeCdp } from '../../src/testing/fake-cdp';
import type { PageFacts } from '../../src/guard/facts';

export const page = (o: Partial<PageFacts> = {}): PageFacts => ({
  url: 'https://shop.example/',
  title: 'Shop',
  iframes: [],
  markers: [],
  tokenFields: {},
  passwordVisible: false,
  otpVisible: false,
  headings: [],
  bodyTextLength: 500,
  bodyTextHead: 'Welcome',
  ...o,
});
export const blocked = (url = 'https://shop.example/') => page({ url, headings: ['Verify you are human'], bodyTextLength: 100 });

export const cfCheck: HumanCheck = { kind: 'challenge', vendor: 'cloudflare', ruleId: 'cloudflare.interstitial', evidence: ['title "Just a moment..."'], url: 'https://shop.example/', site: 'shop.example' };

export const result = (status: TakeoverResult['status'], detail?: string): TakeoverResult => ({ status, sessionId: 's1', url: 'https://shop.example/', durationS: 3, ...(detail ? { detail } : {}) });
export const runner = (status: TakeoverResult['status'] = 'resolved', detail?: string) => vi.fn(async (_o: { reason: string; site: string }) => result(status, detail));

/** A FakeCdp whose page shows `facts()` (changeable), with a user agent, a URL and a cookie jar. */
export function fakePage(state: { facts: PageFacts; cookies?: object[] }) {
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN' } } }));
  cdp.respond('Runtime.evaluate', (p) => {
    const e = (p as { expression: string }).expression;
    if (e === 'navigator.userAgent') return { result: { value: 'UA/1' } };
    if (e === 'location.href') return { result: { value: state.facts.url } };
    return { result: { value: state.facts } };
  });
  cdp.respond('Storage.getCookies', () => ({ cookies: state.cookies ?? [] }));
  return cdp;
}
