import type { Files } from './engine';

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  /** Shake root — must reach every call site. */
  entry: string;
  /** File shown first (where the shake is most visible); defaults to `entry`. */
  focus?: string;
  files: Files;
}

// Every preset uses absolute ids so in-memory resolution is unambiguous, and a
// destructured `defineProps` with inline defaults — the form the engine can
// fold (a never-passed prop collapses to its default).

export const presets: Preset[] = [
  {
    id: 'design-system-button',
    name: 'Design-system Button',
    blurb:
      'A real design-system Button: 8 variants × hover, 4 sizes, loading/icon/elevated states. This app only ever renders `primary` and `secondary` at the default size — so two-thirds of the component is dead here. vue-shaker deletes the 15 unreachable `<style scoped>` rules (no bundler can — Vue ships every one) and the dead `v-if` blocks. Watch the size drop.',
    entry: '/App.vue',
    focus: '/Button.vue',
    files: {
      '/App.vue': `<script setup lang="ts">
import Button from './Button.vue';
</script>

<template>
  <Button variant="primary">Save changes</Button>
  <Button variant="secondary">Cancel</Button>
</template>
`,
      '/Button.vue': `<script setup lang="ts">
// A design-system button with the usual pile of props. This app passes only
// \`variant\` (primary / secondary) — everything else stays at its default.
const {
  variant = 'primary',
  size = 'md',
  loading = false,
  icon = '',
  iconRight = false,
  rounded = false,
  block = false,
  elevated = false,
} = defineProps<{
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'ghost' | 'link';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  loading?: boolean;
  icon?: string;
  iconRight?: boolean;
  rounded?: boolean;
  block?: boolean;
  elevated?: boolean;
}>();
</script>

<template>
  <button
    :class="['btn', \`btn-\${variant}\`, \`btn-\${size}\`, { 'btn-rounded': rounded, 'btn-block': block }]"
  >
    <span v-if="elevated" class="btn-shadow" aria-hidden="true" />
    <span v-if="loading" class="btn-spinner" role="status">
      <svg viewBox="0 0 24 24" class="btn-spinner-svg"><circle cx="12" cy="12" r="10" /></svg>
    </span>
    <i v-if="icon && !iconRight" :class="\`ico ico-\${icon}\`" />
    <span class="btn-label"><slot /></span>
    <i v-if="icon && iconRight" :class="\`ico ico-\${icon}\`" />
  </button>
</template>

<style scoped>
.btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; font-weight: 600; cursor: pointer; }

.btn-primary { background: #42b883; color: #07140d; }
.btn-primary:hover { background: #3aa776; }
.btn-secondary { background: #2e3742; color: #e7ecf0; }
.btn-secondary:hover { background: #394453; }
.btn-success { background: #2f9e44; color: #fff; }
.btn-success:hover { background: #2b8a3e; }
.btn-danger { background: #e03131; color: #fff; }
.btn-danger:hover { background: #c92a2a; }
.btn-warning { background: #f08c00; color: #1a1206; }
.btn-warning:hover { background: #e8590c; }
.btn-info { background: #1c7ed6; color: #fff; }
.btn-info:hover { background: #1971c2; }
.btn-ghost { background: transparent; color: #42b883; border-color: #42b883; }
.btn-ghost:hover { background: rgba(66, 184, 131, 0.1); }
.btn-link { background: transparent; color: #6ee7b7; text-decoration: underline; }
.btn-link:hover { color: #42b883; }

.btn-sm { padding: 3px 10px; font-size: 12px; border-radius: 5px; }
.btn-md { padding: 6px 14px; font-size: 14px; border-radius: 7px; }
.btn-lg { padding: 9px 20px; font-size: 16px; border-radius: 9px; }
.btn-xl { padding: 13px 26px; font-size: 19px; border-radius: 11px; }

.btn-rounded { border-radius: 999px; }
.btn-block { width: 100%; justify-content: center; }
.btn-shadow { position: absolute; inset: 0; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
.btn-spinner { display: inline-flex; }
.btn-spinner-svg { width: 16px; height: 16px; animation: spin 0.8s linear infinite; }
.ico { width: 16px; height: 16px; }
.btn-label { white-space: nowrap; }
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
    focus: '/Tag.vue',
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
    focus: '/Mid.vue',
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
