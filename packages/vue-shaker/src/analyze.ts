import {
  exprContent,
  parseExpr,
  parseCached,
  parseVue,
  walkBabel,
  walkTemplate,
  isComponentNode,
  VueNode,
  type AnyNode,
  type ParseCache,
  type ParsedSfc,
} from './parse';
import {
  emptyPlan,
  type AnalyzeInput,
  type ComponentId,
  type ComponentPlan,
  type InputFile,
  type Literal,
  type PropValueSet,
  type ResolvedEdge,
} from './ir';
import { computeDeadSpans, nodeInSpans, type Span } from './dead';
import { evaluate } from './eval';

export type Resolve = (
  source: string,
  importer: ComponentId,
) => Promise<ComponentId | null> | ComponentId | null;
export type ReadFile = (id: ComponentId) => Promise<string> | string;

/** One declared prop in a `defineProps` destructuring. */
export interface PropDecl {
  name: string;
  /** The `ObjectProperty` node inside the destructure pattern (for removal). */
  property: AnyNode;
  /** Default value expression (inline `= d` or via `withDefaults`), if any. */
  defaultExpr?: AnyNode | undefined;
}

/** Everything we learn from parsing one component, reused by the transform. */
export interface FileModel {
  id: ComponentId;
  code: string;
  sfc: ParsedSfc;
  /** local import name (`Child`) -> resolved child component id. */
  imports: Map<string, ComponentId>;
  /** Declared props, or `null` if the component has no destructured `defineProps`. */
  props: PropDecl[] | null;
  /** The `const { … } = defineProps()` declarator's ObjectPattern, for editing. */
  propsPattern?: AnyNode | undefined;
  /** The whole `VariableDeclaration` statement (absolute span via scriptBase). */
  propsDeclaration?: AnyNode | undefined;
  /** The `defineProps<{…}>()` call, whose type args hold the prop type members. */
  definePropsCall?: AnyNode | undefined;
  hasRestProp: boolean;
  /** True when the destructure shares its statement with other declarators. */
  sharesStatement: boolean;
  /** Every `<Child .../>` this component renders. */
  childCalls: ChildCall[];
  /** Names bound by a template/script scope that collide with a prop name. */
  shadowedNames: Set<string>;
  /** Child ids leaked as a value (`<component :is="Child">`, value use). */
  escapedComponents: Set<ComponentId>;
  /** Child ids rendered through a barrel/named import (sites unobservable). */
  barrelChildIds: Set<ComponentId>;
  bailReasons: string[];
}

/** One `<Child .../>` instance rendered by a component. */
export interface ChildCall {
  childId: ComponentId;
  node: AnyNode;
}

/** One value passed explicitly to a prop at one call site (last-write-wins). */
export interface ExplicitProp {
  value: Literal;
  dynamic: boolean;
  afterLastSpread: boolean;
}

/** How a child component is called at one `<Child .../>` site. */
export interface CallSite {
  hadSpread: boolean;
  explicit: Map<string, ExplicitProp>;
}

interface Usage {
  sites: CallSite[];
}

export interface AnalyzeResult {
  models: Map<ComponentId, FileModel>;
  plans: Map<ComponentId, ComponentPlan>;
}

const isVue = (source: string) => source.endsWith('.vue');

/** Hard cap on fixpoint iterations (convergence is monotone — see svelte-shaker). */
const MAX_FIXPOINT_ITERATIONS = 10;

const ESCAPE_REASON = 'escapes as value (e.g. <component :is="X">)';
const BARREL_REASON = 'rendered through a barrel/named import (call sites unobservable)';
const SCRIPT_BASE_DEFAULT = 0;

/** The absolute SFC base offset of a model's `<script setup>` (0 if none). */
function scriptBase(model: FileModel): number {
  return model.sfc.scriptSetup?.base ?? SCRIPT_BASE_DEFAULT;
}

export async function analyze(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
): Promise<AnalyzeResult> {
  return analyzeInput(await buildAnalyzeInput(entries, resolve, readFile));
}

/**
 * The pure, environment-free engine entry (docs/RUST-MIGRATION.md §2): given a
 * fully-resolved, batched {@link AnalyzeInput}, build every component's model and
 * compute its plan to a whole-program fixpoint (docs §2.1).  No IO/resolution.
 */
