import * as path from 'node:path';
import type { Plugin } from 'rollup';
import { vueShaker } from 'vue-shaker';
import { collectVueFiles, fsResolve, fsReadFile } from 'vue-shaker/node';

export interface Options {
  /**
   * Directories to scan for `.vue` components.  Their union must contain the
   * whole app for prop elimination to be sound (docs/ARCHITECTURE.md §4.2).
   */
  include: string[];
  /** Base directory for resolving `include` (defaults to `process.cwd()`). */
  cwd?: string;
}

/**
 * Source-level Vue tree-shaking as a Rollup plugin.  The Vite plugin
 * (`vue-shaker/vite`) is preferred for apps; this exists for plain Rollup
 * pipelines.  Must run before `@vitejs/plugin-vue` / the Vue SFC compiler.
 *
 * L2 per-call-site variant wiring is intentionally omitted: the engine has no
 * L2 yet, so there is nothing to resolve/serve.  We only fold never-passed /
 * app-wide-constant props (L0/L1), which the whole-program `vueShaker` returns
 * as fully-rewritten `.vue` source keyed by absolute path.
 */
export default function rollupPluginVueShaker(options: Options): Plugin {
  let shaken: Record<string, string> = {};
  const base = options.cwd ?? process.cwd();

  return {
    name: 'vue-shaker',
    async buildStart() {
      // Seed the crawl with the call-site-completeness set: every `.vue` under
      // `include`, so the engine sees every place a prop could be passed.
      const entries = options.include.flatMap((p) => collectVueFiles(path.resolve(base, p)));
      if (entries.length === 0) {
        shaken = {};
        return;
      }
      shaken = await vueShaker(entries, fsResolve, fsReadFile);
    },

    transform(code, id) {
      // Strip any Vue query (e.g. `?vue&type=template`); only the bare `.vue`
      // module carries the SFC source we rewrote, matched by absolute path.
      const file = id.split('?')[0]!;
      if (!file.endsWith('.vue')) return null;
      const out = shaken[file];
      if (out == null || out === code) return null;
      return out;
    },
  };
}
