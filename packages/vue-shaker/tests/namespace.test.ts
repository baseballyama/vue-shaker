import { describe, expect, it } from 'vitest';
import { vueShaker, analyze, transformAll, type Resolve, type ReadFile } from '../src/index';
import { assertSameRender } from './diff';

// ----------------------------------------------------------------------
// The design-system "namespace object" pattern (docs §4.3), exactly as
// @flyle/design-system-vue ships it: components are bundled into ONE nested
// object exported from a barrel, then destructured at every call site.  This is
// the shape that made the whole library invisible to the shaker before — the
// bare workspace import did not resolve, and the components were reached through
// a namespace property rather than a default import.
// ----------------------------------------------------------------------

const INDEX = `
import FuiText from './text/FuiText.vue';
import FuiButton from './button/FuiButton.vue';
const FuiComponents = {
  FuiText,
  button: { FuiButton },
};
export { FuiComponents };
`;

const TEXT = `<script setup lang="ts">
const { type = 'body', truncate = false } = defineProps<{ type?: string; truncate?: boolean }>()
</script>

<template>
  <span :class="['text', \`text-\${type}\`]">
    <span v-if="truncate" class="ellipsis">…</span>
    <slot />
  </span>
</template>

<style scoped>
.text { color: black }
.text-body { font-size: 14px }
.text-heading { font-size: 24px }
.text-caption { font-size: 12px }
</style>
`;

const BUTTON = `<script setup lang="ts">
const { variant = 'primary', loading = false } = defineProps<{ variant?: string; loading?: boolean }>()
</script>

<template>
  <button :class="['btn', \`btn-\${variant}\`]">
    <span v-if="loading" class="spinner">...</span>
    <slot />
  </button>
</template>

<style scoped>
.btn { color: black }
.btn-primary { color: blue }
.btn-danger { color: red }
</style>
`;

const APP = `<script setup lang="ts">
import { FuiComponents } from '@flyle/design-system-vue';
const {
  FuiText,
  button: { FuiButton },
} = FuiComponents;
</script>

<template>
  <FuiText type="body">hi</FuiText>
  <FuiButton variant="primary">go</FuiButton>
</template>
`;

/** A workspace-style resolver: `@flyle/design-system-vue` -> the barrel index. */
function memEngine(files: Record<string, string>): { resolve: Resolve; readFile: ReadFile } {
  const norm = (p: string): string => {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  };
  const dirOf = (id: string) => id.slice(0, id.lastIndexOf('/'));
  const resolve: Resolve = (source, importer) => {
    if (source === '@flyle/design-system-vue') return '/ds/index.ts';
    if (source.startsWith('.')) return norm(dirOf(importer) + '/' + source);
    return null;
  };
  const readFile: ReadFile = (id) => {
    const code = files[id];
    if (code == null) throw new Error(`no such file: ${id}`);
    return code;
  };
  return { resolve, readFile };
}

const files: Record<string, string> = {
  '/ds/index.ts': INDEX,
  '/ds/text/FuiText.vue': TEXT,
  '/ds/button/FuiButton.vue': BUTTON,
  '/app/App.vue': APP,
};

