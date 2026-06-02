import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// We deliberately do NOT self-apply the shaker plugin to the site — the
// playground runs the engine at runtime in the browser, not at build time.
export default defineConfig({
  base: process.env['BASE_PATH'] ? process.env['BASE_PATH'] + '/' : '/',
  plugins: [vue()],
  optimizeDeps: {
    // vue-shaker bundles @vue/compiler-sfc / @babel/parser / postcss; pre-bundle
    // it so the browser gets one clean ESM module instead of CJS interop noise.
    include: ['vue-shaker'],
  },
});
