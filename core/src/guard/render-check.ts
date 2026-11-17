/** Whether this browser draws cross-origin iframes (CAPTCHA widgets live in them); 'unknown' when the probe couldn't tell. */
export type RenderCheck = () => Promise<boolean | 'unknown'>;

export const BROWSER_CANNOT_RENDER_HINT = "this browser can't show CAPTCHAs; use Chrome for this site";

/** Probes once per browser connection: a true/false answer is kept, while 'unknown' or a failure is asked again next time. */
export function onceRenderCheck(fn: RenderCheck): RenderCheck {
  let known: boolean | undefined;
  return async () => {
    if (known !== undefined) return known;
    try {
      const r = await fn();
      if (r !== 'unknown') known = r;
      return r;
    } catch {
      return 'unknown';
    }
  };
}
