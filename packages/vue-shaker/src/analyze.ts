import {
  exprContent,
  parseExpr,
  parseCached,
  parseModuleProgram,
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
  /** Declared props, or `null` if the component has no `defineProps`. */
  props: PropDecl[] | null;
  /** The `const { … } = defineProps()` declarator's ObjectPattern, for editing. */
  propsPattern?: AnyNode | undefined;
  /**
   * The local name when props are NOT destructured (`const props =
   * defineProps()` → `'props'`), so script reads `props.X` can be evaluated.
   * Undefined for the destructured form (refs are then bare names).
   */
  propsLocal?: string | undefined;
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
const NAMESPACE_LEAK_REASON =
  'reached through a namespace object that also leaks as a value (call sites unobservable)';
const SCRIPT_BASE_DEFAULT = 0;

/** The absolute SFC base offset of a model's `<script setup>` (0 if none). */
function scriptBase(model: FileModel): number {
  return model.sfc.scriptSetup?.base ?? SCRIPT_BASE_DEFAULT;
}

export async function analyze(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  escapeScanFiles?: ComponentId[],
): Promise<AnalyzeResult> {
  return analyzeInput(
    await buildAnalyzeInput(entries, resolve, readFile, undefined, escapeScanFiles),
  );
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

  // Forced bail (docs §4.1): the Shell proved a component's call sites are not
  // fully enumerable during resolution (a leaking namespace object), so folding
  // on the sites we DID see would be unsound.
  for (const id of input.forcedBails ?? []) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(NAMESPACE_LEAK_REASON))
      model.bailReasons.push(NAMESPACE_LEAK_REASON);
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
  escapeScanFiles?: ComponentId[],
): Promise<AnalyzeInput> {
  const entryList = Array.isArray(entries) ? [...entries] : [entries];
  const files: InputFile[] = [];
  const edges: ResolvedEdge[] = [];
  const forcedBails = new Set<ComponentId>();
  // Parse a namespace barrel (`@flyle/design-system-vue`) at most once per
  // (module, export) across the whole crawl — many files import the same object.
  const nsCache = new Map<string, NamespaceTree | null>();
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
    const program = sfc.scriptSetup.ast;

    const imports = [...importSources(program)];
    const importByLocal = new Map<string, ImportInfo>();
    for (const imp of imports) importByLocal.set(imp.local, imp);

    const barrelLocals = new Map<string, ComponentId>();
    const enqueue: ComponentId[] = [];
    for (const imp of imports) {
      if (imp.imported === 'default' && isVue(imp.value)) {
        const childId = await resolve(imp.value, id);
        if (childId) {
          edges.push({ from: id, local: imp.local, to: childId, kind: 'default-vue' });
          enqueue.push(childId);
        }
        continue;
      }
      const childId = await resolveThroughBarrel(imp.value, imp.imported, id, resolve, readFile);
      if (childId) {
        edges.push({ from: id, local: imp.local, to: childId, kind: 'barrel' });
        barrelLocals.set(imp.local, childId);
      }
    }

    // Namespace-object pattern (docs §4.3): `import { NS } from 'pkg'; const { A,
    // group: { B } } = NS;` then `<A/> <B/>`.  Resolve each destructured leaf to
    // its `.vue` so the components fold like a plain default import — but only
    // when `NS` does not ALSO leak as a runtime value (then its call sites are
    // not enumerable and every component it exposes must bail).
    for (const [nsLocal, ns] of collectNamespaceDestructures(program)) {
      const imp = importByLocal.get(nsLocal);
      if (!imp) continue;
      const tree = await namespaceTreeCached(
        imp.value,
        imp.imported,
        id,
        resolve,
        readFile,
        nsCache,
      );
      if (!tree) continue;
      const leaks =
        ns.unsafe ||
        namespaceLocalLeaks(program, nsLocal, ns.initNodes) ||
        namespaceUsedInTemplateIs(sfc.template, nsLocal);
      if (leaks) {
        for (const compId of flattenNamespaceTree(tree)) forcedBails.add(compId);
        continue;
      }
      for (const binding of ns.bindings) {
        const childId = lookupNamespaceMember(tree, binding.path);
        if (!childId) continue;
        edges.push({ from: id, local: binding.local, to: childId, kind: 'namespace' });
        enqueue.push(childId);
      }
    }

    const rendered = collectRenderedComponents(sfc.template, barrelLocals);
    for (const childId of [...enqueue, ...rendered]) {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    }
  }

  // A `.vue` instantiated programmatically from a `.ts`/`.js` file
  // (`createApp(Dialog, props)`, `h(Dialog, props)`) has call sites no template
  // enumerates, so its props could be anything — bail it (docs §4.1).  Scanned in
  // parallel; the `.includes('.vue')` fast-path skips files that import none.
  const escapeLists = await Promise.all(
    (escapeScanFiles ?? []).map((file) => collectScriptEscapes(file, resolve, readFile)),
  );
  for (const list of escapeLists) for (const id of list) forcedBails.add(id);

  return { files, edges, entries: entryList, forcedBails: [...forcedBails] };
}

