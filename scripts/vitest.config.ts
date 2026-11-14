import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.{ts,mjs}'],
    coverage: {
      provider: 'v8',
      include: ['scripts/**/*.mjs'],
      exclude: ['scripts/**/*.test.*', 'scripts/release.mjs'], // release.mjs is the entry point: its proof is the dry run
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