export function analyzeInput(input: AnalyzeInput, parseCache?: ParseCache): AnalyzeResult {
  const models = buildModels(input, parseCache);

  // Escape bail (docs §4.1): a component leaked as a value has an unobservable
  // prop profile.  Union escapes across files and stamp a bail reason.
  const escaped = new Set<ComponentId>();
  for (const model of models.values()) for (const id of model.escapedComponents) escaped.add(id);
  for (const id of escaped) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(ESCAPE_REASON)) model.bailReasons.push(ESCAPE_REASON);
  }

  // Barrel bail (docs §4.2): a child rendered through a barrel/named import has
  // sites we cannot attribute to its value set — fold on partial info is unsound.
  const barreled = new Set<ComponentId>();
  for (const model of models.values()) for (const id of model.barrelChildIds) barreled.add(id);
  for (const id of barreled) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(BARREL_REASON)) model.bailReasons.push(BARREL_REASON);
  }

  let plans = buildPlans(models, buildUsage(models, new Map()));
  for (let i = 0; i < MAX_FIXPOINT_ITERATIONS; i++) {
    const deadSpans = deadSpansForPlans(models, plans);
    const nextPlans = buildPlans(models, buildUsage(models, deadSpans));
    if (plansEqual(plans, nextPlans)) {
      plans = nextPlans;
      break;
    }
    plans = nextPlans;
  }
  return { models, plans };
}

function buildModels(input: AnalyzeInput, parseCache?: ParseCache): Map<ComponentId, FileModel> {
  const edgesByFrom = new Map<ComponentId, ResolvedEdge[]>();
  for (const edge of input.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) list.push(edge);
    else edgesByFrom.set(edge.from, [edge]);
  }
  const models = new Map<ComponentId, FileModel>();
  for (const file of input.files) {
    models.set(file.id, buildModelFromInput(file, edgesByFrom.get(file.id) ?? [], parseCache));
  }
  return models;
}

/**
 * The Shell-side resolution + IO layer (docs/RUST-MIGRATION.md §2.1): BFS-crawl
 * the component graph from `entries`, resolving every import edge and reading
 * every reachable `.vue` file up front into a batched {@link AnalyzeInput}.
 */
export async function buildAnalyzeInput(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  parseCache?: ParseCache,
): Promise<AnalyzeInput> {
  const entryList = Array.isArray(entries) ? [...entries] : [entries];
  const files: InputFile[] = [];
  const edges: ResolvedEdge[] = [];
  const queue: ComponentId[] = [...entryList];
  const seen = new Set<ComponentId>(queue);

  while (queue.length > 0) {
    const id = queue.shift()!;
    let code: string;
    try {
      code = await readFile(id);
    } catch {
      continue;
    }
    files.push({ id, code });

    let sfc: ParsedSfc;
    try {
      sfc = parseCached(id, code, parseCache);
    } catch {
      continue;
    }
    if (!sfc.scriptSetup) continue;

    const barrelLocals = new Map<string, ComponentId>();
    const directChildren: ComponentId[] = [];
    for (const imp of importSources(sfc.scriptSetup.ast)) {
      if (imp.imported === 'default' && isVue(imp.value)) {
        const childId = await resolve(imp.value, id);
        if (childId) {
          edges.push({ from: id, local: imp.local, to: childId, kind: 'default-vue' });
          directChildren.push(childId);
        }
        continue;
      }
      const childId = await resolveThroughBarrel(imp.value, imp.imported, id, resolve, readFile);
      if (childId) {
        edges.push({ from: id, local: imp.local, to: childId, kind: 'barrel' });
        barrelLocals.set(imp.local, childId);
      }
    }

    const rendered = collectRenderedComponents(sfc.template, barrelLocals);
    for (const childId of [...directChildren, ...rendered]) {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    }
  }
  return { files, edges, entries: entryList };
}

function buildUsage(
  models: Map<ComponentId, FileModel>,
  deadSpans: Map<ComponentId, Span[]>,
): Map<ComponentId, Usage> {
  const usage = new Map<ComponentId, Usage>();
  const usageOf = (id: ComponentId): Usage => {
    let u = usage.get(id);
    if (!u) {
      u = { sites: [] };
      usage.set(id, u);
    }
    return u;
  };
  for (const model of models.values()) {
    const dead = deadSpans.get(model.id) ?? [];
    const base = scriptBase(model);
    for (const call of model.childCalls) {
      if (dead.length > 0 && nodeInSpans(call.node, dead)) continue;
      usageOf(call.childId).sites.push(readCallSite(call.node, base));
    }
  }
  return usage;
}

