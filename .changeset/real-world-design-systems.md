---
'vue-shaker': minor
---

Shake real-world design systems, not just `import Child from './Child.vue'`.

The shaker now follows the component graphs apps actually have:

- **Workspace / alias resolution.** The Vite plugin resolves imports through
  `this.resolve`, so a design system imported as a bare workspace package
  (`@scope/design-system`) or via an alias (`@/components/...`) is followed
  exactly as the real build does. Previously only `./relative` imports resolved,
  so every workspace call site was invisible and the library was left unshaken.
  Imports resolving into `node_modules` are skipped (published deps ship compiled
  and can't be shaken).
- **Namespace-object components.** `import { Components } from 'pkg'; const { A,
  group: { B } } = Components;` then `<A/> <B/>` — a very common way design
  systems are consumed — is resolved to each leaf `.vue`, so those components fold
  like a default import. If the namespace object also leaks as a runtime value (or
  is rendered through `<component :is="NS.x">`), every component it exposes bails.
- **Non-destructured `defineProps`.** `const props = withDefaults(defineProps<{…}>(),
  {…})` with `props.X` reads is now modeled (names from the type literal, defaults
  from `withDefaults`), in addition to the destructured form.
- **Script-computed scoped CSS.** `:class="classes"` where `classes` is a
  `const classes = computed(() => ['btn', \`btn-${props.variant}\`, …])` is followed
  into the script and evaluated against the prop value sets, so unreachable scoped
  rules are removed even when the class list is built in `<script>` (template
  literals, ternaries, arrays, spreads of array literals).
