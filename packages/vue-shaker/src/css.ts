// ----------------------------------------------------------------------
// CSS rule removal (docs/ARCHITECTURE.md §3 "L1.5", "CSS (shaker 独自の価値)").
//
// Drop `<style scoped>` rules that target a class the component can PROVABLY
// never produce, given the value sets we computed.  Unlike Svelte, Vue does NOT
// prune unused CSS at all, so vue-shaker OWNS this removal entirely — the
// differentiator is even stronger here.
//
// SOUNDNESS: a rule is removed ONLY when the component's set of possible class
// names is BOUNDED (every class source enumerable), the rule uses no
// `:deep()`/`:global()`/`:slotted()` (which reach outside this component's
// scope), and EVERY selector in the rule requires a class NOT in that set.  Only
// `scoped` blocks are touched — a global `<style>` may match elements elsewhere.
// ----------------------------------------------------------------------

import type MagicString from 'magic-string';
import { parse as postcssParse, type ChildNode, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { exprContent, parseExpr, VueNode, walkTemplate, type AnyNode } from './parse';
import type { ComponentPlan, Literal } from './ir';
import type { FileModel } from './analyze';
import { evaluate, propsMemberName } from './eval';

export interface PossibleClasses {
  classes: Set<string>;
  unbounded: boolean;
}

/** Cap on the cartesian product of interpolated parts; over it -> unbounded. */
const MAX_CLASS_COMBOS = 64;

/** Sentinel: this class source cannot be enumerated. */
const UNBOUNDED = Symbol('unbounded-class-source');
type StrResult = Set<string> | typeof UNBOUNDED;

/**
 * Everything the class-set analysis needs to evaluate an expression: the value
 * environments, the non-destructured props local (so `props.size` reads like the
 * bare prop), and a resolver from a script-local identifier (`:class="classes"`)
 * to its definition's class-producing expressions.
 */
interface ClassCtx {
  env: Map<string, Literal>;
  setEnv: Map<string, Literal[]>;
  propsLocal: string | undefined;
  /** `:class="classes"` -> the expressions a `const classes = …` can yield. */
  resolveClassExpr: (name: string) => AnyNode[] | null;
}

/**
 * Compute the component's possible class set (docs §3, step 1).  Sources: static
 * `class="a b"`, `:class` with foldable/narrowable expressions, object/array
 * `:class` syntaxes (object keys are always-possible classes), and — crucially
 * for design systems — `:class="someComputed"` where the classes are built in the
 * script from `props.X` (e.g. `\`fui-button-pattern-${props.pattern}\``).  Any
 * spread or non-enumerable source makes the set unbounded (and CSS shaking bails).
 */
export function computePossibleClasses(model: FileModel, plan: ComponentPlan): PossibleClasses {
  const classes = new Set<string>();
  let unbounded = false;
  const ctx: ClassCtx = {
    env: plan.constFold,
    setEnv: plan.narrow,
    propsLocal: model.propsLocal,
    resolveClassExpr: makeClassExprResolver(model),
  };

  walkTemplate(model.sfc.template, (node) => {
    if (node.type !== VueNode.ELEMENT) return;

    // `<Transition name="x">` adds `x-enter-active` … at RUNTIME (never via
    // `:class`), so those classes must count as possible or we would strip a live
    // animation's CSS (the SSR oracle can't see it — transitions don't run on the
    // server).  A dynamic name/override makes the set unenumerable.
    if (isTransitionTag(node.tag) && !addTransitionClasses(node, classes)) unbounded = true;

    for (const p of node.props ?? []) {
      // A CUSTOM directive (anything but the built-ins) may add classes to the
      // element at runtime (e.g. a tooltip directive); we cannot see those, so the
      // class set is no longer enumerable for this component.
      if (p.type === VueNode.DIRECTIVE && p.name && !BUILTIN_DIRECTIVES.has(p.name)) {
        unbounded = true;
        continue;
      }
      if (p.type === VueNode.ATTRIBUTE) {
        if (p.name === 'class') {
          const value = p.value as AnyNode | undefined;
          const text = typeof value?.content === 'string' ? value.content : '';
          for (const tok of text.split(/\s+/)) if (tok) classes.add(tok);
        }
        continue;
      }
      if (p.type !== VueNode.DIRECTIVE || p.name !== 'bind') continue;
      const argName = exprContent(p.arg);
      // A spread (`v-bind="obj"`) or dynamic key (`:[k]`) could carry `class`.
      if (p.arg == null || argName == null) {
        unbounded = true;
        continue;
      }
      if (argName !== 'class') continue;
      const ast = parseExpr(exprContent(p.exp));
      const result = classTokensOf(ast, ctx);
      if (result === UNBOUNDED) unbounded = true;
      else for (const c of result) classes.add(c);
    }
  });

  // The script can add classes imperatively (`el.classList.add('x')`,
  // `el.className = …`); we don't trace those, so bail rather than risk removing a
  // rule they target.
  if (scriptTouchesClassList(model)) unbounded = true;

  return { classes, unbounded };
}

/** Directive names that never add classes the way a custom directive might. */
const BUILTIN_DIRECTIVES = new Set([
  'if',
  'else',
  'else-if',
  'for',
  'bind',
  'on',
  'model',
  'show',
  'slot',
  'html',
  'text',
  'once',
  'memo',
  'cloak',
  'pre',
]);

function isTransitionTag(tag: string | undefined): boolean {
  if (!tag) return false;
  const norm = tag.toLowerCase().replace(/-/g, '');
  return norm === 'transition' || norm === 'transitiongroup';
}

/** Transition phase classes Vue derives from a base `name` (enter/leave/appear). */
const TRANSITION_SUFFIXES = [
  'enter-from',
  'enter-active',
  'enter-to',
  'leave-from',
  'leave-active',
  'leave-to',
  'appear-from',
  'appear-active',
  'appear-to',
];

/**
 * Add the classes a `<Transition>` / `<TransitionGroup>` can produce to `out`.
 * Returns false (caller bails the component's CSS) when the name or any
 * `*-class` override is dynamic, so the produced classes cannot be enumerated.
 */
function addTransitionClasses(node: AnyNode, out: Set<string>): boolean {
  let base = 'v'; // Vue's default transition name
  const isGroup = (node.tag ?? '').toLowerCase().replace(/-/g, '') === 'transitiongroup';
  for (const p of node.props ?? []) {
    if (p.type === VueNode.ATTRIBUTE) {
      if (p.name === 'name') {
        const value = p.value as AnyNode | undefined;
        if (typeof value?.content === 'string') base = value.content;
      } else if (p.name && p.name.endsWith('-class')) {
        const value = p.value as AnyNode | undefined;
        const text = typeof value?.content === 'string' ? value.content : '';
        for (const tok of text.split(/\s+/)) if (tok) out.add(tok);
      }
      continue;
    }
    if (p.type === VueNode.DIRECTIVE && p.name === 'bind') {
      const arg = exprContent(p.arg);
      // `:name` or any `:*-class` override is dynamic -> classes unenumerable.
      if (arg == null || arg === 'name' || arg.endsWith('Class') || arg.endsWith('-class'))
        return false;
    }
  }
  for (const suffix of TRANSITION_SUFFIXES) out.add(`${base}-${suffix}`);
  if (isGroup) out.add(`${base}-move`);
  return true;
}

/** True if the script manipulates classes imperatively (so we can't enumerate). */
function scriptTouchesClassList(model: FileModel): boolean {
  const content = model.sfc.scriptSetup?.content;
  if (!content) return false;
  return /\.classList\b|\.className\b|setAttribute\(\s*['"`]class/.test(content);
}

/** Tokens contributed by one class VALUE node (string / array / object / ref). */
function classTokensOf(node: AnyNode | null | undefined, ctx: ClassCtx): StrResult {
  if (!node) return UNBOUNDED;

  if (node.type === 'ObjectExpression') {
    // `{ active: cond, 'btn-danger': … }` — each KEY is a possible class.
    const out = new Set<string>();
    for (const prop of node.properties ?? []) {
      if (prop.type !== 'ObjectProperty') return UNBOUNDED; // spread inside object
      const key = prop.key;
      const name =
        key?.type === 'Identifier'
          ? key.name
          : key?.type === 'StringLiteral'
            ? (key.value as string)
            : undefined;
      if (name == null) return UNBOUNDED;
      for (const tok of name.split(/\s+/)) if (tok) out.add(tok);
    }
    return out;
  }

  if (node.type === 'ArrayExpression') {
    const out = new Set<string>();
    for (const el of node.elements ?? []) {
      if (!el) continue;
      // `[...spreadOfArray, expr]` — a spread contributes its element's classes.
      const target = el.type === 'SpreadElement' ? el.argument : el;
      const sub = classTokensOf(target, ctx);
      if (sub === UNBOUNDED) return UNBOUNDED;
      for (const c of sub) out.add(c);
    }
    return out;
  }

  if (node.type === 'ConditionalExpression') {
    // Both arms are possible unless the test folds (array- or string-valued arms).
    const test = evaluate(node.test, ctx.env, ctx.propsLocal);
    if (test.known) return classTokensOf(test.value ? node.consequent : node.alternate, ctx);
    const a = classTokensOf(node.consequent, ctx);
    const b = classTokensOf(node.alternate, ctx);
    if (a === UNBOUNDED || b === UNBOUNDED) return UNBOUNDED;
    return new Set([...a, ...b]);
  }

  // `:class="classes"` where `classes` is a script `const`/`computed` we can
  // follow — union the tokens of every expression it can yield.
  if (node.type === 'Identifier' && node.name && !isPropRef(node.name, ctx)) {
    const exprs = ctx.resolveClassExpr(node.name);
    if (!exprs) return UNBOUNDED;
    const out = new Set<string>();
    for (const e of exprs) {
      const sub = classTokensOf(e, ctx);
      if (sub === UNBOUNDED) return UNBOUNDED;
      for (const c of sub) out.add(c);
    }
    return out;
  }

  // Otherwise it is a string-valued expression: enumerate it, split to tokens.
  const strings = stringValuesOf(node, ctx);
  if (strings === UNBOUNDED) return UNBOUNDED;
  const out = new Set<string>();
  for (const str of strings) for (const tok of str.split(/\s+/)) if (tok) out.add(tok);
  return out;
}

function isPropRef(name: string, ctx: ClassCtx): boolean {
  return ctx.env.has(name) || ctx.setEnv.has(name);
}

/** The possible string values of a string-valued class expression. */
function stringValuesOf(node: AnyNode | null | undefined, ctx: ClassCtx): StrResult {
  if (!node) return UNBOUNDED;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return new Set([String(node.value)]);
    case 'Identifier':
      return valueSetStrings(node.name ?? '', node, ctx);
    case 'MemberExpression': {
      // Non-destructured `props.size` reads like the bare prop `size`.
      const name = propsMemberName(node, ctx.propsLocal);
      if (name == null) return UNBOUNDED;
      return valueSetStrings(name, node, ctx);
    }
    case 'TemplateLiteral': {
      const quasis = node.quasis ?? [];
      const exprs = node.expressions ?? [];
      let combos: string[] = [cookedQuasi(quasis[0])];
      for (let i = 0; i < exprs.length; i++) {
        const parts = stringValuesOf(exprs[i], ctx);
        if (parts === UNBOUNDED) return UNBOUNDED;
        const tail = cookedQuasi(quasis[i + 1]);
        const next: string[] = [];
        for (const base of combos)
          for (const p of parts) {
            next.push(base + p + tail);
            if (next.length > MAX_CLASS_COMBOS) return UNBOUNDED;
          }
        combos = next;
      }
      return new Set(combos);
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') break;
      const left = stringValuesOf(node.left, ctx);
      const right = stringValuesOf(node.right, ctx);
      if (left === UNBOUNDED || right === UNBOUNDED) return UNBOUNDED;
      const out = new Set<string>();
      for (const l of left)
        for (const r of right) {
          out.add(l + r);
          if (out.size > MAX_CLASS_COMBOS) return UNBOUNDED;
        }
      return out;
    }
    case 'ConditionalExpression': {
      // Sound over-approximation: both arms are possible unless the test folds.
      const test = evaluate(node.test, ctx.env, ctx.propsLocal);
      if (test.known) return stringValuesOf(test.value ? node.consequent : node.alternate, ctx);
      const a = stringValuesOf(node.consequent, ctx);
      const b = stringValuesOf(node.alternate, ctx);
      if (a === UNBOUNDED || b === UNBOUNDED) return UNBOUNDED;
      return new Set([...a, ...b]);
    }
    default:
      break;
  }
  const folded = evaluate(node, ctx.env, ctx.propsLocal);
  return folded.known ? new Set([String(folded.value)]) : UNBOUNDED;
}

/** The string forms a prop reference (`size` / `props.size`) can take. */
function valueSetStrings(name: string, node: AnyNode, ctx: ClassCtx): StrResult {
  if (ctx.setEnv.has(name)) {
    const out = new Set<string>();
    for (const v of ctx.setEnv.get(name)!) out.add(String(v));
    return out;
  }
  const folded = evaluate(node, ctx.env, ctx.propsLocal);
  return folded.known ? new Set([String(folded.value)]) : UNBOUNDED;
}

/**
 * Build a resolver from a script-local class identifier (`:class="classes"`) to
 * the class-producing expressions a top-level `const classes = …` can yield:
 * a `computed(() => …)` arrow's returns, or a direct array/expression initializer.
 * Returns null for anything we cannot follow (so the class set goes unbounded).
 */
function makeClassExprResolver(model: FileModel): (name: string) => AnyNode[] | null {
  const ss = model.sfc.scriptSetup;
  if (!ss) return () => null;
  // Only `const … = computed(() => …)` is resolvable soundly: a `const` binding
  // can't be reassigned, and a computed returns a FRESH value each run that the
  // template only reads.  A `let`/`var` could be reassigned, and a plain array
  // const could be mutated in place (`classes.push(…)`) — both would make our
  // static view of the class set wrong, so we leave such `:class` refs unbounded.
  const computeds = new Map<string, AnyNode>();
  for (const stmt of (ss.ast.body as AnyNode[] | undefined) ?? []) {
    if (stmt.type !== 'VariableDeclaration' || stmt.kind !== 'const') continue;
    for (const d of stmt.declarations ?? []) {
      if (d.id?.type !== 'Identifier' || !d.id.name) continue;
      const init = d.init;
      if (init?.type !== 'CallExpression' || init.callee?.type !== 'Identifier') continue;
      if (init.callee.name !== 'computed') continue;
      const cb = init.arguments?.[0];
      if (cb?.type === 'ArrowFunctionExpression' || cb?.type === 'FunctionExpression')
        computeds.set(d.id.name, cb);
    }
  }
  return (name) => {
    const cb = computeds.get(name);
    return cb ? functionReturnExprs(cb) : null;
  };
}

/** Every expression a function can return (arrow-expression body or `return`s). */
function functionReturnExprs(fn: AnyNode): AnyNode[] {
  const body = fn.body;
  if (!body) return [];
  if (!Array.isArray(body) && body.type !== 'BlockStatement') return [body]; // arrow expr body
  const out: AnyNode[] = [];
  const visit = (node: AnyNode | null | undefined): void => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    // Do not descend into nested functions — their returns are not this one's.
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    )
      return;
    if (node.type === 'ReturnStatement') {
      if (node.argument) out.push(node.argument);
      return;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) for (const it of v) visit(it as AnyNode);
      else if (v && typeof v === 'object' && typeof (v as AnyNode).type === 'string')
        visit(v as AnyNode);
    }
  };
  visit(body as AnyNode);
  return out;
}

