import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs the edge entry inside workerd. Not part of the coverage gate (the Node suite covers the same source).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test-workers/wrangler.test.toml' }, miniflare: { bindings: { AGENT_KEYS: 'K' } } })],
  test: { include: ['test-workers/**/*.test.ts'], testTimeout: 30_000 },
});