/**
 * Components a non-`.vue` module imports and uses as a runtime VALUE — i.e. the
 * default/namespace `.vue` import is referenced outside type positions and the
 * import statement (e.g. `createApp(Dialog)`, `h(Dialog)`, stored in a config).
 * Such use passes props the engine cannot see, so the component must bail.
 */
async function collectScriptEscapes(
  file: ComponentId,
  resolve: Resolve,
  readFile: ReadFile,
): Promise<ComponentId[]> {
  let code: string;
  try {
    code = await readFile(file);
  } catch {
    return [];
  }
  if (!code.includes('.vue')) return []; // fast path: cannot import a `.vue`
  const program = parseModuleProgram(code);
  if (!program) return [];

  const vueLocals = new Map<string, string>(); // local name -> `.vue` source spec
  for (const stmt of (program.body as AnyNode[] | undefined) ?? []) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const source = (stmt.source as AnyNode | undefined)?.value;
    if (typeof source !== 'string' || !isVue(source)) continue;
    for (const spec of stmt.specifiers ?? []) {
      if (
        (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') &&
        spec.local?.name
      )
        vueLocals.set(spec.local.name, source);
    }
  }
  if (vueLocals.size === 0) return [];

  // A `.vue` imported ONLY to be bundled into an exported object as a shorthand
  // property (`const Reg = { Modal }`) is the namespace pattern we already resolve
  // soundly via the consumer's destructure — not a programmatic instantiation, so
  // it must not bail.  A dangerous use (`createApp(Modal)`, `{ component: Modal }`)
  // is NOT a shorthand property and is still flagged.
  const shorthand = collectShorthandPropNodes(program);
  const used = new Set<string>();
  forEachValueIdentifier(program, (name, node) => {
    if (vueLocals.has(name) && !shorthand.has(node)) used.add(name);
  });
  const ids = await Promise.all([...used].map((name) => resolve(vueLocals.get(name)!, file)));
  return ids.filter((id): id is ComponentId => id != null);
}

