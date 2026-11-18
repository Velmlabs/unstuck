import type { CheckKind, HumanCheck } from '@velmlabs/unstuck-protocol';

/** How long a start waits for the phone alert to be accepted, to report `alerted` (MCP's ALERT_WAIT_MS). */
export const ALERT_WAIT_MS_DEFAULT = 5_000;

/** How long the background process may take to make its link before it gives up (`failed`, `start_timeout`). */
export const REQUEST_START_LIMIT_MS = 45_000;

/** What the starting command hands the background process (one JSON line on its stdin). */
export interface RequestSpec {
  kind: 'rescue' | 'takeover' | 'ask';
  timeoutS?: number;
  alerts?: boolean | 'required';
  agentName?: string;
  relay?: string;
  agentKey?: string;
  /** rescue / takeover */
  browserWsUrl?: string;
  targetId?: string;
  tabKey?: string;
  pageUrl?: string;
  site?: string;
  check?: HumanCheck;
  scope?: CheckKind[];
  reason?: string;
  profile: string;
  maxRescuesPerHour?: number;
  /** ask */
  ask?: { question: string; choices?: string[]; allowText?: boolean; private: boolean; details?: string };
}
