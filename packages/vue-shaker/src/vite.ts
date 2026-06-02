import * as path from 'node:path';
import type { Plugin } from 'vite';
import { analyze } from './analyze';
import { transformAll } from './transform';
import { collectVueFiles, fsReadFile, fsResolve } from './scan';

export interface ShakerOptions {
  /**
   * Dirs (relative to the Vite root) holding EVERY `.vue` call site.  Prop
   * elimination is only sound if every consumer of a prop is in scope.  Defaults
   * to the Vite root.
   */
  include?: string[];
  /**
   * Optimization level.  L0/L1/L1.5 + CSS are always on; `2` opts into L2
   * monomorphization (not yet implemented — accepted for forward compatibility).
   */
  level?: 0 | 1 | 2;
  /** L2 tuning; consulted only when `level: 2` (not yet implemented). */
  monomorphize?: boolean | { maxVariants?: number };
}

/**
 * The Vite plugin Shell (docs/ARCHITECTURE.md §5/§6).  It runs `enforce: 'pre'`
 * and `apply: 'build'` so it hands already-slimmed `.vue` source to
 * `@vitejs/plugin-vue` — and only in `vite build`, never dev (dev is a
 * pass-through by design; whole-program analysis is incompatible with HMR).
 */
export function shaker(options: ShakerOptions = {}): Plugin {
  const include = options.include ?? ['.'];
  let root = process.cwd();
  let shaken: Record<string, string> = {};

  return {
    name: 'vue-shaker',
    enforce: 'pre',
    apply: 'build',

    configResolved(config) {
      root = config.root;
    },

    async buildStart() {
      const entries = include.flatMap((dir) => collectVueFiles(path.resolve(root, dir)));
      if (entries.length === 0) return;
      const { models, plans } = await analyze(entries, fsResolve, fsReadFile);
      shaken = transformAll(models, plans);
    },

    transform(code, id) {
      // Only the MAIN `.vue` request (no `?vue&type=…` subresource) is rewritten;
      // we hand the slimmed source to `@vitejs/plugin-vue`, which runs after us.
      const file = id.split('?', 1)[0]!;
      if (!file.endsWith('.vue')) return null;
      const out = shaken[file] ?? shaken[path.normalize(file)];
      if (out == null || out === code) return null;
      return { code: out, map: null };
    },
  };
}
