// ----------------------------------------------------------------------
// Differential-SSR soundness oracle (docs/ARCHITECTURE.md §soundness).
//
// Compile + server-render a `.vue` graph with the REAL Vue toolchain (Vite +
// @vitejs/plugin-vue + @vue/server-renderer), normalize the HTML, and compare
// original vs shaken.  The whole contract of vue-shaker is that the shaken
// source renders identically for every value the app actually passes — this is
// what proves it.
// ----------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

/** Strip SSR comment anchors, scope-id attributes, and collapse whitespace. */
export function normalizeHtml(html: string): string {
  return html
    .replace(/<!--[^]*?-->/g, '') // SSR fragment anchors / comments
    .replace(/\s+data-v-[0-9a-f]+(="")?/g, '') // scoped-style ids
    .replace(/\s+/g, ' ')
    .trim();
}

/** A map of repo-relative file path -> source code. */
export type FileMap = Record<string, string>;

function writeTree(files: FileMap): string {
  // Inside the package's node_modules so the compiled SSR module resolves `vue`
  // by walking up to the workspace node_modules (a /tmp dir cannot — gitignored).
  const base = path.join(process.cwd(), 'node_modules', '.vue-shaker-test');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'r-'));
  for (const [rel, code] of Object.entries(files)) {
    const full = path.join(dir, rel.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, code);
  }
  return dir;
}

/**
 * Server-render `entry` (a key of `files`) with `props`, returning normalized
 * HTML.  Uses a throwaway Vite server so child `.vue` imports resolve exactly as
 * they would in a real build.
 */
export async function renderEntry(
  files: FileMap,
  entry: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  const dir = writeTree(files);
  const server = await createServer({
    root: dir,
    logLevel: 'silent',
    server: { middlewareMode: true },
    plugins: [vue()],
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const entryPath = path.join(dir, entry.replace(/^\/+/, ''));
    const mod = await server.ssrLoadModule(entryPath);
    const app = createSSRApp(mod['default'] as object, props);
    return normalizeHtml(await renderToString(app));
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert that `files` and `shaken` render the same HTML for `entry`/`props`. */
export async function assertSameRender(
  original: FileMap,
  shaken: FileMap,
  entry: string,
  props: Record<string, unknown> = {},
): Promise<{ before: string; after: string }> {
  const before = await renderEntry(original, entry, props);
  const after = await renderEntry(shaken, entry, props);
  return { before, after };
}
