import { defineConfig } from 'vitest/config';

// The runnable examples (examples/*), each driven to a real takeover. Opt-in: `pnpm e2e:examples` (not part of `pnpm test`).
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['examples/**/*.test.ts'],
    globalSetup: ['examples/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
