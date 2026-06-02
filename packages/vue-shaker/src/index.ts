import { analyze, type ReadFile, type Resolve } from './analyze';
import { transformAll } from './transform';
import type { ComponentId } from './ir';

export type {
  ComponentId,
  AnalyzeInput,
  InputFile,
  ResolvedEdge,
  EdgeKind,
  EditResult,
  ComponentPlan,
  PropAbstraction,
  PropValueSet,
  Literal,
} from './ir';
export type { Resolve, ReadFile, FileModel, AnalyzeResult } from './analyze';
export { analyze, analyzeInput, buildAnalyzeInput } from './analyze';
export { transformAll } from './transform';

/**
 * Whole-program shake: crawl the component graph from `entries`, decide what to
 * fold, and return the shaken source for every reachable `.vue` file.
 *
 * `resolve` / `readFile` are injected so the engine stays environment-free — it
 * has NO `node:*` imports, so it runs unchanged in the browser (the playground
 * passes an in-memory file map).  A Vite plugin passes `this.resolve`; Node
 * callers use `fsResolve` / `fsReadFile` from `vue-shaker/node`.  See
 * docs/ARCHITECTURE.md §5 — this is the Engine; the Shell owns resolution.
 */
export async function vueShaker(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
): Promise<Record<ComponentId, string>> {
  const { models, plans } = await analyze(entries, resolve, readFile);
  return transformAll(models, plans);
}