function buildPlans(
  models: Map<ComponentId, FileModel>,
  usage: Map<ComponentId, Usage>,
): Map<ComponentId, ComponentPlan> {
  const plans = new Map<ComponentId, ComponentPlan>();
  for (const model of models.values()) plans.set(model.id, buildPlan(model, usage.get(model.id)));
  return plans;
}

function plansEqual(
  a: Map<ComponentId, ComponentPlan>,
  b: Map<ComponentId, ComponentPlan>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, pa] of a) {
    const pb = b.get(id);
    if (!pb) return false;
    if (pa.bail !== pb.bail) return false;
    if (!literalMapEqual(pa.constFold, pb.constFold)) return false;
    if (!literalArrayMapEqual(pa.narrow, pb.narrow)) return false;
  }
  return true;
}

function literalMapEqual(a: Map<string, Literal>, b: Map<string, Literal>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || !Object.is(b.get(k), v)) return false;
  return true;
}

function literalArrayMapEqual(a: Map<string, Literal[]>, b: Map<string, Literal[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb || va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (!Object.is(va[i], vb[i])) return false;
  }
  return true;
}

export function deadSpansForPlans(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Map<ComponentId, Span[]> {
  const out = new Map<ComponentId, Span[]>();
  for (const model of models.values()) {
    const plan = plans.get(model.id)!;
    if (plan.bail) continue;
    const spans = computeDeadSpans(model.sfc.template, plan.constFold, plan.narrow);
    if (spans.length > 0) out.set(model.id, spans);
  }
  return out;
}

function buildModelFromInput(
  file: InputFile,
  edges: ResolvedEdge[],
  parseCache?: ParseCache,
): FileModel {
  const { id, code } = file;
  const sfc = parseCached(id, code, parseCache);
  const imports = new Map<string, ComponentId>();
  const barrelLocals = new Map<string, ComponentId>();
  for (const edge of edges) {
    if (edge.kind === 'default-vue') imports.set(edge.local, edge.to);
    else barrelLocals.set(edge.local, edge.to);
  }
  const bailReasons: string[] = [];

  // defineExpose / defineCustomElement expose props as public surface -> bail.
  if (sfc.scriptSetup) {
    for (const name of macroCalls(sfc.scriptSetup.ast)) {
      if (name === 'defineExpose') bailReasons.push('defineExpose() (public instance surface)');
    }
  }

  let props: PropDecl[] | null = null;
  let propsPattern: AnyNode | undefined;
  let propsDeclaration: AnyNode | undefined;
  let definePropsCall: AnyNode | undefined;
  let hasRestProp = false;
  let sharesStatement = false;
  const importedLocals = new Set<string>();

  if (sfc.scriptSetup) {
    for (const imp of importSources(sfc.scriptSetup.ast)) importedLocals.add(imp.local);

    const found = findPropsDeclaration(sfc.scriptSetup.ast);
    if (found) {
      propsDeclaration = found.declaration;
      propsPattern = found.pattern;
      definePropsCall = found.definePropsCall;
      sharesStatement = found.sharesStatement;
      if (found.sharesStatement)
        bailReasons.push('defineProps() shares a multi-declarator statement');
      props = [];
      for (const p of found.pattern.properties ?? []) {
        if (p.type === 'RestElement') {
          hasRestProp = true;
          continue;
        }
        if (p.type !== 'ObjectProperty') continue;
        const key = p.key;
        if (key?.type !== 'Identifier' || !key.name) continue;
        const value = p.value as AnyNode | undefined;
        const inlineDefault = value?.type === 'AssignmentPattern' ? value.right : undefined;
        props.push({
          name: key.name,
          property: p,
          defaultExpr: inlineDefault ?? found.withDefaults.get(key.name),
        });
      }
    }
  }

  const childCalls = collectChildCalls(sfc.template, imports);
  const barrelChildIds = collectRenderedComponents(sfc.template, barrelLocals);
  const shadowedNames = collectTemplateBindings(sfc);
  const escapedComponents = collectEscapedComponents(sfc, imports, importedLocals);

  return {
    id,
    code,
    sfc,
    imports,
    props,
    propsPattern,
    propsDeclaration,
    definePropsCall,
    hasRestProp,
    sharesStatement,
    childCalls,
    shadowedNames,
    escapedComponents,
    barrelChildIds,
    bailReasons,
  };
}

/** Names bound by template scopes (`v-for`, scoped slots) and script callbacks. */
function collectTemplateBindings(sfc: ParsedSfc): Set<string> {
  const shadowed = new Set<string>();

  // Template binders: `v-for` aliases, `v-slot` props.
  walkTemplate(sfc.template, (node) => {
    if (node.type !== VueNode.ELEMENT) return;
    for (const p of node.props ?? []) {
      if (p.type !== VueNode.DIRECTIVE) continue;
      if (p.name === 'for') addForAliasNames(exprContent(p.exp), shadowed);
      else if (p.name === 'slot') addPatternFromExpr(exprContent(p.exp), shadowed);
    }
  });

  // Script-side: callback/function PARAMETERS and nested local declarations whose
  // name collides with a prop are a different entity there.  Over-approximating
  // is sound (we only ever refuse to fold), so we collect every binder.
  const ss = sfc.scriptSetup;
  if (ss) {
    walkBabel(ss.ast, (node) => {
      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        for (const param of node.params ?? []) addPatternNames(param, shadowed);
      }
    });
  }
  return shadowed;
}

