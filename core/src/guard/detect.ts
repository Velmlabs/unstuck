import type { CheckKind, HumanCheck } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { siteOf } from '../session/page-lock';
import { collectFacts, type PageFacts } from './facts';
import type { DocResponse } from './main-document';
import { RULES, WIDGET_RULES, type DetectionRule, type Signal } from './rules';

export { RULES, RULES_VERSION, type DetectionRule, type Signal } from './rules';
export type { PageFacts } from './facts';

/** How long a widget may take to pass by itself before a person is asked. */
export const WIDGET_GRACE_MS = 3000;
const MIN_FRAME = 30;
const MARKERS = RULES.flatMap((r) => r.all.flatMap((s) => ('marker' in s ? [s.marker] : [])));

const noHash = (u: string) => u.split('#')[0];
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

function signal(s: Signal, f: PageFacts, doc: DocResponse | null, requestedUrl: string | undefined): string | null {
  if ('title' in s) return s.title.test(f.title) ? `title "${f.title}"` : null;
  if ('iframe' in s) {
    const hit = f.iframes.find((fr) => fr.visible && fr.width >= MIN_FRAME && fr.height >= MIN_FRAME && s.iframe.test(fr.src));
    return hit ? `iframe ${hostOf(hit.src)}` : null;
  }
  if ('marker' in s) return f.markers.includes(s.marker) ? `marker ${s.marker}` : null;
  if ('header' in s) {
    // Only the response of this very page counts, never one left over from an earlier document.
    const v = doc && noHash(doc.url) === noHash(f.url) ? doc.headers[s.header] : undefined;
    return v !== undefined && s.value.test(v) ? `header ${s.header}: ${v}` : null;
  }
  if ('heading' in s) {
    const h = f.headings.find((x) => s.heading.test(x));
    return h && f.bodyTextLength <= s.maxBodyText ? `heading "${h}"` : null;
  }
  if ('password' in s) return f.passwordVisible ? 'password field' : null;
  if ('otp' in s) return f.otpVisible ? 'one-time code field' : null;
  if ('text' in s) {
    const m = s.text.exec(f.bodyTextHead);
    return m ? `text "${m[0]}"` : null;
  }
  if ('tokenEmpty' in s) return f.tokenFields[s.tokenEmpty] ? null : `${s.tokenEmpty} empty`;
  // redirectedTo: only when the agent asked for another page and landed here.
  if (!requestedUrl) return null;
  try {
    const want = new URL(requestedUrl);
    const got = new URL(f.url);
    if (want.host === got.host && want.pathname === got.pathname) return null;
    return s.redirectedTo.test(got.pathname + got.search) ? `redirected to ${got.pathname}` : null;
  } catch {
    return null;
  }
}

/** The first rule (in order, within scope) whose signals all hold; pure. */
export function matchRules(facts: PageFacts, doc: DocResponse | null, o: { scope: readonly CheckKind[]; requestedUrl?: string; rules?: readonly DetectionRule[] }): HumanCheck | null {
  for (const rule of o.rules ?? RULES) {
    if (!o.scope.includes(rule.kind)) continue;
    const evidence: string[] = [];
    let ok = true;
    for (const s of rule.all) {
      const e = signal(s, facts, doc, o.requestedUrl);
      if (e === null) {
        ok = false;
        break;
      }
      evidence.push(e);
    }
    if (ok) return { kind: rule.kind, ...(rule.vendor ? { vendor: rule.vendor } : {}), ruleId: rule.id, evidence, url: facts.url, site: siteOf(hostOf(facts.url)) };
  }
  return null;
}

export interface DetectOptions {
  scope?: readonly CheckKind[];
  requestedUrl?: string;
  document?: DocResponse | null;
  widgetGraceMs?: number;
}

/** Looks at the page for a human check. A widget that may pass by itself gets a grace period first. */
export async function detectHumanCheck(cdp: CdpClient, o: DetectOptions = {}): Promise<HumanCheck | null> {
  const opts = { scope: o.scope ?? (['challenge'] as const), requestedUrl: o.requestedUrl };
  const facts = await collectFacts(cdp, MARKERS);
  if (!facts) return null;
  const found = matchRules(facts, o.document ?? null, opts);
  if (!found || !WIDGET_RULES.has(found.ruleId)) return found;
  await new Promise((r) => setTimeout(r, o.widgetGraceMs ?? WIDGET_GRACE_MS));
  const again = await collectFacts(cdp, MARKERS);
  return again ? matchRules(again, o.document ?? null, opts) : null;
}
