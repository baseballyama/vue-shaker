<script setup lang="ts">
import Button from './components/Button.vue';
</script>

<template>
  <main>
    <h1>vue-shaker demo</h1>
    <!--
      Only `variant` is ever passed. `loading`, `icon`, `rounded`, `size`
      are never supplied by any call site, so vue-shaker folds them: the
      v-if spinner/icon branches and the unused .btn-danger/.btn-ghost
      CSS rules are dropped from the build output.
    -->
    <Button variant="primary">Save</Button>
    <Button variant="secondary">Cancel</Button>
  </main>
</template>
