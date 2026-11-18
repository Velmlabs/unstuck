import type { HumanCheck, RescueOutcome, RescueStatus } from '@velmlabs/unstuck-protocol';

/** The engine binary could not be found, started, or kept running. */
export class UnstuckEngineError extends Error {
  constructor(
    message: string,
    readonly enginePath?: string,
    /** Set for failures a caller may act on: `engine_too_old` (the engine lacks a feature this call needs). */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'UnstuckEngineError';
  }
}

/** The options passed to Unstuck are inconsistent. */
export class UnstuckConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnstuckConfigError';
  }
}

/** A wrapped page met a human check that a person didn't get it past (see `status`). */
export class UnstuckRescueError extends Error {
  override name = 'UnstuckRescueError';
  readonly status: Exclude<RescueStatus, 'resolved'>;
  readonly detail?: string;
  readonly check: HumanCheck;
  readonly event: RescueOutcome;

  constructor(event: RescueOutcome) {
    super(`Unstuck could not get past a ${event.check.kind} on ${event.check.site}: ${event.status}${event.detail ? ` (${event.detail})` : ''}`);
    this.status = event.status as Exclude<RescueStatus, 'resolved'>;
    if (event.detail !== undefined) this.detail = event.detail;
    this.check = event.check;
    this.event = event;
  }
}
