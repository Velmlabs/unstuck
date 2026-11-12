import { defineConfig, mergeConfig } from 'vitest/config';
import { packageConfig } from '../vitest.shared';
export default mergeConfig(packageConfig({ exclude: ['src/index.ts'] }), defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false } }));
