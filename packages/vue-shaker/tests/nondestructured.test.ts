import { describe, expect, it } from 'vitest';
import { shakeMem, relMap } from './util';
import { assertSameRender } from './diff';

// ----------------------------------------------------------------------
// The design-system idiom flyle (and most real DS) actually uses:
//   const props = withDefaults(defineProps<{…}>(), {…});   // NOT destructured
//   const classes = computed(() => [`btn-pattern-${props.pattern}`, …]);
//   <button :class="classes">
// The classes are built in the SCRIPT from `props.X`, and Vue prunes no scoped
// CSS — so the unreachable variant rules ship unless the shaker removes them.
// ----------------------------------------------------------------------

const APP = `<script setup lang="ts">
import Button from './Button.vue'
</script>
<template>
  <Button pattern="primary" size="normal">A</Button>
  <Button pattern="secondary">B</Button>
</template>
`;

const BUTTON = `<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(defineProps<{ pattern?: string; size?: string; loading?: boolean }>(), {
  pattern: 'primary',
  size: 'normal',
  loading: false,
})
const classes = computed(() => [
  'btn',
  \`btn-pattern-\${props.pattern}\`,
  \`btn-size-\${props.size}\`,
  ...(props.loading ? ['btn-loading'] : []),
])
</script>

<template>
  <button :class="classes"><slot /></button>
</template>

<style scoped>
.btn { color: black }
.btn-pattern-primary { color: blue }
.btn-pattern-secondary { color: green }
.btn-pattern-danger { color: red }
.btn-size-normal { padding: 4px }
.btn-size-large { padding: 8px }
.btn-loading { opacity: 0.5 }
</style>
`;

const files = { '/p/App.vue': APP, '/p/Button.vue': BUTTON };

describe('non-destructured props + script-computed scoped CSS', () => {
  it('removes scoped rules for class variants the app can never produce', async () => {
    const out = await shakeMem(files, '/p/App.vue');
    const button = out['/p/Button.vue']!;

    // pattern ∈ {primary, secondary}, size ∈ {normal} -> these are reachable.
    expect(button).toContain('.btn-pattern-primary');
    expect(button).toContain('.btn-pattern-secondary');
    expect(button).toContain('.btn-size-normal');
    // danger / large are never produced -> removed (the win Vue can't do itself).
    expect(button).not.toContain('.btn-pattern-danger');
    expect(button).not.toContain('.btn-size-large');
    // `loading` is never passed -> default false -> the spread arm is dead, so
    // `.btn-loading` can never be produced and is removed too.
    expect(button).not.toContain('.btn-loading');

    // Non-destructured form is left structurally intact (no signature surgery).
    expect(button).toContain('const props = withDefaults(defineProps');
  });

  it('is sound — shaken renders identically to the original (differential SSR)', async () => {
    const out = await shakeMem(files, '/p/App.vue');
    const { before, after } = await assertSameRender(relMap(files), relMap(out), 'App.vue');
    expect(after).toBe(before);
    expect(before).toContain('btn-pattern-primary');
    expect(before).toContain('btn-pattern-secondary');
  });

  it('bails CSS when a class source is not enumerable (cross-module map)', async () => {
    const withMap = {
      '/p/App.vue': APP,
      '/p/Button.vue': `<script setup lang="ts">
import { computed } from 'vue'
import { extra } from './map'
const props = withDefaults(defineProps<{ pattern?: string }>(), { pattern: 'primary' })
const classes = computed(() => ['btn', ...extra[props.pattern], \`btn-pattern-\${props.pattern}\`])
</script>
<template><button :class="classes"><slot /></button></template>
<style scoped>
.btn { color: black }
.btn-pattern-danger { color: red }
</style>
`,
      '/p/map.ts': `export const extra = { primary: ['x'], secondary: ['y'] }`,
    };
    const out = await shakeMem(withMap, '/p/App.vue');
    // `extra[props.pattern]` is not enumerable in this subset -> CSS untouched.
    expect(out['/p/Button.vue']).toContain('.btn-pattern-danger');
  });
});
