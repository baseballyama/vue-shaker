import * as path from 'node:path';
import type { Plugin } from 'vite';
import { analyze, type Resolve } from './analyze';
import { transformAll } from './transform';
import { collectScriptFiles, collectVueFiles, fsReadFile } from './scan';

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
      const roots = include.map((dir) => path.resolve(root, dir));
      const entries = roots.flatMap(collectVueFiles);
      if (entries.length === 0) return;
      // Non-`.vue` files in scope are scanned for components that escape into
      // script (programmatic `createApp`/`h`), whose props no template enumerates.
      const escapeScanFiles = roots.flatMap(collectScriptFiles);
      // Resolve through Vite so workspace packages (`@flyle/design-system-vue`),
      // tsconfig/`resolve.alias` paths, and relative imports all resolve exactly
      // as the real build does — `fsResolve` only handled `./` relative imports,
      // which made design-system call sites (a bare workspace import) invisible
      // and left the whole library unshaken.  Skip anything resolving into
      // `node_modules`: published deps ship compiled and cannot be shaken, and
      // crawling them would be pointless work.
      const resolve: Resolve = async (source, importer) => {
        // Arrow keeps `this` bound to the Rollup plugin context (`buildStart`).
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;
        const file = resolved.id.split('?', 1)[0]!;
        if (file.includes('\0') || file.includes('/node_modules/')) return null;
        return file;
      };
      const { models, plans } = await analyze(entries, resolve, fsReadFile, escapeScanFiles);
      shaken = transformAll(models, plans);
    },

    transform(code, id) {
      // Only the MAIN `.vue` request (no `?vue&type=…` subresource) is rewritten;
      // we hand the slimmed source to `@vitejs/plugin-vue`, which runs after us.
      // `@vitejs/plugin-vue` re-requests each block as `App.vue?vue&type=script…`;
      // those carry a query and must pass through untouched, or we would feed the
      // whole SFC back in place of a single block and break esbuild.
      if (id.includes('?')) return null;
      const file = id.split('?', 1)[0]!;
      if (!file.endsWith('.vue')) return null;
      const out = shaken[file] ?? shaken[path.normalize(file)];
      if (out == null || out === code) return null;
      return { code: out, map: null };
    },
  };
}
