import type { CheckKind, CheckVendor } from '@velmlabs/unstuck-protocol';

/** One condition a rule needs; every signal of a rule must hold. */
export type Signal =
  | { title: RegExp }
  | { iframe: RegExp }
  | { marker: string }
  | { header: string; value: RegExp }
  | { heading: RegExp; maxBodyText: number }
  | { password: true }
  | { otp: true }
  | { text: RegExp }
  | { tokenEmpty: string }
  | { redirectedTo: RegExp };

export interface DetectionRule {
  id: string;
  kind: CheckKind;
  vendor?: CheckVendor;
  all: Signal[];
}

/** Bumped whenever a rule is added, removed or changes meaning. */
export const RULES_VERSION = 1;

const HUMAN = /verify (that )?you('| a)?re (a )?human|are you a robot|human verification|press (and|&) hold|checking (if the site connection is secure|your browser)|unusual traffic from your computer/i;

/** In order: the first rule that matches wins. HTTP status alone never matches. */
export const RULES: readonly DetectionRule[] = [
  { id: 'cloudflare.mitigated', kind: 'challenge', vendor: 'cloudflare', all: [{ header: 'cf-mitigated', value: /^challenge$/i }] },
  {
    id: 'cloudflare.interstitial',
    kind: 'challenge',
    vendor: 'cloudflare',
    all: [{ title: /^(Just a moment|Attention Required! \| Cloudflare)/i }, { marker: '#challenge-form, #challenge-stage, #cf-challenge-running, script[src*="/cdn-cgi/challenge-platform/"]' }],
  },
  {
    id: 'cloudflare.turnstile',
    kind: 'challenge',
    vendor: 'cloudflare',
    all: [{ iframe: /^https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\// }, { tokenEmpty: 'cf-turnstile-response' }],
  },
  {
    id: 'recaptcha.v2',
    kind: 'challenge',
    vendor: 'recaptcha',
    all: [{ iframe: /^https:\/\/www\.(google|recaptcha)\.(com|net)\/recaptcha\/(api2|enterprise)\/(bframe|anchor\?(?![^#]*size=invisible))/ }, { tokenEmpty: 'g-recaptcha-response' }],
  },
  { id: 'hcaptcha', kind: 'challenge', vendor: 'hcaptcha', all: [{ iframe: /^https:\/\/([a-z0-9-]+\.)*hcaptcha\.com\// }, { tokenEmpty: 'h-captcha-response' }] },
  { id: 'generic.title', kind: 'challenge', vendor: 'generic', all: [{ title: HUMAN }] },
  { id: 'generic.heading', kind: 'challenge', vendor: 'generic', all: [{ heading: HUMAN, maxBodyText: 3000 }] },
  { id: 'login.redirect', kind: 'login', all: [{ password: true }, { redirectedTo: /\/(log-?in|sign-?in|auth|sso|session|account\/login)(\/|\?|$)/i }] },
  {
    id: '2fa.code',
    kind: '2fa',
    all: [{ otp: true }, { text: /verification code|two-factor|2-step|two-step|authenticator app|security code|one-time (pass)?code|enter the code/i }],
  },
];

/** Widgets that may pass by themselves: reported only if still unsolved after a grace period. */
export const WIDGET_RULES: ReadonlySet<string> = new Set(['cloudflare.turnstile', 'recaptcha.v2', 'hcaptcha']);
