import { vueShaker } from '../src/index';

/** Posix-normalize a `/abs/./a/../b` path. */
function norm(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

const dirOf = (id: string) => id.slice(0, id.lastIndexOf('/'));

/** Run the whole-program shake over an in-memory `{ id -> source }` map. */
export function shakeMem(
  files: Record<string, string>,
  entries: string | string[],
): Promise<Record<string, string>> {
  const resolve = (source: string, importer: string) =>
    source.startsWith('.') ? norm(dirOf(importer) + '/' + source) : null;
  const readFile = (id: string) => {
    const code = files[id];
    if (code == null) throw new Error(`no such file: ${id}`);
    return code;
  };
  return vueShaker(entries, resolve, readFile);
}

/** Re-key an `/abs/Name.vue` map to bare `Name.vue` for the SSR temp tree. */
export function relMap(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, code] of Object.entries(files)) out[id.slice(id.lastIndexOf('/') + 1)] = code;
  return out;
}
