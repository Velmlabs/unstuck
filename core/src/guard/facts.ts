import { inPageSource } from './in-page';
import type { CdpClient } from '../cdp';

/** What the detection rules look at, read from the page in one evaluation. */
export interface PageFacts {
  url: string;
  title: string;
  iframes: { src: string; width: number; height: number; visible: boolean }[];
  /** The marker selectors (from the rules) that match an element on the page. */
  markers: string[];
  /** Token fields of the CAPTCHA widgets (`*-response`), by name. */
  tokenFields: Record<string, string>;
  passwordVisible: boolean;
  otpVisible: boolean;
  headings: string[];
  bodyTextLength: number;
  bodyTextHead: string;
}

// Self-contained: serialized into the page, so it may not close over anything.
function factsInPage(markers: string[]) {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const tokenFields: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll('textarea[name$="-response"], input[name$="-response"]'))) {
    const f = el as HTMLInputElement;
    if (!(f.name in tokenFields) || f.value) tokenFields[f.name] = f.value;
  }
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const single = inputs.filter((i) => i.maxLength === 1);
  const otpVisible =
    inputs.some((i) => i.autocomplete === 'one-time-code' || /otp|2fa|totp|verification.?code|one.?time/i.test(`${i.name} ${i.id}`)) ||
    (single.length >= 4 && single.length <= 8);
  const text = document.body ? document.body.innerText || '' : '';
  return {
    url: location.href,
    title: document.title,
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => {
      const r = f.getBoundingClientRect();
      return { src: f.src, width: Math.round(r.width), height: Math.round(r.height), visible: visible(f) };
    }),
    markers: markers.filter((m) => {
      try {
        return document.querySelector(m) !== null;
      } catch {
        return false;
      }
    }),
    tokenFields,
    passwordVisible: inputs.some((i) => i.type === 'password'),
    otpVisible,
    headings: Array.from(document.querySelectorAll('h1, h2'))
      .filter(visible)
      .map((h) => (h.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 10),
    bodyTextLength: text.length,
    bodyTextHead: text.slice(0, 3000),
  };
}

/** Reads the page's facts in one `Runtime.evaluate`; null when the page can't be read (e.g. mid-navigation). */
export async function collectFacts(cdp: CdpClient, markers: readonly string[]): Promise<PageFacts | null> {
  try {
    const r = await cdp.send<{ result?: { value?: PageFacts }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: `(${inPageSource(factsInPage)})(${JSON.stringify(markers)})`,
      returnByValue: true,
    });
    return r.exceptionDetails || !r.result?.value ? null : r.result.value;
  } catch {
    return null;
  }
}
