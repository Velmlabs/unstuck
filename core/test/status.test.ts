import { describe, it, expect } from 'vitest';
import { nextStatus, InvalidTransitionError, isTerminal } from '../src/session/status';

describe('nextStatus', () => {
  it.each([
    ['created', 'published', 'notifying'],
    ['notifying', 'notified', 'waiting'],
    ['waiting', 'viewer_joined', 'active'],
    ['active', 'viewer_left', 'waiting'],
    ['active', 'done', 'resolved'],
    ['active', 'cant_solve', 'cancelled'],
    ['waiting', 'timeout', 'timed_out'],
    ['active', 'timeout', 'timed_out'],
    ['notifying', 'cancel', 'cancelled'],
    ['created', 'error', 'failed'],
    ['waiting', 'error', 'failed'],
  ] as const)('%s --%s--> %s', (from, ev, to) => {
    expect(nextStatus(from, ev)).toBe(to);
  });

  it.each([
    ['resolved', 'done'],
    ['timed_out', 'cancel'],
    ['failed', 'error'],
    ['waiting', 'done'],
    ['created', 'viewer_joined'],
  ] as const)('%s does not accept %s', (from, ev) => {
    expect(() => nextStatus(from, ev)).toThrow(InvalidTransitionError);
  });

  it('isTerminal identifies the four end states', () => {
    expect(['resolved', 'timed_out', 'cancelled', 'failed'].every((s) => isTerminal(s as never))).toBe(true);
    expect(['created', 'notifying', 'waiting', 'active'].some((s) => isTerminal(s as never))).toBe(false);
  });
});
