---
'vue-shaker': patch
---

Close scoped-CSS-removal and call-site-completeness soundness holes that
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
