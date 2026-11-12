import { defineConfig } from 'vitest/config';

/** Shared Vitest config: every package must keep >90% coverage (plan Global Constraints). */
export function packageConfig(opts: { environment?: 'node' | 'jsdom'; exclude?: string[]; setupFiles?: string[] } = {}) {
  return defineConfig({
    test: {
      environment: opts.environment ?? 'node',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: opts.setupFiles,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.gen.ts', 'src/**/bin.ts', 'src/**/*.d.ts', ...(opts.exclude ?? [])],
        thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
      },
    },
  });
}
