import { defineConfig } from 'tsup';

// Published build (pnpm build:dist): ES modules + bundled types in dist/. The workspace itself runs on src/.
export default defineConfig({
  entry: { 'index': 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node18',
  sourcemap: false,
  outDir: 'dist',
});
