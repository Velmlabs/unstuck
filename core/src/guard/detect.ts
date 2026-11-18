import type { CheckKind, HumanCheck } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { siteOf } from '../session/page-lock';
import { collectFacts, type PageFacts } from './facts';
import type { DocResponse } from './main-document';
import { RULES, WIDGET_RULES, type DetectionRule, type Signal } from './rules';

export { RULES, RULES_VERSION, APPROVAL_FAILED_RULES, type DetectionRule, type Signal } from './rules';
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
    if (s.maxBodyText !== undefined && f.bodyTextLength > s.maxBodyText) return null;
    const m = s.text.exec(f.bodyTextHead);
    return m ? `text "${m[0]}"` : null;
  }
  if ('absent' in s) return (s.absent === 'password' ? f.passwordVisible : f.otpVisible) ? null : `no ${s.absent === 'password' ? 'password' : 'one-time code'} field`;
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
  rules?: readonly DetectionRule[];
}

/** Looks at the page for a human check. A widget that may pass by itself gets a grace period first. */
const WIDGET_TOKENS = ['cf-turnstile-response', 'g-recaptcha-response', 'h-captcha-response'];

interface DomNode {
  nodeName?: string;
  backendNodeId?: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

/**
 * Widget iframes the page itself can't list: Turnstile renders its iframe inside a closed shadow root, out of reach of
 * querySelectorAll. Only looked for when the page has an empty widget token field, so ordinary pages don't pay for it.
 */
async function shadowFrames(cdp: CdpClient): Promise<PageFacts['iframes']> {
  const found: { src: string; backendNodeId: number }[] = [];
  try {
    const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true });
    const walk = (n: DomNode, inShadow: boolean) => {
      if (inShadow && n.nodeName === 'IFRAME' && n.backendNodeId !== undefined) {
        const a = n.attributes ?? [];
        const i = a.indexOf('src');
        if (i >= 0 && a[i + 1]) found.push({ src: a[i + 1]!, backendNodeId: n.backendNodeId });
      }
      for (const c of n.children ?? []) walk(c, inShadow);
      for (const r of n.shadowRoots ?? []) walk(r, true);
    };
    walk(root, false);
  } catch {
    return [];
  }
  const frames: PageFacts['iframes'] = [];
  for (const f of found) {
    try {
      const { model } = await cdp.send<{ model: { width: number; height: number } }>('DOM.getBoxModel', { backendNodeId: f.backendNodeId });
      frames.push({ src: f.src, width: model.width, height: model.height, visible: model.width > 0 && model.height > 0 });
    } catch {
      // no box: not rendered, so not a widget anyone could see
    }
  }
  return frames;
}

/** One read of the page's facts (with widget frames in closed shadow roots); null when the page can't be read. */
export async function readFacts(cdp: CdpClient): Promise<PageFacts | null> {
  const f = await collectFacts(cdp, MARKERS);
  if (f && WIDGET_TOKENS.some((t) => f.tokenFields[t] === '')) f.iframes.push(...(await shadowFrames(cdp)));
  return f;
}

export async function detectHumanCheck(cdp: CdpClient, o: DetectOptions = {}): Promise<HumanCheck | null> {
  const opts = { scope: o.scope ?? (['challenge'] as const), requestedUrl: o.requestedUrl, rules: o.rules };
  const facts0 = await readFacts(cdp);
  if (!facts0) return null;
  const found = matchRules(facts0, o.document ?? null, opts);
  if (!found || !WIDGET_RULES.has(found.ruleId)) return found;
  await new Promise((r) => setTimeout(r, o.widgetGraceMs ?? WIDGET_GRACE_MS));
  const again = await readFacts(cdp);
  return again ? matchRules(again, o.document ?? null, opts) : null;
}