/** Parse `(item, idx) in list` aliases into bound names via an arrow's params. */
function addForAliasNames(exp: string | undefined, out: Set<string>): void {
  if (!exp) return;
  // Split off the iterable: the alias is everything before the last ` in `/` of `.
  const m = /^(.*?)\s+(?:in|of)\s+/s.exec(exp);
  const alias = (m ? m[1] : exp)!.trim();
  if (!alias) return;
  addPatternFromExpr(alias, out);
}

/** Treat `expr` as an arrow parameter list and add every bound identifier. */
function addPatternFromExpr(expr: string | undefined, out: Set<string>): void {
  if (!expr) return;
  const ast = parseExpr(`(${expr}) => 0`);
  if (ast?.type !== 'ArrowFunctionExpression') {
    // Fallback: a bare destructure like `{ a, b }` parses as an expression.
    const single = parseExpr(expr);
    if (single) addPatternNames(single, out);
    return;
  }
  for (const param of ast.params ?? []) addPatternNames(param, out);
}

function addPatternNames(pattern: AnyNode | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      if (pattern.name) out.add(pattern.name);
      return;
    case 'ObjectExpression':
    case 'ObjectPattern':
      for (const prop of pattern.properties ?? []) {
        if (prop.type === 'RestElement') addPatternNames(prop.argument, out);
        else if (prop.type === 'ObjectProperty' || prop.type === 'Property')
          addPatternNames((prop.value as AnyNode) ?? prop.key, out);
      }
      return;
    case 'ArrayExpression':
    case 'ArrayPattern':
      for (const el of pattern.elements ?? []) addPatternNames(el, out);
      return;
    case 'AssignmentPattern':
      addPatternNames(pattern.left, out);
      return;
    case 'RestElement':
      addPatternNames(pattern.argument, out);
      return;
    default:
      return;
  }
}

/**
 * Imported component ids that ESCAPE — referenced as a value rather than only as
 * a `<Comp .../>` element name.  The dominant template case is `<component
 * :is="X">`; the script case is a component identifier used as a value.
 */
function collectEscapedComponents(
  sfc: ParsedSfc,
  imports: Map<string, ComponentId>,
  importedLocals: Set<string>,
): Set<ComponentId> {
  const escaped = new Set<ComponentId>();
  const flag = (name: string | undefined) => {
    if (!name) return;
    const childId = imports.get(name);
    if (childId) escaped.add(childId);
  };

  // Template: `:is="X"` / `is="X"` on any element.
  walkTemplate(sfc.template, (node) => {
    if (node.type !== VueNode.ELEMENT) return;
    for (const p of node.props ?? []) {
      if (p.type === VueNode.DIRECTIVE && p.name === 'bind' && exprContentArg(p.arg) === 'is') {
        const ast = parseExpr(exprContent(p.exp));
        if (ast?.type === 'Identifier') flag(ast.name);
      }
    }
  });

  // Script: a component identifier used as a runtime value.
  const ss = sfc.scriptSetup;
  if (ss) {
    walkBabel(ss.ast, (node, parent) => {
      if (
        node.type === 'Identifier' &&
        node.name &&
        imports.has(node.name) &&
        importedLocals.has(node.name) &&
        isValueUse(node, parent) &&
        !isImportSpecifierPosition(parent)
      ) {
        flag(node.name);
      }
    });
  }
  return escaped;
}

