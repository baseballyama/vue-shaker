<p align="center">
  <img src="https://raw.githubusercontent.com/baseballyama/vue-shaker/main/assets/vue-shaker.png" alt="vue-shaker" width="190" />
</p>

<h1 align="center">vue-shaker</h1>

<p align="center"><strong>Deletes the dead code your bundler can't see</strong> — unreachable <code>v-if</code> branches and <code>&lt;style&nbsp;scoped&gt;</code> rules — from Vue&nbsp;3 SFCs.</p>

**▶ Try it in the browser: https://baseballyama.github.io/vue-shaker/** — an
interactive playground that runs the engine entirely client-side.

Rollup tree-shakes JS modules, but it can't see inside a `.vue`; Vue compiles one
generic render function per component and prunes **no** scoped CSS at all. So the
`.btn-danger` rule you never use, the `v-if="loading"` arm you never trigger, and
the props you never pass ship in **every** app that imports the component.
`vue-shaker` is a **sound, whole-program tree-shaker** for Vue 3 SFCs
(`<script setup>` + `defineProps`) that closes that gap.

It runs in your app's production build, _before_ the Vue compiler, and slims each
`.vue` file by partially evaluating it against how the **whole app** actually uses
it: props that are never passed (or always passed the same value) are folded to
their constant, the dead `v-if` arms behind them are deleted, those props are
dropped from the `defineProps` signature, and the now-pointless attributes are
removed at every call site. The Vue compiler then only sees the code your app can
actually reach.

It is **sound first**: it never changes what the user sees. When it cannot prove a
transform is safe, it leaves the code untouched (bails).

