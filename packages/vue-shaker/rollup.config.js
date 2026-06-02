import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { defineConfig } from 'rollup';

// Keep Vue, Babel, postcss, the bundler host, and node builtins external — they
// are runtime deps (or the host's own), never inlined into the published bundle.
const external = [
  /^vue($|\/)/,
  /^@vue\//,
  /^@babel\//,
  /^postcss($|\/)/,
  /^postcss-selector-parser($|\/)/,
  /^node:/,
  'vite',
  'magic-string',
];

const plugins = [resolve(), commonjs(), typescript({ tsconfig: 'tsconfig.json' }), terser()];

export default defineConfig([
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.js', format: 'esm' },
      { file: 'dist/index.cjs', format: 'cjs', name: 'vueShaker' },
    ],
    external,
    plugins,
  },
  {
    // The Vite plugin entry — self-contained (the engine is bundled in) so the
    // published `./vite` export has no intra-package resolution to satisfy.
    input: 'src/vite.ts',
    output: [{ file: 'dist/vite.js', format: 'esm' }],
    external,
    plugins,
  },
  {
    // Node-only glue (`fsResolve`, `collectVueFiles`) — the `./node` entry.
    input: 'src/scan.ts',
    output: [{ file: 'dist/scan.js', format: 'esm' }],
    external,
    plugins,
  },
]);
