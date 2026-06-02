---
'vue-shaker': patch
---

Sharpen the package positioning. The README and npm description now lead with
what a JS bundler and Vue's own compiler fundamentally cannot remove —
runtime-interpolated class strings, template branches, and unused
`<style scoped>` rules (Vue prunes none) — rather than the generic "tree-shakes
props". No API or behavior change.
