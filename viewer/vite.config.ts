import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Three single-entry builds into one folder (`vite build`, `--mode pair`, `--mode sw`), so no chunk is shared between
// pages and each page's script is pinned by its own integrity hash. The service worker is one classic script that must
// not import anything, and is emitted as sw.js (no hash in the name) next to index.html.
export default defineConfig(({ mode }) => {
  const common = { outDir: 'dist', sourcemap: false, target: 'es2020' } as const;
  if (mode === 'sw') {
    return {
      base: '/',
      publicDir: false,
      build: { ...common, emptyOutDir: false, lib: { entry: 'src/sw.ts', formats: ['iife' as const], name: 'unstuckSw', fileName: () => 'sw.js' } },
    };
  }
  return {
    plugins: [preact()],
    base: '/',
    build: {
      ...common,
      assetsDir: 'assets',
      modulePreload: { polyfill: false },
      emptyOutDir: mode !== 'pair',
      rollupOptions: { input: mode === 'pair' ? 'pair.html' : 'index.html' },
    },
  };
});
