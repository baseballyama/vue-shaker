<script setup lang="ts">
// Only `variant` is ever passed at a call site (see App.vue). vue-shaker folds
// the never-passed / app-constant props (`size`, `loading`, `icon`, `rounded`):
// they are dropped from this `defineProps` signature and demoted to local
// consts, their dead `v-if` arms are removed, and the now-unreachable
// `.btn-danger` / `.btn-ghost` / `.spinner` rules are stripped from the scoped
// styles below.
const {
  variant = 'primary',
  size = 'md',
  loading = false,
  icon = '',
  rounded = false,
} = defineProps<{
  variant?: string;
  size?: string;
  loading?: boolean;
  icon?: string;
  rounded?: boolean;
}>();
</script>

<template>
  <button class="btn" :class="[`btn-${variant}`, `btn-${size}`, { 'btn-rounded': rounded }]">
    <span v-if="loading" class="spinner" />
    <span v-if="icon" class="icon">{{ icon }}</span>
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.btn-rounded {
  border-radius: 999px;
}
.btn-primary {
  background: #2563eb;
  color: #fff;
}
.btn-secondary {
  background: #e5e7eb;
  color: #111;
}
.btn-danger {
  background: #dc2626;
  color: #fff;
}
.btn-ghost {
  background: transparent;
  color: #2563eb;
}
.spinner {
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