See [`docs/ARCHITECTURE.md`](https://github.com/baseballyama/vue-shaker/blob/main/docs/ARCHITECTURE.md) for the full design.

## Why this exists (and why a JS bundler can't do it)

Design-system components carry lots of props (`Button` with
`variant / size / loading / icon / iconPosition / fullWidth / rounded / href …`),
but any one app uses only a few. The code behind the unused props — template
branches, class computation, computed values, imports, CSS — is effectively dead
for that app, yet it ships anyway.

It cannot be removed _after_ Vue compiles, because Vue emits **one generic render
function per component**, shared by every caller. In that output the prop values
flow through the runtime (`props.loading`, `$props`), so `loading` / `variant` are
not static JS constants — terser/esbuild/Rollup cannot fold `if (loading)` to
`if (false)`, and the single module has no whole-program information to know which
props this particular app never uses.

vue-shaker works **one step earlier**, on the pre-compile `.vue` source, where the
prop's value (its default, or the literal at the call site) is still visible and
the template structure is intact. It is essentially a **whole-program partial
evaluator + dead-code eliminator that understands Vue**, driven by every call site
in the app.

### The CSS differentiator (what a bundler genuinely can't reach)

Given `:class="['btn', \`btn-${variant}\`]"` where the app only ever passes
`variant ∈ {primary, secondary}`, the class `btn-danger` can never exist at
runtime. But the class only appears as a runtime string, so Rollup/terser can't
touch it (the class isn't in the JS at all), and — unlike Svelte — **Vue does not
prune unused `<style scoped>` rules at all**. So `btn-danger` ships no matter what.

vue-shaker computes the reachable value set of `variant`, proves the `.btn-danger`
/ `.btn-ghost` rules can never match any element this component renders, and
**removes those `<style scoped>` rules** — while keeping `.btn`, `.btn-primary`,
`.btn-secondary`. Because Vue has no unused-CSS pruning of its own, this is an even
bigger win for Vue than for Svelte.

## Install

```sh
pnpm add -D vue-shaker
# or: npm i -D vue-shaker / yarn add -D vue-shaker
```

Requires `vue@^3`.

## Usage (Vite)

Add the plugin **before** `vue()` so it hands already-slimmed source to the Vue
compiler. It is **build-only by design** — dev is a pass-through.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { shaker } from 'vue-shaker/vite';

export default defineConfig({
  plugins: [
    // `include` must cover EVERY call site in the app, or prop elimination
    // would be unsound. Defaults to the Vite root.
    shaker({ include: ['src'] }),
    vue(),
  ],
});
```

There is also a plain-Rollup plugin (`rollup-plugin-vue-shaker`) for non-Vite
pipelines; the Vite plugin is preferred for apps.

### Options

```ts
shaker({
  include: ['src'], // dirs (relative to root) holding every .vue call site
  level: 1, //  0 | 1 | 2 — default 1 (L0/L1/L1.5 always on). 2 = opt-in L2.
  monomorphize: false, // L2 tuning; only consulted when level: 2.
});
```

## What it does

| Level    | What it removes                                                                                                                          | Default    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **L0**   | Props no call site ever passes → fold to the default, drop from `defineProps`, strip the attribute at call sites                          | on         |
| **L1**   | Props that collapse to one constant app-wide → fold + drop + strip every call site's attribute                                           | on         |
| **L1.5** | Value-set **narrowing**: with `variant ∈ {primary, secondary}`, delete provably-dead `v-if`/`v-else-if` arms (prop stays in the signature) | on         |
| **CSS**  | `<style scoped>` rules whose class can never be produced given the value sets — the bundler-can't differentiator (and Vue can't either)   | on         |
| **L2**   | Per-call-site monomorphization: specialize a component per prop shape (deduped by residual, capped by `maxVariants`)                      | **opt-in** |

## Soundness

The whole point is to **never change observable behavior**.

- **Differential-SSR verified.** Tests server-render the original and the shaken
  component (via `@vue/server-renderer`, comments/scope-ids stripped, whitespace
  normalized) and assert the HTML is identical for every value the app passes.
- **Conservative bail.** When a transform can't be _proven_ safe, the code is left
  as-is. Whole-component bails: a component rendered through `<component :is>`, that
  escapes as a value, or is reached only through a barrel/named re-export (its call
  sites aren't enumerable). Per-prop bails: a `v-bind="…"` spread that could
  overwrite it, a name shadowed by `v-for` / scoped-slot props, or used in a way the
  engine can't follow.
- **Side effects preserved.** A call-site attribute is only stripped if its value
  has no side effects; a value's code is removed only when it is provably pure and
  unused.
- **Whole-program fixpoint.** Call sites inside a folded-away `v-if` don't count
  toward a child's prop profile; analysis iterates to a fixpoint so cascades are
  consistent with what the transform actually deletes.

## Limitations

- **`<script setup>` + `defineProps` only.** Options API and plain `<script>`
  (`defineComponent({ props })`) are out of scope and silently passed through.
- **Needs `.vue` source.** Libraries shipping compiled JS can't be shaken (the
  source has to be visible — that's the whole premise). Anything it can't resolve is
  silently passed through.
- **Build only.** It runs in `vite build`, not in dev/HMR — whole-program analysis
  is fundamentally incompatible with HMR's locality. Dev is always a pass-through
  (unoptimized but always correct).
- **`include` must cover the whole app.** A call site outside the scanned dirs is
  invisible, so soundness requires every consumer of a prop to be in scope.

## Architecture & status

The engine is split into an environment-free **Engine** (Vue-aware analysis +
transform) behind a stable IR, and a thin **Shell** (the Vite/Rollup plugin) that
owns file IO and module resolution — so the core can later be ported to Rust on
[vize](https://github.com/baseballyama/vize) (the Rust Vue toolchain). See
[`docs/ARCHITECTURE.md`](https://github.com/baseballyama/vue-shaker/blob/main/docs/ARCHITECTURE.md) and
[`docs/RUST-MIGRATION.md`](https://github.com/baseballyama/vue-shaker/blob/main/docs/RUST-MIGRATION.md).

## License

MIT
