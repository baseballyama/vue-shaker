# vue-shaker

## 0.2.0

### Minor Changes

- 0d0217b: Shake real-world design systems, not just `import Child from './Child.vue'`.

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
    `const classes = computed(() => ['btn', \`btn-${props.variant}\`, …])`is followed
into the script and evaluated against the prop value sets, so unreachable scoped
rules are removed even when the class list is built in`<script>` (template
    literals, ternaries, arrays, spreads of array literals).

### Patch Changes

- 0d0217b: Close scoped-CSS-removal and call-site-completeness soundness holes that
  real-world apps hit. Each could previously change observable behavior; the shaker
  now keeps the affected rule / bails the affected component instead.

  - **`<Transition>` / `<TransitionGroup>` classes.** Vue derives
    `name-enter-active`, `name-leave-to`, … at runtime — never via `:class`, and
    never during SSR — so the differential-SSR oracle can't catch their removal.
    The class-set analysis now accounts for them (and bails on a dynamic name).
  - **Functional pseudo-classes.** `:is()` / `:where()` / `:has()` are disjunctions
    and `:not()` is a negation, but the dead-rule check flattened their inner
    classes and treated them as all-required — wrongly removing live rules. Rules
    using these pseudos are now kept.
  - **Programmatic instantiation.** A `.vue` used as a value in a `.ts`/`.js` file
    (`createApp(Dialog, props)`, `h(Dialog)`, a route `component:`) has call sites
    no template enumerates. Files in scope are scanned and such components bail,
    instead of their props being folded to the defaults the template-only view
    implied. `<component :is="member.expr">` flags its root component too.
  - **Custom directives & imperative classList.** A custom directive or a script
    touching `classList`/`className`/`setAttribute('class', …)` can add classes the
    analysis can't see, so CSS removal for that component bails.
  - **Mutable class identifiers.** `:class="classes"` is followed only when
    `classes` is `const … = computed(() => …)` (immutable binding, recomputed fresh)
    — a `let`/`var` or plain-array `const` (mutable in place) is left unbounded.
  - **Prop / import name collisions.** A prop whose name matches an imported binding
    is no longer folded (the demote would redeclare the import).

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