function isValueUse(node: AnyNode, parent: AnyNode | null): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
    return false;
  if (
    (parent.type === 'ObjectProperty' || parent.type === 'Property') &&
    parent.key === node &&
    !parent.computed &&
    parent.shorthand !== true
  )
    return false;
  if (isImportSpecifierPosition(parent)) return false;
  return true;
}

function isImportSpecifierPosition(parent: AnyNode | null): boolean {
  return (
    parent != null &&
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier' ||
      parent.type === 'ExportSpecifier')
  );
}

/** Every `<Child .../>` this component renders, paired with its resolved id. */
function collectChildCalls(
  template: AnyNode | undefined,
  imports: Map<string, ComponentId>,
): ChildCall[] {
  const calls: ChildCall[] = [];
  walkTemplate(template, (node) => {
    if (isComponentNode(node) && node.tag) {
      const childId = imports.get(node.tag);
      if (childId) calls.push({ childId, node });
    }
  });
  return calls;
}

function collectRenderedComponents(
  template: AnyNode | undefined,
  locals: Map<string, ComponentId>,
): Set<ComponentId> {
  const ids = new Set<ComponentId>();
  if (locals.size === 0) return ids;
  walkTemplate(template, (node) => {
    if (isComponentNode(node) && node.tag) {
      const childId = locals.get(node.tag);
      if (childId) ids.add(childId);
    }
  });
  return ids;
}

/** The `.content` of a SimpleExpressionNode that is also static (`arg`). */
function exprContentArg(arg: AnyNode | undefined): string | undefined {
  return exprContent(arg);
}

/**
 * Read one `<Child .../>` into a {@link CallSite}.  Props are in source order, so
 * last-write-wins; a `v-bind="obj"` spread (or dynamic `:[key]`) makes the site's
 * unset props Unknown (docs §4.1).
 */
export function readCallSite(component: AnyNode, _scriptBase: number): CallSite {
  const props = component.props ?? [];
  // A spread is `v-bind` with no arg, or a dynamic-key `:[k]` bind (any prop).
  let lastSpreadIndex = -1;
  for (let i = 0; i < props.length; i++) {
    const p = props[i]!;
    if (p.type === VueNode.DIRECTIVE && p.name === 'bind' && isSpreadBind(p)) lastSpreadIndex = i;
  }

  const explicit = new Map<string, ExplicitProp>();
  for (let i = 0; i < props.length; i++) {
    const p = props[i]!;
    const after = i > lastSpreadIndex;

    if (p.type === VueNode.ATTRIBUTE) {
      // Static attribute: `foo="lit"` or boolean `foo`.
      if (!p.name) continue;
      const value = staticAttrValue(p);
      explicit.set(p.name, { value, dynamic: false, afterLastSpread: after });
      continue;
    }
    if (p.type !== VueNode.DIRECTIVE) continue;

    if (p.name === 'bind') {
      if (isSpreadBind(p)) continue; // the spread itself, handled above
      const argName = exprContent(p.arg);
      if (!argName) continue; // dynamic key already counted as a spread
      const lit = evalExpr(exprContent(p.exp));
      explicit.set(
        argName,
        lit.known
          ? { value: lit.value, dynamic: false, afterLastSpread: after }
          : dynamicWrite(after),
      );
      continue;
    }
    if (p.name === 'model') {
      // `v-model` / `v-model:foo` is a used, dynamic two-way binding.
      const name = exprContent(p.arg) ?? 'modelValue';
      explicit.set(name, dynamicWrite(after));
      continue;
    }
    // `v-on` / `@`, `v-slot`, structural directives are not prop writes.
  }

  return { hadSpread: lastSpreadIndex >= 0, explicit };
}

/** A `v-bind` with no static arg sets an unknown prop (spread or dynamic key). */
function isSpreadBind(dir: AnyNode): boolean {
  return dir.arg == null || exprContent(dir.arg) == null;
}

function dynamicWrite(afterLastSpread: boolean): ExplicitProp {
  return { value: undefined, dynamic: true, afterLastSpread };
}

/** Static `Attribute` value: string content, or `true` for a boolean attr. */
function staticAttrValue(attr: AnyNode): Literal {
  const value = attr.value as AnyNode | undefined;
  if (!value) return true; // boolean shorthand: `<C disabled />` -> true
  return typeof value.content === 'string' ? value.content : '';
}