describe('namespace-object design-system pattern', () => {
  it('folds components reached through a nested namespace destructure', async () => {
    const { resolve, readFile } = memEngine(files);
    const out = await vueShaker('/app/App.vue', resolve, readFile);

    const text = out['/ds/text/FuiText.vue']!;
    const button = out['/ds/button/FuiButton.vue']!;
    expect(text).toBeDefined();
    expect(button).toBeDefined();

    // `truncate` is never passed -> dropped + its v-if folded; `type` collapses to
    // {body} (single value) -> folded to a const; unreachable CSS removed.
    expect(text).not.toContain('truncate?: boolean');
    expect(text).toContain('const truncate = false;');
    expect(text).not.toContain('v-if="truncate"');
    expect(text).not.toContain('.text-heading');
    expect(text).not.toContain('.text-caption');
    expect(text).toContain('.text-body');

    // `loading` never passed -> dropped; `variant` collapses to {primary}; the
    // unreachable `.btn-danger` rule is removed (the Vue-can't differentiator).
    expect(button).not.toContain('loading?: boolean');
    expect(button).toContain('const loading = false;');
    expect(button).not.toContain('.btn-danger');
    expect(button).toContain('.btn-primary');
  });

  it('is sound — shaken renders identically to the original (differential SSR)', async () => {
    const { resolve, readFile } = memEngine(files);
    const out = await vueShaker('/app/App.vue', resolve, readFile);

    // Re-key into a self-contained tree the SSR harness can write + resolve.
    // The barrel is a plain `.ts` and is never transformed — it stays INDEX.
    const rewrite = (s: string) => s.replace("from '@flyle/design-system-vue'", "from './ds'");
    const tree: Record<string, string> = {
      'App.vue': rewrite(out['/app/App.vue']!),
      'ds.ts': INDEX,
      'text/FuiText.vue': out['/ds/text/FuiText.vue']!,
      'button/FuiButton.vue': out['/ds/button/FuiButton.vue']!,
    };
    const orig: Record<string, string> = {
      'App.vue': rewrite(APP),
      'ds.ts': INDEX,
      'text/FuiText.vue': TEXT,
      'button/FuiButton.vue': BUTTON,
    };
    const { before, after } = await assertSameRender(orig, tree, 'App.vue');
    expect(after).toBe(before);
    expect(before).toContain('btn-primary');
    expect(before).toContain('text-body');
  });

  it('bails the whole namespace when it ALSO leaks as a runtime value', async () => {
    // One clean consumer (so FuiText is modeled) + one that leaks the bag.
    const leaky = {
      ...files,
      '/app/App.vue': `<script setup lang="ts">
import Leak from './Leak.vue';
import { FuiComponents } from '@flyle/design-system-vue';
const { FuiText } = FuiComponents;
</script>
<template><FuiText type="body">x</FuiText><Leak/></template>
`,
      '/app/Leak.vue': `<script setup lang="ts">
import { FuiComponents } from '@flyle/design-system-vue';
const { FuiText } = FuiComponents;
const all = FuiComponents; // leaks the bag as a value -> sites not enumerable
defineExpose({ all });
</script>
<template><FuiText type="heading">y</FuiText></template>
`,
    };
    const { resolve, readFile } = memEngine(leaky);
    const out = await vueShaker('/app/App.vue', resolve, readFile);
    // FuiText must NOT be folded — the leak makes its call sites unenumerable.
    expect(out['/ds/text/FuiText.vue']).toBe(TEXT);
  });

  it('bails a component instantiated programmatically from a .ts file', async () => {
    // App renders <Modal> with no props; a .ts util shows it with createApp(Modal,
    // { type: 'danger' }).  The template alone would fold `type` to its default —
    // unsound, because the .ts call site passes a different value.
    const files: Record<string, string> = {
      '/app/App.vue': `<script setup lang="ts">
import Modal from './Modal.vue'
</script>
<template><Modal /></template>
`,
      '/app/Modal.vue': `<script setup lang="ts">
const { type = 'info' } = defineProps<{ type?: string }>()
</script>
<template><div :class="\`modal-\${type}\`"><slot /></div></template>
<style scoped>
.modal-info { color: blue }
.modal-danger { color: red }
</style>
`,
      '/app/show.ts': `import { createApp } from 'vue'
import Modal from './Modal.vue'
export function show() { createApp(Modal, { type: 'danger' }).mount('#x') }
`,
    };
    const norm = (p: string): string => {
      const out: string[] = [];
      for (const part of p.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return '/' + out.join('/');
    };
    const dirOf = (id: string) => id.slice(0, id.lastIndexOf('/'));
    const resolve: Resolve = (source, importer) =>
      source.startsWith('.') ? norm(dirOf(importer) + '/' + source) : null;
    const readFile: ReadFile = (id) => {
      const code = files[id];
      if (code == null) throw new Error(`no such file: ${id}`);
      return code;
    };
    const { models, plans } = await analyze('/app/App.vue', resolve, readFile, ['/app/show.ts']);
    const out = transformAll(models, plans);
    // Modal escaped into a .ts file -> bailed -> the `.modal-danger` rule stays.
    expect(out['/app/Modal.vue']).toContain('.modal-danger');
    expect(plans.get('/app/Modal.vue')?.bail).toBe(true);
  });
});