function cookedQuasi(quasi: AnyNode | undefined): string {
  const value = quasi?.value as { cooked?: string; raw?: string } | undefined;
  return value?.cooked ?? value?.raw ?? '';
}

// ----------------------------------------------------------------------
// Rule removal
// ----------------------------------------------------------------------

/**
 * Remove provably-dead rules from each `<style scoped>` block by re-stringifying
 * the block without them (postcss preserves the raws of surviving rules, so the
 * remaining CSS keeps its original formatting).  Returns the number removed.
 */
export function shakeCss(model: FileModel, plan: ComponentPlan, s: MagicString): number {
  const possible = computePossibleClasses(model, plan);
  if (possible.unbounded) return 0;

  let removed = 0;
  for (const block of model.sfc.styles) {
    if (!block.scoped) continue; // global styles may match elsewhere — never touch
    let root;
    try {
      root = postcssParse(block.content);
    } catch {
      continue;
    }
    let blockRemoved = 0;
    root.each((node: ChildNode) => {
      if (node.type !== 'rule') return;
      if (isRuleDead(node, possible.classes)) {
        node.remove();
        blockRemoved += 1;
      }
    });
    if (blockRemoved > 0) {
      const end = block.base + block.content.length;
      s.overwrite(block.base, end, root.toString());
      removed += blockRemoved;
    }
  }
  return removed;
}

