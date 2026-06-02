# vue-shaker

## 0.1.1

### Patch Changes

- 9c8c6d6: Sharpen the package positioning. The README and npm description now lead with
  what a JS bundler and Vue's own compiler fundamentally cannot remove —
  runtime-interpolated class strings, template branches, and unused
  `<style scoped>` rules (Vue prunes none) — rather than the generic "tree-shakes
  props". No API or behavior change.

## 0.1.0

### Minor Changes

- Initial release.

  A sound, source-level tree-shaker for Vue 3 SFCs that use `<script setup>` +
  `defineProps`. It runs in `vite build`, before the Vue compiler, and slims each
  `.vue` by partially evaluating it against how the whole app uses it:

  - **L0/L1** — props no call site passes (or always passes the same constant) are
    dropped from `defineProps`, demoted to a local `const`, and their attribute is
    stripped at every call site.
  - **L1.5** — value-set narrowing deletes provably-dead `v-if`/`v-else-if` arms.
  - **CSS** — unreachable `<style scoped>` rules are removed (Vue does no
    unused-CSS pruning itself, so the shaker owns it).

  Ships a Vite plugin (`vue-shaker/vite`) and a Rollup plugin
  (`rollup-plugin-vue-shaker`). Build-only by design — dev is a pass-through.
  Soundness is defended by a differential-SSR oracle. Requires `vue@^3`.
