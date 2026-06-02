import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVue } from '../src/parse';

// The Rust engine (Stage A) is verified by differential parity against the TS
// engine: both must extract the same SFC block model.  The native binary is not
// committed (built via `cargo build` in engine-rs), so this suite SKIPS when it
// is absent — CI without a Rust toolchain stays green (docs/RUST-MIGRATION.md).
const bin = fileURLToPath(new URL('../engine-rs/target/debug/vue-shaker-rs', import.meta.url));
const hasRust = existsSync(bin);

const BUTTON = `<script setup lang="ts">
const { variant = 'primary', loading = false } = defineProps<{ variant?: string; loading?: boolean }>()
</script>

<template>
  <button :class="['btn', \`btn-\${variant}\`]">
    <span v-if="loading">...</span>
    <slot />
  </button>
</template>

<style scoped>
.btn { color: black }
.btn-danger { color: red }
</style>
`;

const fixtures: Record<string, string> = {
  'Button.vue': BUTTON,
  'Plain.vue': '<template><div class="x" /></template>\n',
};

interface RustModel {
  hasScriptSetup: boolean;
  scriptSetupContent: string | null;
  templateParseErrors: number;
  styles: Array<{ scoped: boolean; content: string }>;
}

const runRust = (file: string): RustModel =>
  JSON.parse(execFileSync(bin, [file], { encoding: 'utf8' })) as RustModel;

(hasRust ? describe : describe.skip)('Rust <-> TS Stage A parity (vize)', () => {
  for (const [name, src] of Object.entries(fixtures)) {
    it(`extracts the same SFC block model for ${name}`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'vue-shaker-parity-'));
      const file = path.join(dir, name);
      writeFileSync(file, src);
      let rust: RustModel;
      try {
        rust = runRust(file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const ts = parseVue(src, file);

      expect(rust.hasScriptSetup).toBe(ts.scriptSetup != null);
      expect(rust.scriptSetupContent ?? null).toBe(ts.scriptSetup?.content ?? null);
      expect(rust.styles.map((s) => ({ scoped: s.scoped, content: s.content }))).toEqual(
        ts.styles.map((s) => ({ scoped: s.scoped, content: s.content })),
      );
      expect(rust.templateParseErrors).toBe(0);
    });
  }
});
