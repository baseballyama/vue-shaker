import { describe, expect, it } from 'vitest';
import { shakeMem, relMap } from './util';
import { assertSameRender } from './diff';

const APP = `<script setup lang="ts">
import Button from './Button.vue'
</script>

<template>
  <Button variant="primary" :loading="false">A</Button>
  <Button variant="secondary">B</Button>
</template>
`;

const BUTTON = `<script setup lang="ts">
const { variant = 'primary', loading = false, icon = '' } = defineProps<{ variant?: string; loading?: boolean; icon?: string }>()
</script>

<template>
  <button :class="['btn', \`btn-\${variant}\`]">
    <span v-if="loading" class="spinner">...</span>
    <i v-if="icon" :class="\`icon-\${icon}\`" />
    <slot />
  </button>
</template>

<style scoped>
.btn { color: black }
.btn-primary { color: blue }
.btn-secondary { color: green }
.btn-danger { color: red }
</style>
`;

const files = { '/p/App.vue': APP, '/p/Button.vue': BUTTON };

describe('whole-program shake (L0/L1/L1.5 + CSS)', () => {
  it('drops never-passed props, folds their v-if, removes dead CSS', async () => {
    const out = await shakeMem(files, '/p/App.vue');
    const button = out['/p/Button.vue']!;
    const app = out['/p/App.vue']!;

    // L1: `loading` / `icon` are never passed -> dropped from the signature and
    // demoted to a local const; their `v-if` arms are gone.
    expect(button).not.toContain('loading?: boolean');
    expect(button).not.toContain('icon?: string');
    expect(button).toContain('const loading = false;');
    expect(button).toContain('const icon = "";');
    expect(button).not.toContain('v-if="loading"');
    expect(button).not.toContain('v-if="icon"');

    // L1.5: `variant` collapses to a value set {primary, secondary}, stays in the
    // signature and template (still genuinely used).
    expect(button).toContain('variant');
    expect(button).toContain('btn-${variant}');

    // CSS: `.btn-danger` can never be produced -> removed; the reachable ones stay.
    expect(button).not.toContain('.btn-danger');
    expect(button).toContain('.btn-primary');
    expect(button).toContain('.btn-secondary');

    // Call site: the now-dropped `:loading="false"` attribute is stripped.
    expect(app).not.toContain(':loading');
  });

  it('is sound — shaken renders identically to the original (differential SSR)', async () => {
    const out = await shakeMem(files, '/p/App.vue');
    const { before, after } = await assertSameRender(relMap(files), relMap(out), 'App.vue');
    expect(after).toBe(before);
    expect(before).toContain('btn-primary');
    expect(before).toContain('btn-secondary');
  });
});
