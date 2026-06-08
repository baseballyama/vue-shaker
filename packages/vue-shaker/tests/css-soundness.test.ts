import { describe, expect, it } from 'vitest';
import { shakeMem } from './util';

// Scoped-CSS removal must account for class sources OTHER than `class`/`:class`:
// `<Transition>` derives classes from `name` at runtime, custom directives may
// add classes, and the script can touch classList.  None are visible to a
// `:class` scan, and the SSR oracle can't see them (transitions don't run on the
// server) — so these are guarded by construction, not by the differential test.

const APP = (childAttrs: string) => `<script setup lang="ts">
import Child from './Child.vue'
</script>
<template><Child ${childAttrs} /></template>
`;

const run = (childAttrs: string, child: string) =>
  shakeMem({ '/p/App.vue': APP(childAttrs), '/p/Child.vue': child }, '/p/App.vue');

describe('CSS removal soundness — non-:class class sources', () => {
  it('keeps `<Transition name>` classes (they are produced at runtime)', async () => {
    const child = `<script setup lang="ts">
const { open = false } = defineProps<{ open?: boolean }>()
</script>
<template>
  <Transition name="fade">
    <div v-if="open" class="panel">x</div>
  </Transition>
</template>
<style scoped>
.panel { color: black }
.fade-enter-active { transition: opacity .2s }
.fade-leave-to { opacity: 0 }
.unused-orphan { color: red }
</style>
`;
    const c = (await run('', child))['/p/Child.vue']!;
    expect(c).toContain('.fade-enter-active');
    expect(c).toContain('.fade-leave-to');
    expect(c).not.toContain('.unused-orphan');
  });

  it('bails CSS entirely when a custom directive is present', async () => {
    const child = `<script setup lang="ts">
const { variant = 'a' } = defineProps<{ variant?: string }>()
</script>
<template>
  <div v-tooltip="'hi'" :class="\`box-\${variant}\`">x</div>
</template>
<style scoped>
.box-a { color: black }
.box-b { color: red }
</style>
`;
    expect((await run('variant="a"', child))['/p/Child.vue']).toContain('.box-b');
  });

  it('bails CSS when the script touches classList', async () => {
    const child = `<script setup lang="ts">
import { onMounted, ref } from 'vue'
const { variant = 'a' } = defineProps<{ variant?: string }>()
const el = ref<HTMLElement>()
onMounted(() => el.value?.classList.add('runtime-added'))
</script>
<template><div ref="el" :class="\`box-\${variant}\`">x</div></template>
<style scoped>
.box-a { color: black }
.box-b { color: red }
.runtime-added { color: green }
</style>
`;
    const c = (await run('variant="a"', child))['/p/Child.vue']!;
    expect(c).toContain('.box-b');
    expect(c).toContain('.runtime-added');
  });

  it('keeps rules using :is()/:where()/:not() (disjunction/negation, not AND)', async () => {
    const child = `<script setup lang="ts">
const { variant = 'a' } = defineProps<{ variant?: string }>()
</script>
<template><div :class="\`box-\${variant}\`">x</div></template>
<style scoped>
.box-a { color: black }
:is(.box-a, .box-z) { font-weight: bold }
.box:not(.box-z) { cursor: pointer }
.box-z { color: red }
</style>
`;
    // variant is only ever 'a', so a naive "every class must be possible" check
    // would wrongly drop the :is()/:not() rules — but :is() is a disjunction
    // (.box-a IS possible) and :not() a negation, so both must survive.
    const c = (await run('variant="a"', child))['/p/Child.vue']!;
    expect(c).toContain(':is(.box-a, .box-z)');
    expect(c).toContain('.box:not(.box-z)');
    // A plain rule for an impossible class is still removed.
    expect(c).not.toContain('.box-z {');
  });
});
