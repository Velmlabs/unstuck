import type { SessionStatus } from '@unstuck/protocol';

export type SessionEvent =
  | 'published'
  | 'notified'
  | 'viewer_joined'
  | 'viewer_left'
  | 'done'
  | 'cant_solve'
  | 'timeout'
  | 'cancel'
  | 'error';

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionStatus,
    readonly event: SessionEvent,
  ) {
    super(`invalid session transition: ${from} --${event}-->`);
    this.name = 'InvalidTransitionError';
  }
}

const TERMINAL = new Set<SessionStatus>(['resolved', 'timed_out', 'cancelled', 'failed']);

const TABLE: Partial<Record<SessionStatus, Partial<Record<SessionEvent, SessionStatus>>>> = {
  created: { published: 'notifying' },
  notifying: { notified: 'waiting' },
  waiting: { viewer_joined: 'active' },
  active: { viewer_left: 'waiting', done: 'resolved', cant_solve: 'cancelled' },
};

/** Valid from any non-terminal state. */
const ANYTIME: Partial<Record<SessionEvent, SessionStatus>> = { timeout: 'timed_out', cancel: 'cancelled', error: 'failed' };

export function isTerminal(s: SessionStatus): boolean {
  return TERMINAL.has(s);
}

export function nextStatus(current: SessionStatus, event: SessionEvent): SessionStatus {
  const next = isTerminal(current) ? undefined : (TABLE[current]?.[event] ?? ANYTIME[event]);
  if (!next) throw new InvalidTransitionError(current, event);
  return next;
}
