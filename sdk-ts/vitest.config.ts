import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import { packageConfig } from '../vitest.shared';
// The standalone examples import the published name; in this repo it is this package's own source.
const self = fileURLToPath(new URL('./src/index.ts', import.meta.url));
export default mergeConfig(
  packageConfig({ exclude: ['src/index.ts'] }),
  defineConfig({ resolve: { alias: { '@velmlabs/unstuck': self } }, test: { testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false } }),
);
