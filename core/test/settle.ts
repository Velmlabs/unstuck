// Test-only, never published: the workspace `exports` of core map `@velmlabs/unstuck-core/testing/settle` here, but its
// publishConfig does not (and the file is outside src, so it is not built into dist). It patches crypto.subtle on import.
// Waits for the engine's asynchronous work to finish, instead of for a fixed time (which fails on a loaded machine).
// WebCrypto runs on a thread pool, so its calls are counted while in flight; settle() returns once none has been
// pending for several event-loop turns in a row (a chain starts its next step in the microtasks after the last one).
// It uses the real setTimeout captured on import, so tests on fake timers keep their fake time where it is.
const realSetTimeout = globalThis.setTimeout;
const METHODS = ['encrypt', 'decrypt', 'importKey', 'exportKey', 'digest', 'generateKey', 'sign', 'verify', 'deriveBits', 'deriveKey'] as const;
const QUIET_TURNS = 3;
const LIMIT_MS = 10_000;

let pending = 0;
const subtle = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
if (!(subtle as { __settleCounted?: boolean }).__settleCounted) {
  for (const m of METHODS) {
    const orig = subtle[m]!.bind(globalThis.crypto.subtle);
    subtle[m] = (...a: unknown[]) => {
      pending++;
      return orig(...a).finally(() => void pending--);
    };
  }
  (subtle as { __settleCounted?: boolean }).__settleCounted = true;
}

export async function settle(): Promise<void> {
  const start = performance.now();
  for (let quiet = 0; quiet < QUIET_TURNS; ) {
    await new Promise((r) => realSetTimeout(r, 1));
    quiet = pending === 0 ? quiet + 1 : 0;
    if (performance.now() - start > LIMIT_MS) throw new Error(`settle: ${pending} WebCrypto call(s) still pending after ${LIMIT_MS} ms`);
  }
}
