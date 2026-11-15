/** The engine binary could not be found, started, or kept running. */
export class UnstuckEngineError extends Error {
  constructor(
    message: string,
    readonly enginePath?: string,
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
