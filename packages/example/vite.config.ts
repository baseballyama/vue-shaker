import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { shaker } from 'vue-shaker/vite';

// https://vitejs.dev/config/
export default defineConfig({
  // `shaker` must come before `vue()` so it slims the `.vue` source before the
  // Vue compiler runs. It is build-only by design (dev passes through).
  // `include` is the app root that holds every call site.
  plugins: [shaker({ include: ['src'] }), vue()],
  build: {
    // Keep output readable so the shake (dropped props / CSS) is visible.
    minify: false,
  },
});
