import { mergeConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { packageConfig } from '../vitest.shared';
export default mergeConfig(packageConfig({ environment: 'jsdom', exclude: ['src/main.tsx', 'src/pair/main.tsx', 'src/sw.ts'] }), {
  plugins: [preact()],
});
