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
import { evaluate } from './eval';

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
 * Compute the component's possible class set (docs §3, step 1).  Sources: static
 * `class="a b"`, `:class` with foldable/narrowable expressions, and object/array
 * `:class` syntaxes (object keys are always-possible classes).  Any spread or
 * non-enumerable `:class` makes the set unbounded.
 */
export function computePossibleClasses(model: FileModel, plan: ComponentPlan): PossibleClasses {
  const classes = new Set<string>();
  let unbounded = false;
  const env = plan.constFold;
  const setEnv = plan.narrow;

  walkTemplate(model.sfc.template, (node) => {
    if (node.type !== VueNode.ELEMENT) return;
    for (const p of node.props ?? []) {
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
      const result = classValueTokens(ast, env, setEnv);
      if (result === UNBOUNDED) unbounded = true;
      else for (const c of result) classes.add(c);
    }
  });

  return { classes, unbounded };
}

/** Tokens contributed by one `:class` VALUE node (string / array / object). */
function classValueTokens(
  node: AnyNode | undefined,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): StrResult {
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
      const sub = classValueTokens(el, env, setEnv);
      if (sub === UNBOUNDED) return UNBOUNDED;
      for (const c of sub) out.add(c);
    }
    return out;
  }
  // A string-valued expression: enumerate its possible strings, split to tokens.
  const strings = expressionStrings(node, env, setEnv);
  if (strings === UNBOUNDED) return UNBOUNDED;
  const out = new Set<string>();
  for (const str of strings) for (const tok of str.split(/\s+/)) if (tok) out.add(tok);
  return out;
}

/** The possible string values of a string-valued `:class` expression. */
function expressionStrings(
  node: AnyNode | null | undefined,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): StrResult {
  if (!node) return UNBOUNDED;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return new Set([String(node.value)]);
    case 'Identifier': {
      const name = node.name ?? '';
      if (setEnv.has(name)) {
        const out = new Set<string>();
        for (const v of setEnv.get(name)!) out.add(String(v));
        return out;
      }
      const folded = evaluate(node, env);
      return folded.known ? new Set([String(folded.value)]) : UNBOUNDED;
    }
    case 'TemplateLiteral': {
      const quasis = node.quasis ?? [];
      const exprs = node.expressions ?? [];
      let combos: string[] = [cookedQuasi(quasis[0])];
      for (let i = 0; i < exprs.length; i++) {
        const parts = expressionStrings(exprs[i], env, setEnv);
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
      const left = expressionStrings(node.left, env, setEnv);
      const right = expressionStrings(node.right, env, setEnv);
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
      const test = evaluate(node.test, env);
      if (test.known)
        return expressionStrings(test.value ? node.consequent : node.alternate, env, setEnv);
      const a = expressionStrings(node.consequent, env, setEnv);
      const b = expressionStrings(node.alternate, env, setEnv);
      if (a === UNBOUNDED || b === UNBOUNDED) return UNBOUNDED;
      return new Set([...a, ...b]);
    }
    default:
      break;
  }
  const folded = evaluate(node, env);
  return folded.known ? new Set([String(folded.value)]) : UNBOUNDED;
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
      let allDead = true;
      let any = false;
      selectors.each((sel) => {
        any = true;
        const classes: string[] = [];
        sel.walkPseudos((p) => {
          const v = p.value;
          if (v.includes('deep') || v.includes('global') || v.includes('slotted')) pierces = true;
        });
        sel.walkClasses((c) => {
          classes.push(c.value);
        });
        // A selector with no class requirement can still match -> not dead
        // (`.some()` is already `false` for an empty list).
        const selDead = classes.some((c) => !possible.has(c));
        if (!selDead) allDead = false;
      });
      dead = any && allDead && !pierces;
    }).processSync(rule.selector);
  } catch {
    return false; // unparsable selector -> keep the rule
  }
  return dead;
}
