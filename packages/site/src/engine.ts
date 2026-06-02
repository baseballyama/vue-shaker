// Runs the vue-shaker engine ENTIRELY in the browser over an in-memory file
// map. `vueShaker` is environment-free (it bundles @vue/compiler-sfc,
// @babel/parser and postcss, with no `node:*` imports), so the playground can
// import it straight from 'vue-shaker' and shake on every keystroke.
import { vueShaker } from 'vue-shaker';

export type Files = Record<string, string>; // 'App.vue' -> source

export interface Eliminated {
  /** Props dropped from `defineProps` and demoted to a local const. */
  props: number;
  /** `v-if` arms removed because their guard folded away. */
  vIf: number;
  /** `<style scoped>` rules that can no longer match. */
  cssRules: number;
}

export interface ShakeOutput {
  shaken: Files; // shaken source per original file
  before: number; // total source bytes, before
  after: number; // total source bytes, after
  eliminated: Eliminated;
  error?: string;
}

// ---- in-memory module resolution -------------------------------------

function dirOf(id: string): string {
  const i = id.lastIndexOf('/');
  return i === -1 ? '' : id.slice(0, i);
}

/** Posix-normalize `/a/./b/../c` -> `/a/c`. */
function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

/** Resolve `./Child.vue` within the file map, relative to its importer. */
function makeResolve(keys: () => Set<string>) {
  return (source: string, importer: string): string | null => {
    if (keys().has(source)) return source; // already an absolute id
    if (!source.startsWith('.')) return null; // bare import — not in our map
    const id = normalize(dirOf(importer) + '/' + source);
    return keys().has(id) ? id : null;
  };
}

// ---- metric helpers --------------------------------------------------

const byteLen = (s: string): number =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;

const totalBytes = (files: Files): number =>
  Object.values(files).reduce((n, src) => n + byteLen(src), 0);

/** Count `v-if=` / `v-else-if=` occurrences (a robust proxy for dead arms). */
function countVIf(src: string): number {
  return (src.match(/\bv-(?:else-)?if\s*=/g) ?? []).length;
}

/** Count declared members inside the `defineProps<{ … }>()` type literal. */
function countPropMembers(src: string): number {
  const m = src.match(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>\s*\(/);
  if (!m || !m[1]) return 0;
  // members are separated by `;` or `,` at the top level — close enough for a
  // metric, and we only diff before-vs-after so nested braces cancel out.
  return m[1]
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[A-Za-z_$][\w$]*\??\s*:/.test(s)).length;
}

/** Count CSS rule selectors inside every `<style scoped>` block. */
function countCssRules(src: string): number {
  let total = 0;
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    total += (body.match(/\{/g) ?? []).length; // one `{` per rule
  }
  return total;
}

function diffEliminated(before: Files, after: Files): Eliminated {
  const e: Eliminated = { props: 0, vIf: 0, cssRules: 0 };
  for (const id of Object.keys(before)) {
    const a = after[id];
    if (a === undefined) continue;
    const b = before[id]!;
    e.props += Math.max(0, countPropMembers(b) - countPropMembers(a));
    e.vIf += Math.max(0, countVIf(b) - countVIf(a));
    e.cssRules += Math.max(0, countCssRules(b) - countCssRules(a));
  }
  return e;
}

// ---- public API ------------------------------------------------------

/**
 * Shake `files` from `entry`, returning the slimmed source plus simple,
 * robust metrics. Never throws — parse/engine errors are surfaced as `error`
 * and the original files are returned unchanged.
 */
export async function shake(files: Files, entry: string): Promise<ShakeOutput> {
  const before = totalBytes(files);
  const resolve = makeResolve(() => new Set(Object.keys(files)));
  const readFile = (id: string): string => {
    const code = files[id];
    if (code === undefined) throw new Error(`not found: ${id}`);
    return code;
  };

  try {
    const shaken = await vueShaker(entry, resolve, readFile);
    // The engine only returns reachable files; keep any others untouched so the
    // editor tabs always have something to show.
    const merged: Files = { ...files, ...shaken };
    const after = totalBytes(merged);
    return {
      shaken: merged,
      before,
      after,
      eliminated: diffEliminated(files, merged),
    };
  } catch (err) {
    return {
      shaken: { ...files },
      before,
      after: before,
      eliminated: { props: 0, vIf: 0, cssRules: 0 },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
