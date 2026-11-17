import type { CheckKind, RescueOutcome, SiteSession } from '@velmlabs/unstuck-protocol';
import type { SessionStore } from '@velmlabs/unstuck-core';

/** One rescue: what was detected, how it ended and how long the person took. */
export type RescueEvent = RescueOutcome;

export interface WrapOptions {
  /** What a person is brought in for (default ['challenge']; add 'login' and '2fa' to cover those too). */
  rescue?: CheckKind[];
  /** Keep the cookies of a rescued site, and load them before the next visit (default false). */
  remember?: boolean;
  /** Which saved profile remembered sites and the hourly limit belong to (default "default"). */
  profile?: string;
  /** Where remembered sites live (default: ~/.unstuck/profiles/<profile>/sites.json on Node, memory elsewhere). */
  store?: SessionStore;
  /** At most this many rescues per hour on the profile (default 10). */
  maxRescuesPerHour?: number;
  /** A rescue that doesn't end resolved throws UnstuckRescueError (default) or returns normally ('return'). */
  onRescueFail?: 'throw' | 'return';
  onRescue?: (e: RescueEvent) => void;
  timeoutS?: number;
  allowedSites?: string[];
  alerts?: boolean | 'required';
  requireCode?: boolean;
}

/** `page.unstuck`: the guard of a wrapped page. */
export interface PageGuard {
  readonly lastRescue: RescueEvent | null;
  /** Looks at the page now and rescues a check it finds. Never throws for a failed rescue: read the status. */
  check(): Promise<RescueEvent | null>;
  /** Brings a person in for something only they can do (a login, a code); counts toward the hourly limit. */
  askHuman(reason: string): Promise<RescueEvent>;
  /** The site's cookies and user agent, e.g. to hand to an HTTP client. */
  getSession(domain?: string): Promise<SiteSession>;
  rememberSite(domain: string): Promise<void>;
  forgetSite(domain: string): Promise<void>;
  forgetAll(): Promise<void>;
}

export type Wrapped<P> = P & { unstuck: PageGuard };
