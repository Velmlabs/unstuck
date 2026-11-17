// Unstuck Browser: the data shared by core, the engine and the SDKs when a wrapped page meets a human check.
import type { TakeoverResult } from './result';

export type CheckKind = 'challenge' | 'login' | '2fa';
export type CheckVendor = 'cloudflare' | 'recaptcha' | 'hcaptcha' | 'generic';

/** A human check found on a page (`kind: 'ask'` when the agent asked for a person itself). */
export interface HumanCheck {
  kind: CheckKind | 'ask';
  vendor?: CheckVendor;
  ruleId: string;
  evidence: string[];
  url: string;
  /** Registrable domain of the page, e.g. `example.co.uk`. */
  site: string;
}

export const RESCUE_STATUSES = ['resolved', 'still_blocked', 'timed_out', 'cancelled', 'rescue_limited', 'alert_failed', 'browser_cannot_render_captcha', 'failed'] as const;
export type RescueStatus = (typeof RESCUE_STATUSES)[number];

export interface RescueOutcome {
  status: RescueStatus;
  check: HumanCheck;
  waitedS: number;
  takeover?: TakeoverResult;
  detail?: string;
}

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** A site's session, handed to an agent that asked for it (e.g. to continue with curl). */
export interface SiteSession {
  site: string;
  userAgent: string;
  cookies: StoredCookie[];
  cookieHeader: string;
}