/**
 * Pseudo-classes that take a selector list `walkClasses` flattens, but whose
 * classes are NOT all-required (disjunction / negation) — see {@link isRuleDead}.
 */
const FUNCTIONAL_PSEUDOS = new Set([
  ':is',
  ':where',
  ':not',
  ':has',
  ':matches',
  ':-moz-any',
  ':-webkit-any',
]);

/**
 * Is this whole rule provably dead given the bounded possible class set?  Dead
 * iff it uses no scope-piercing pseudo and every selector in its list requires at
 * least one class absent from the possible set (a selector with no class is never
 * dead, so such rules are always kept).
 */
function isRuleDead(rule: Rule, possible: Set<string>): boolean {
  let dead = false;
  try {
    selectorParser((selectors) => {
      let pierces = false;
      let complex = false;
      let allDead = true;
      let any = false;
      selectors.each((sel) => {
        any = true;
        const classes: string[] = [];
        sel.walkPseudos((p) => {
          const v = p.value;
          if (v.includes('deep') || v.includes('global') || v.includes('slotted')) pierces = true;
          // Functional pseudos take a selector LIST whose classes `walkClasses`
          // flattens in — but their semantics are NOT "every class required":
          // `:is()/:where()/:has()/:matches()` are disjunctions and `:not()` is a
          // negation, so the simple "any missing class -> dead" rule is wrong for
          // them.  Keep such rules rather than risk removing a live one.
          if (FUNCTIONAL_PSEUDOS.has(v)) complex = true;
        });
        sel.walkClasses((c) => {
          classes.push(c.value);
        });
        // A selector with no class requirement can still match -> not dead
        // (`.some()` is already `false` for an empty list).
        const selDead = classes.some((c) => !possible.has(c));
        if (!selDead) allDead = false;
      });
      dead = any && allDead && !pierces && !complex;
    }).processSync(rule.selector);
  } catch {
    return false; // unparsable selector -> keep the rule
  }
  return dead;
}
