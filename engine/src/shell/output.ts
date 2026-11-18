// Shell commands (unstuck check / rescue / takeover / ask / wait / cancel): one JSON object on stdout per command, a
// short human line on stderr, and a stable exit code an agent can branch on.

export const EXIT = { done: 0, humanNeeded: 10, waiting: 11, checkFound: 20, failed: 30, usage: 2 } as const;

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

/** Writes `out` as one JSON line (and `human` as one stderr line), and returns `code` for the caller to exit with. */
export function emit(io: Out, out: Record<string, unknown>, code: number, human?: string): number {
  io.stdout.write(JSON.stringify(out) + '\n');
  if (human) io.stderr.write(`[unstuck] ${human}\n`);
  return code;
}

/** The exit code for a result's status. */
export function exitFor(status: string): number {
  if (status === 'clear' || status === 'resolved' || status === 'answered') return EXIT.done;
  if (status === 'human_needed') return EXIT.humanNeeded;
  if (status === 'waiting') return EXIT.waiting;
  if (status === 'check_found') return EXIT.checkFound;
  return EXIT.failed;
}
