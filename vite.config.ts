import { defineConfig } from 'vite';

export default defineConfig({
  base: '/fluxus/',
  server: {
    open: true,
  },
  esbuild: {
    target: 'es2022',
  },
  build: {
    /** Required for top-level `await RAPIER.init()` (WASM physics bootstrap). */
    target: 'es2022',
  },
});