function evalExpr(content: string | undefined): { known: true; value: Literal } | { known: false } {
  const ast = parseExpr(content);
  if (!ast) return { known: false };
  return evaluate(ast, new Map());
}

export function isFoldBlockedName(model: FileModel, name: string): boolean {
  return model.shadowedNames.has(name);
}

function buildPlan(model: FileModel, u: Usage | undefined): ComponentPlan {
  const plan = emptyPlan(model.id);
  if (model.bailReasons.length > 0) {
    plan.bail = true;
    plan.reasons.push(...model.bailReasons);
    return plan;
  }
  if (!model.props || model.props.length === 0) return plan;
  const sites = u?.sites ?? [];
  if (sites.length === 0) return plan; // entry / unused: leave as-is

  for (const decl of model.props) {
    if (isFoldBlockedName(model, decl.name)) continue;
    const set = valueSetFor(decl, sites);
    plan.valueSets.set(decl.name, set);
    if (set.top || set.dynamic) continue;
    if (set.values.length === 1) {
      plan.constFold.set(decl.name, set.values[0]!);
      continue;
    }
    if (set.values.length >= 2) plan.narrow.set(decl.name, set.values);
  }
  return plan;
}

function valueSetFor(decl: PropDecl, sites: CallSite[]): PropValueSet {
  const values: Literal[] = [];
  let dynamic = false;
  let top = false;
  const add = (v: Literal) => {
    if (!values.some((x) => Object.is(x, v))) values.push(v);
  };

  for (const site of sites) {
    const explicit = site.explicit.get(decl.name);
    if (explicit?.afterLastSpread) {
      if (explicit.dynamic) dynamic = true;
      else add(explicit.value);
      continue;
    }
    if (site.hadSpread) {
      top = true;
      continue;
    }
    const def = literalDefault(decl.defaultExpr);
    if (def.known) add(def.value);
    else dynamic = true;
  }
  return { values, dynamic, top };
}

function literalDefault(
  expr: AnyNode | undefined,
): { known: true; value: Literal } | { known: false } {
  if (!expr) return { known: true, value: undefined };
  return evaluate(expr, new Map());
}

// ---- small AST helpers -------------------------------------------------

interface ImportInfo {
  value: string;
  local: string;
  imported: string;
}

function* importSources(program: AnyNode): Generator<ImportInfo> {
  const body = (program.body as AnyNode[] | undefined) ?? [];
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const value = (stmt.source as AnyNode | undefined)?.value;
    if (typeof value !== 'string') continue;
    for (const spec of stmt.specifiers ?? []) {
      const local = spec.local?.name;
      if (!local) continue;
      if (spec.type === 'ImportDefaultSpecifier') yield { value, local, imported: 'default' };
      else if (spec.type === 'ImportNamespaceSpecifier') yield { value, local, imported: '*' };
      else if (spec.type === 'ImportSpecifier')
        yield { value, local, imported: importedName(spec) ?? local };
    }
  }
}

function importedName(spec: AnyNode): string | undefined {
  const imported = spec.imported;
  if (imported?.type === 'Identifier' && imported.name) return imported.name;
  if (imported?.type === 'StringLiteral' && typeof imported.value === 'string')
    return imported.value;
  return undefined;
}

function specName(node: AnyNode | undefined): string | undefined {
  if (node?.type === 'Identifier' && node.name) return node.name;
  if (node?.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  return undefined;
}

/** Names of top-level compiler macros called in `<script setup>`. */
function macroCalls(program: AnyNode): Set<string> {
  const names = new Set<string>();
  walkBabel(program, (node) => {
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name)
      names.add(node.callee.name);
  });
  return names;
}

const MAX_BARREL_HOPS = 8;