/** Key + value nodes of every shorthand object-literal property (`{ X }`). */
function collectShorthandPropNodes(program: AnyNode): Set<AnyNode> {
  const out = new Set<AnyNode>();
  walkBabel(program, (node) => {
    if (node.type !== 'ObjectExpression') return;
    for (const prop of node.properties ?? []) {
      if ((prop.type === 'ObjectProperty' || prop.type === 'Property') && prop.shorthand) {
        if (prop.key) out.add(prop.key);
        if (prop.value) out.add(prop.value as AnyNode);
      }
    }
  });
  return out;
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
  const namespaceLocals = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'default-vue') imports.set(edge.local, edge.to);
    else if (edge.kind === 'namespace') {
      imports.set(edge.local, edge.to);
      namespaceLocals.add(edge.local);
    } else barrelLocals.set(edge.local, edge.to);
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
  let propsLocal: string | undefined;
  let propsDeclaration: AnyNode | undefined;
  let definePropsCall: AnyNode | undefined;
  let hasRestProp = false;
  let sharesStatement = false;
  const importedLocals = new Set<string>();

  if (sfc.scriptSetup) {
    for (const imp of importSources(sfc.scriptSetup.ast)) importedLocals.add(imp.local);
    // Namespace-destructured component locals (`const { C } = NS`) are component
    // references too — scan them for escapes (their binding site is excluded
    // inside collectEscapedComponents, the same way import specifiers are).
    for (const local of namespaceLocals) importedLocals.add(local);

    const found = findPropsDeclaration(sfc.scriptSetup.ast);
    if (found) {
      propsDeclaration = found.declaration;
      propsPattern = found.pattern;
      propsLocal = found.propsLocal;
      definePropsCall = found.definePropsCall;
      sharesStatement = found.sharesStatement;
      if (found.sharesStatement)
        bailReasons.push('defineProps() shares a multi-declarator statement');
      if (found.pattern) {
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
      } else {
        props = propsFromTypeMembers(found.definePropsCall, found.withDefaults);
      }
    }
  }

  const childCalls = collectChildCalls(sfc.template, imports);
  const barrelChildIds = collectRenderedComponents(sfc.template, barrelLocals);
  const shadowedNames = collectTemplateBindings(sfc);
  // A prop whose name collides with an imported binding must not be folded: the
  // destructured-form demote emits `const <name> = <value>`, which would redeclare
  // the import (`Identifier '<name>' has already been declared`).  Treat imports
  // as shadowing names so such props are left alone.
  for (const local of importedLocals) shadowedNames.add(local);
  const escapedComponents = collectEscapedComponents(sfc, imports, importedLocals);

  return {
    id,
    code,
    sfc,
    imports,
    props,
    propsPattern,
    propsLocal,
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
        // `<component :is="Comp.Sub">` — the ROOT identifier is the component
        // used as a value; flag it so a member-access `:is` is not a blind spot.
        else if (ast?.type === 'MemberExpression') flag(memberRootName(ast));
      }
    }
  });

  // Script: a component identifier used as a runtime value.
  const ss = sfc.scriptSetup;
  if (ss) {
    // Identifiers that DECLARE a binding (import specifiers, destructure
    // patterns, params) are not value reads — excluding them lets a
    // namespace-destructured component (`const { C } = NS`) be folded while a
    // genuine value use of `C` elsewhere still escapes.
    const bindingNodes = collectBindingIdentifierNodes(ss.ast);
    walkBabel(ss.ast, (node, parent) => {
      if (
        node.type === 'Identifier' &&
        node.name &&
        imports.has(node.name) &&
        importedLocals.has(node.name) &&
        isValueUse(node, parent) &&
        !isImportSpecifierPosition(parent) &&
        !bindingNodes.has(node)
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

// ----------------------------------------------------------------------
// Namespace-object component resolution (docs §4.3).
//
// A design system often ships its components as ONE object — e.g.
//   // index.ts
//   import FuiButton from './button/FuiButton.vue';
//   const FuiComponents = { FuiText, button: { FuiButton } };
//   export { FuiComponents };
// and an app destructures off it:
//   import { FuiComponents } from '@flyle/design-system-vue';
//   const { FuiText, button: { FuiButton } } = FuiComponents;
//   // <FuiText/> <FuiButton/>
// Each leaf maps deterministically to one `.vue`, so the call sites ARE
// enumerable and the components fold exactly like a default import — provided
// the namespace object is not ALSO used as a runtime value (see the leak guard).
// ----------------------------------------------------------------------

/** A resolved namespace object: member name -> `.vue` id, or a nested sub-tree. */
type NamespaceTree = Map<string, ComponentId | NamespaceTree>;

/** One leaf binding of a `const { … } = NS` destructure: `path` into the tree. */
interface NamespaceBinding {
  path: string[];
  local: string;
}

/** Everything one file destructures off a single namespace local. */
interface NamespaceDestructure {
  /** Every `= NS` init identifier node (for the leak guard's allow-set). */
  initNodes: Set<AnyNode>;
  bindings: NamespaceBinding[];
  /** A rest element / default / computed key — the shape we cannot follow soundly. */
  unsafe: boolean;
}

/** Find every `const <ObjectPattern> = <Identifier>` in a script, by RHS local. */
function collectNamespaceDestructures(program: AnyNode): Map<string, NamespaceDestructure> {
  const out = new Map<string, NamespaceDestructure>();
  walkBabel(program, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const init = node.init;
    const idPat = node.id;
    if (init?.type !== 'Identifier' || !init.name || idPat?.type !== 'ObjectPattern') return;
    let entry = out.get(init.name);
    if (!entry) {
      entry = { initNodes: new Set(), bindings: [], unsafe: false };
      out.set(init.name, entry);
    }
    entry.initNodes.add(init);
    collectPatternBindings(idPat, [], entry);
  });
  return out;
}

function collectPatternBindings(
  pattern: AnyNode,
  path: string[],
  entry: NamespaceDestructure,
): void {
  for (const prop of pattern.properties ?? []) {
    if (prop.type === 'RestElement') {
      entry.unsafe = true; // `...rest` captures every other member as a value
      continue;
    }
    if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
    if (prop.computed) {
      entry.unsafe = true;
      continue;
    }
    const keyName = staticKeyName(prop.key);
    if (!keyName) {
      entry.unsafe = true;
      continue;
    }
    const value = (prop.value as AnyNode | undefined) ?? undefined;
    if (value?.type === 'Identifier' && value.name) {
      entry.bindings.push({ path: [...path, keyName], local: value.name });
    } else if (value?.type === 'ObjectPattern') {
      collectPatternBindings(value, [...path, keyName], entry);
    } else {
      // AssignmentPattern (default) / ArrayPattern — a member that might be absent
      // or reshaped; folding from observed tags would be unsound, so bail safely.
      entry.unsafe = true;
    }
  }
}

function staticKeyName(key: AnyNode | undefined): string | undefined {
  if (key?.type === 'Identifier' && key.name) return key.name;
  if (key?.type === 'StringLiteral' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** Resolve (and cache) the namespace object `imported` exports from `source`. */
async function namespaceTreeCached(
  source: string,
  imported: string,
  importer: ComponentId,
  resolve: Resolve,
  readFile: ReadFile,
  cache: Map<string, NamespaceTree | null>,
): Promise<NamespaceTree | null> {
  const moduleId = await resolve(source, importer);
  if (!moduleId) return null;
  const key = `${moduleId} ${imported}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const tree = await buildNamespaceTree(moduleId, imported, resolve, readFile);
  cache.set(key, tree);
  return tree;
}

/** Parse the module and turn the exported object literal into a {@link NamespaceTree}. */
async function buildNamespaceTree(
  moduleId: ComponentId,
  exportName: string,
  resolve: Resolve,
  readFile: ReadFile,
): Promise<NamespaceTree | null> {
  let code: string;
  try {
    code = await readFile(moduleId);
  } catch {
    return null;
  }
  const body = parseModuleBody(code);
  if (!body) return null;

  // Module-local imports: `import X from './X.vue'` is a foldable leaf source.
  const localImport = new Map<string, { value: string; imported: string }>();
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const value = (stmt.source as AnyNode | undefined)?.value;
    if (typeof value !== 'string') continue;
    for (const spec of stmt.specifiers ?? []) {
      const local = spec.local?.name;
      if (!local) continue;
      if (spec.type === 'ImportDefaultSpecifier')
        localImport.set(local, { value, imported: 'default' });
      else if (spec.type === 'ImportSpecifier')
        localImport.set(local, { value, imported: importedName(spec) ?? local });
    }
  }

  const objectExpr = findExportedObject(body, exportName);
  if (!objectExpr) return null;
  return buildTreeFromObject(objectExpr, moduleId, localImport, resolve);
}

/** The `ObjectExpression` a module exports under `name` (local or `export const`). */
function findExportedObject(body: AnyNode[], name: string): AnyNode | null {
  for (const stmt of body) {
    if (
      stmt.type === 'ExportNamedDeclaration' &&
      stmt.declaration?.type === 'VariableDeclaration'
    ) {
      const obj = objectFromDeclaration(stmt.declaration, name);
      if (obj) return obj;
    }
    if (stmt.type === 'VariableDeclaration') {
      const obj = objectFromDeclaration(stmt, name);
      if (obj) return obj;
    }
    if (
      stmt.type === 'ExportDefaultDeclaration' &&
      name === 'default' &&
      stmt.declaration?.type === 'ObjectExpression'
    ) {
      return stmt.declaration;
    }
  }
  return null;
}

function objectFromDeclaration(decl: AnyNode, name: string): AnyNode | null {
  for (const d of decl.declarations ?? []) {
    if (d.id?.type === 'Identifier' && d.id.name === name && d.init?.type === 'ObjectExpression')
      return d.init;
  }
  return null;
}

async function buildTreeFromObject(
  obj: AnyNode,
  moduleId: ComponentId,
  localImport: Map<string, { value: string; imported: string }>,
  resolve: Resolve,
): Promise<NamespaceTree> {
  const tree: NamespaceTree = new Map();
  // Resolve every member in parallel — one tree is built once per barrel, but a
  // sequential `await resolve` per member would still be a needless N+1.
  const entries = await Promise.all(
    (obj.properties ?? []).map(
      async (prop): Promise<[string, ComponentId | NamespaceTree] | null> => {
        if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') return null;
        if (prop.computed) return null;
        const keyName = staticKeyName(prop.key);
        if (!keyName) return null;
        const value = prop.value as AnyNode | undefined;
        if (value?.type === 'Identifier' && value.name) {
          const imp = localImport.get(value.name);
          if (!imp || imp.imported !== 'default' || !isVue(imp.value)) return null;
          const compId = await resolve(imp.value, moduleId);
          return compId ? [keyName, compId] : null;
        }
        if (value?.type === 'ObjectExpression') {
          return [keyName, await buildTreeFromObject(value, moduleId, localImport, resolve)];
        }
        return null;
      },
    ),
  );
  for (const e of entries) if (e) tree.set(e[0], e[1]);
  return tree;
}

/** Walk a member path into the tree; null unless it ends on a concrete `.vue` id. */
function lookupNamespaceMember(tree: NamespaceTree, path: string[]): ComponentId | null {
  let cur: ComponentId | NamespaceTree = tree;
  for (const key of path) {
    if (typeof cur === 'string') return null;
    const next = cur.get(key);
    if (next === undefined) return null;
    cur = next;
  }
  return typeof cur === 'string' ? cur : null;
}

/** Every `.vue` id reachable in the tree (used to bail a leaking namespace). */
function flattenNamespaceTree(tree: NamespaceTree): ComponentId[] {
  const out: ComponentId[] = [];
  for (const v of tree.values()) {
    if (typeof v === 'string') out.push(v);
    else out.push(...flattenNamespaceTree(v));
  }
  return out;
}

/** Type-only AST fields: `typeof NS` inside them is erased, never a runtime read. */
const TYPE_ONLY_KEYS = new Set(['typeAnnotation', 'typeParameters', 'returnType', 'typeArguments']);

/**
 * True when the namespace local is used as a RUNTIME VALUE anywhere other than
 * the `= NS` destructure inits we already followed.  Such a use (e.g. passing
 * `NS` to a function, `NS.x.y` in an expression) can reach components through
 * sites we cannot enumerate, so the whole object must bail.  Import bindings and
 * type positions (`typeof NS`) are erased/not value reads and are skipped.
 */
function namespaceLocalLeaks(program: AnyNode, nsLocal: string, initNodes: Set<AnyNode>): boolean {
  let leak = false;
  forEachValueIdentifier(program, (name, node) => {
    if (name === nsLocal && !initNodes.has(node)) leak = true;
  });
  return leak;
}

/**
 * Visit every identifier in a RUNTIME VALUE position: skips import declarations
 * (bindings) and type-only AST fields (`typeof X` in a type is erased).  Over-
 * approximates — member-property and object-key identifiers are visited too —
 * which only ever causes a (sound) extra bail, never a missed escape.
 */
function forEachValueIdentifier(
  node: AnyNode | null | undefined,
  fn: (name: string, node: AnyNode) => void,
): void {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  if (node.type === 'ImportDeclaration') return;
  if (node.type === 'Identifier') {
    if (node.name) fn(node.name, node);
    return;
  }
  for (const [key, v] of Object.entries(node)) {
    if (TYPE_ONLY_KEYS.has(key)) continue;
    if (Array.isArray(v)) for (const it of v) forEachValueIdentifier(it as AnyNode, fn);
    else if (v && typeof v === 'object' && typeof (v as AnyNode).type === 'string')
      forEachValueIdentifier(v as AnyNode, fn);
  }
}

/**
 * Every identifier node that DECLARES a binding (import specifier, destructure
 * pattern, function parameter) rather than reading a value.  Used to exclude the
 * `const { C } = NS` binding site from escape detection, just as import
 * specifiers are excluded — a real value use of `C` elsewhere still escapes.
 */
function collectBindingIdentifierNodes(program: AnyNode): Set<AnyNode> {
  const out = new Set<AnyNode>();
  walkBabel(program, (node) => {
    if (node.type === 'VariableDeclarator') addPatternIdentifierNodes(node.id, out);
    else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod'
    ) {
      for (const p of node.params ?? []) addPatternIdentifierNodes(p, out);
    } else if (
      node.type === 'ImportDefaultSpecifier' ||
      node.type === 'ImportSpecifier' ||
      node.type === 'ImportNamespaceSpecifier'
    ) {
      if (node.local) out.add(node.local);
    }
  });
  return out;
}

function addPatternIdentifierNodes(pattern: AnyNode | null | undefined, out: Set<AnyNode>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern);
      return;
    case 'ObjectPattern':
      for (const prop of pattern.properties ?? []) {
        if (prop.type === 'RestElement') {
          addPatternIdentifierNodes(prop.argument, out);
        } else if (prop.type === 'ObjectProperty' || prop.type === 'Property') {
          addPatternIdentifierNodes((prop.value as AnyNode) ?? prop.key, out);
          // A shorthand `{ Foo }` binding emits a DISTINCT key node (same name,
          // same range) the walk visits separately; exclude it too or it reads
          // as a value use and escapes.
          if (prop.shorthand && prop.key) out.add(prop.key);
        }
      }
      return;
    case 'ArrayPattern':
      for (const el of pattern.elements ?? []) addPatternIdentifierNodes(el, out);
      return;
    case 'AssignmentPattern':
      addPatternIdentifierNodes(pattern.left, out);
      return;
    case 'RestElement':
      addPatternIdentifierNodes(pattern.argument, out);
      return;
    default:
      return;
  }
}

/** The `.content` of a SimpleExpressionNode that is also static (`arg`). */
function exprContentArg(arg: AnyNode | undefined): string | undefined {
  return exprContent(arg);
}

/** Root object identifier of a (possibly nested) member expression, if any. */
function memberRootName(node: AnyNode | undefined): string | undefined {
  let cur = node;
  while (cur?.type === 'MemberExpression') cur = cur.object;
  return cur?.type === 'Identifier' ? cur.name : undefined;
}

/** True if a `<component :is>` renders through the namespace local (`NS.a.B`). */
function namespaceUsedInTemplateIs(template: AnyNode | undefined, nsLocal: string): boolean {
  let found = false;
  walkTemplate(template, (node) => {
    if (node.type !== VueNode.ELEMENT) return;
    for (const p of node.props ?? []) {
      if (p.type !== VueNode.DIRECTIVE || p.name !== 'bind' || exprContentArg(p.arg) !== 'is')
        continue;
      const ast = parseExpr(exprContent(p.exp));
      if (ast?.type === 'Identifier' ? ast.name === nsLocal : memberRootName(ast) === nsLocal)
        found = true;
    }
  });
  return found;
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
  /** The destructure ObjectPattern, or undefined for `const props = defineProps()`. */
  pattern: AnyNode | undefined;
  /** The props local name (`props`) for the non-destructured form, else undefined. */
  propsLocal: string | undefined;
  definePropsCall: AnyNode | undefined;
  withDefaults: Map<string, AnyNode>;
  sharesStatement: boolean;
}

/**
 * Find the `defineProps` declaration in either supported form:
 *   - destructured:     `const { … } = defineProps(...)` / `withDefaults(...)`
 *   - non-destructured: `const props = defineProps<{…}>()` / `withDefaults(...)`
 * Returns the pattern (destructured) or the props local name (non-destructured),
 * the `defineProps` call (for type-member edits) and the `withDefaults` defaults.
 */
function findPropsDeclaration(program: AnyNode): FoundProps | null {
  const body = (program.body as AnyNode[] | undefined) ?? [];
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of stmt.declarations ?? []) {
      const extracted = extractDefineProps(decl.init);
      if (!extracted) continue;
      const id = decl.id;
      const sharesStatement = (stmt.declarations?.length ?? 1) > 1;
      if (id?.type === 'ObjectPattern') {
        return {
          declaration: stmt,
          pattern: id,
          propsLocal: undefined,
          sharesStatement,
          ...extracted,
        };
      }
      if (id?.type === 'Identifier' && id.name) {
        return {
          declaration: stmt,
          pattern: undefined,
          propsLocal: id.name,
          sharesStatement,
          ...extracted,
        };
      }
    }
  }
  return null;
}

/** Pull the `defineProps` call + `withDefaults` map out of a declarator init. */
function extractDefineProps(
  init: AnyNode | null | undefined,
): { definePropsCall: AnyNode; withDefaults: Map<string, AnyNode> } | null {
  if (init?.type !== 'CallExpression') return null;
  const calleeName = init.callee?.type === 'Identifier' ? init.callee.name : undefined;
  if (calleeName === 'defineProps') return { definePropsCall: init, withDefaults: new Map() };
  if (calleeName === 'withDefaults') {
    const inner = init.arguments?.[0];
    if (
      inner?.type !== 'CallExpression' ||
      inner.callee?.type !== 'Identifier' ||
      inner.callee.name !== 'defineProps'
    )
      return null;
    return { definePropsCall: inner, withDefaults: defaultsFromObject(init.arguments?.[1]) };
  }
  return null;
}

/**
 * Declared props of a non-destructured `defineProps<{…}>()`: names come from the
 * type literal's members, defaults from the `withDefaults` map.  `property` is the
 * type member node (only the destructured path edits the signature, so it is
 * never used to remove a pattern entry here).
 */
function propsFromTypeMembers(
  definePropsCall: AnyNode | undefined,
  withDefaults: Map<string, AnyNode>,
): PropDecl[] {
  const out: PropDecl[] = [];
  const typeArg = definePropsCall?.typeParameters?.params?.[0];
  for (const m of typeArg?.members ?? []) {
    const key = m.key;
    if (key?.type !== 'Identifier' || !key.name) continue;
    out.push({ name: key.name, property: m, defaultExpr: withDefaults.get(key.name) });
  }
  return out;
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
