import type { Files } from './engine';

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  entry: string;
  files: Files;
}

// Every preset uses absolute ids so in-memory resolution is unambiguous, and a
// destructured `defineProps` with inline defaults — the form the engine can
// fold (a never-passed prop collapses to its default).

export const presets: Preset[] = [
  {
    id: 'unused-props',
    name: 'Unused props',
    blurb:
      'A 4-prop design-system Button, called with just `variant`. The never-passed props (`loading`, `icon`, `block`) fold to their defaults: dropped from defineProps, demoted to a local const, and their dead `v-if` arms deleted. (For the CSS story, see the next example.)',
    entry: '/App.vue',
    files: {
      '/App.vue': `<script setup lang="ts">
import Button from './Button.vue';
</script>

<template>
  <Button variant="primary">Save</Button>
  <Button variant="primary">Cancel</Button>
</template>
`,
      '/Button.vue': `<script setup lang="ts">
const {
  variant = 'primary',
  loading = false,
  icon = '',
  block = false,
} = defineProps<{
  variant?: string;
  loading?: boolean;
  icon?: string;
  block?: boolean;
}>();
</script>

<template>
  <button :class="['btn', \`btn-\${variant}\`, { block }]">
    <span v-if="loading" class="spinner">…</span>
    <i v-if="icon" :class="\`ico ico-\${icon}\`" />
    <slot />
  </button>
</template>

<style scoped>
.btn { padding: 6px 14px; border-radius: 6px; }
.btn-primary { background: #42b883; color: white; }
.spinner { animation: spin 1s linear infinite; }
.ico { margin-right: 6px; }
.block { width: 100%; }
</style>
`,
    },
  },

  {
    id: 'variant-narrowing',
    name: 'Variant narrowing',
    blurb:
      'Across the whole app, `tone` is only ever "ok" or "warn". The "danger" arm can never run — and the `.tag-danger` rule can never match. Both are removed, but `tone` stays a real, dynamic prop (narrowed, not folded). A bundler cannot reach this.',
    entry: '/App.vue',
    files: {
      '/App.vue': `<script setup lang="ts">
import Tag from './Tag.vue';
</script>

<template>
  <Tag tone="ok">Shipped</Tag>
  <Tag tone="warn">Pending</Tag>
</template>
`,
      '/Tag.vue': `<script setup lang="ts">
const { tone = 'ok' } = defineProps<{
  tone?: 'ok' | 'warn' | 'danger';
}>();
</script>

<template>
  <span :class="['tag', \`tag-\${tone}\`]">
    <b v-if="tone === 'danger'" class="bang">!</b>
    <slot />
  </span>
</template>

<style scoped>
.tag { padding: 2px 9px; border-radius: 999px; }
.tag-ok { background: #11331f; color: #42b883; }
.tag-warn { background: #332611; color: #ffb454; }
.tag-danger { background: #331111; color: #ff5d5d; }
.bang { margin-right: 4px; }
</style>
`,
    },
  },

  {
    id: 'cascade',
    name: 'Whole-program cascade',
    blurb:
      'App → Mid → Heavy. `Mid` only renders the expensive `<Heavy>` widget when `withHeavy` is true — and the app never passes it. The prop folds to `false`, the `v-if` and its `<Heavy>` call site vanish, and the cascade reaches across three files.',
    entry: '/App.vue',
    files: {
      '/App.vue': `<script setup lang="ts">
import Mid from './Mid.vue';
</script>

<template>
  <Mid title="Dashboard" />
  <Mid title="Reports" />
</template>
`,
      '/Mid.vue': `<script setup lang="ts">
import Heavy from './Heavy.vue';

const { title, withHeavy = false } = defineProps<{
  title: string;
  withHeavy?: boolean;
}>();
</script>

<template>
  <section class="panel">
    <h2>{{ title }}</h2>
    <Heavy v-if="withHeavy" :rows="64" />
    <p>Lightweight summary only.</p>
  </section>
</template>

<style scoped>
.panel { border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; }
</style>
`,
      '/Heavy.vue': `<script setup lang="ts">
const { rows = 0 } = defineProps<{ rows?: number }>();
const cells = Array.from({ length: rows }, (_, i) => i);
</script>

<template>
  <div class="heavy">
    <span v-for="n in cells" :key="n" class="px">HEAVY_{{ n }}</span>
  </div>
</template>

<style scoped>
.heavy { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
.px { width: 9px; height: 9px; background: #42b883; }
</style>
`,
    },
  },
];

export function clonePresetFiles(p: Preset): Files {
  return { ...p.files };
}