async function resolveThroughBarrel(
  source: string,
  imported: string,
  importer: ComponentId,
  resolve: Resolve,
  readFile: ReadFile,
  hops = 0,
): Promise<ComponentId | null> {
  if (hops > MAX_BARREL_HOPS) return null;
  const targetId = await resolve(source, importer);
  if (!targetId) return null;

  if (isVue(source) || isVue(targetId)) {
    return imported === 'default' || imported === '*' ? targetId : null;
  }

  let code: string;
  try {
    code = await readFile(targetId);
  } catch {
    return null;
  }
  const body = parseModuleBody(code);
  if (!body) return null;

  for (const stmt of body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source?.value) {
      for (const spec of stmt.specifiers ?? []) {
        if (specName(spec.exported) !== imported) continue;
        return resolveThroughBarrel(
          String(stmt.source.value),
          specName(spec.local) ?? 'default',
          targetId,
          resolve,
          readFile,
          hops + 1,
        );
      }
      continue;
    }
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.source) {
      for (const spec of stmt.specifiers ?? []) {
        if (specName(spec.exported) !== imported) continue;
        const localName = specName(spec.local);
        if (!localName) continue;
        const found = followLocalImport(body, localName);
        if (!found) return null;
        return resolveThroughBarrel(
          found.value,
          found.imported,
          targetId,
          resolve,
          readFile,
          hops + 1,
        );
      }
      continue;
    }
    if (stmt.type === 'ExportAllDeclaration' && stmt.source?.value) {
      const via = await resolveThroughBarrel(
        String(stmt.source.value),
        imported,
        targetId,
        resolve,
        readFile,
        hops + 1,
      );
      if (via) return via;
    }
  }
  return null;
}

function followLocalImport(
  body: AnyNode[],
  localName: string,
): { value: string; imported: string } | null {
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const value = stmt.source?.value;
    if (typeof value !== 'string') continue;
    for (const spec of stmt.specifiers ?? []) {
      if (spec.local?.name !== localName) continue;
      if (spec.type === 'ImportDefaultSpecifier') return { value, imported: 'default' };
      if (spec.type === 'ImportNamespaceSpecifier') return { value, imported: '*' };
      if (spec.type === 'ImportSpecifier')
        return { value, imported: importedName(spec) ?? localName };
    }
  }
  return null;
}

/** Parse a `.js`/`.ts` barrel's top-level body with Babel. */
function parseModuleBody(code: string): AnyNode[] | null {
  try {
    const sfc = parseVue(`<script setup>\n${code}\n</script>`, 'barrel.vue');
    return (sfc.scriptSetup?.ast.body as AnyNode[] | undefined) ?? null;
  } catch {
    return null;
  }
}

interface FoundProps {
  declaration: AnyNode;
  pattern: AnyNode;
  definePropsCall: AnyNode | undefined;
  withDefaults: Map<string, AnyNode>;
  sharesStatement: boolean;
}

/**
 * Find `const { … } = defineProps(...)` or `const { … } = withDefaults(defineProps(...), {…})`.
 * Returns the destructure pattern, the `defineProps` call (for type-member edits),
 * and the `withDefaults` defaults map.
 */
function findPropsDeclaration(program: AnyNode): FoundProps | null {
  const body = (program.body as AnyNode[] | undefined) ?? [];
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of stmt.declarations ?? []) {
      const init = decl.init;
      const id = decl.id;
      if (id?.type !== 'ObjectPattern' || init?.type !== 'CallExpression') continue;
      const calleeName = init.callee?.type === 'Identifier' ? init.callee.name : undefined;

      if (calleeName === 'defineProps') {
        return {
          declaration: stmt,
          pattern: id,
          definePropsCall: init,
          withDefaults: new Map(),
          sharesStatement: (stmt.declarations?.length ?? 1) > 1,
        };
      }
      if (calleeName === 'withDefaults') {
        const inner = init.arguments?.[0];
        if (inner?.type !== 'CallExpression' || inner.callee?.type !== 'Identifier') continue;
        if (inner.callee.name !== 'defineProps') continue;
        return {
          declaration: stmt,
          pattern: id,
          definePropsCall: inner,
          withDefaults: defaultsFromObject(init.arguments?.[1]),
          sharesStatement: (stmt.declarations?.length ?? 1) > 1,
        };
      }
    }
  }
  return null;
}

/** Map of `{ name: defaultExpr }` from a `withDefaults` second-argument object. */
function defaultsFromObject(obj: AnyNode | undefined): Map<string, AnyNode> {
  const out = new Map<string, AnyNode>();
  if (obj?.type !== 'ObjectExpression') return out;
  for (const prop of obj.properties ?? []) {
    if (prop.type !== 'ObjectProperty') continue;
    const key = prop.key;
    const name = key?.type === 'Identifier' ? key.name : undefined;
    if (name && prop.value) out.set(name, prop.value as AnyNode);
  }
  return out;
}
