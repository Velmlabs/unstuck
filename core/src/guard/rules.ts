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
  | { text: RegExp; maxBodyText?: number }
  | { absent: 'password' | 'otp' }
  | { tokenEmpty: string }
  | { redirectedTo: RegExp };

export interface DetectionRule {
  id: string;
  kind: CheckKind;
  vendor?: CheckVendor;
  all: Signal[];
}

/** Bumped whenever a rule is added, removed or changes meaning. */
export const RULES_VERSION = 2;

// Wording of sign-in approval prompts (push to a phone). Kept short-page only (maxBodyText) so articles don't match.
const APPROVE = /\b(check your (phone|device)|tap yes|approve (this )?(sign-in|login|request)|we sent a (notification|prompt|push) to|open the .* app to (confirm|approve)|confirm it['\u2019]s you on your (phone|device))\b/i;
// Sign-in or identity wording; keeps "Approve request" on an admin page, "check your device settings" etc. from matching.
const APPROVE_CONTEXT = /\bsign[- ]?in(g)?\b|\blog[- ]?in\b|\bverif(y|ication)\b|\bit(['\u2019]?s| is) (really )?you\b|\bauthenticat|\b(2|two)[- ]?(step|factor)\b|\bapprove (this|the) (request|sign-in|login) on your (phone|device)\b/i;

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
  { id: 'approval.prompt', kind: 'approval', all: [{ text: APPROVE, maxBodyText: 3000 }, { text: APPROVE_CONTEXT, maxBodyText: 3000 }, { absent: 'password' }, { absent: 'otp' }] },
];

/** What a sign-in approval page says once the push timed out or was refused. Matched on its own, never part of RULES. */
export const APPROVAL_FAILED_RULES: readonly DetectionRule[] = [
  { id: 'approval_failed.timed_out', kind: 'approval', all: [{ text: /request timed out|log ?in timed out|we didn['\u2019]t hear from you|push notification (has )?expired/i, maxBodyText: 3000 }] },
  { id: 'approval_failed.denied', kind: 'approval', all: [{ text: /push (was )?(rejected|denied)|sign-in (was )?denied|log ?in request (was )?denied|chosen to reject this log ?in|\bdeclined\b/i, maxBodyText: 3000 }] },
  { id: 'approval_failed.retry', kind: 'approval', all: [{ text: /try again/i, maxBodyText: 3000 }] },
];

/** Widgets that may pass by themselves: reported only if still unsolved after a grace period. */
export const WIDGET_RULES: ReadonlySet<string> = new Set(['cloudflare.turnstile', 'recaptcha.v2', 'hcaptcha']);
