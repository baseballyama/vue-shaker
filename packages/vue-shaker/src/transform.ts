import MagicString from 'magic-string';
import {
  eachChildList,
  exprContent,
  isComponentNode,
  parseExpr,
  VueNode,
  walkTemplate,
  type AnyNode,
} from './parse';
import type { ComponentId, ComponentPlan, Literal } from './ir';
import type { FileModel } from './analyze';
import { collectChains, decideChain, nodeInSpans, type Span } from './dead';
import { evaluate } from './eval';
import { shakeCss } from './css';

/**
 * Apply every plan to every component and return the shaken source per file.
 *
 * Two phases over a shared set of MagicStrings so a parent's call-site
 * attributes are removed using each child's ACTUALLY dropped props (phase 2),
 * not just what the plan proposed (phase 1).
 */
export function transformAll(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Record<ComponentId, string> {
  const strings = new Map<ComponentId, MagicString>();
  const dropped = new Map<ComponentId, Set<string>>();

  // Phase 1 — component bodies: fold dead `v-if` arms, demote folded props.
  for (const model of models.values()) {
    const s = new MagicString(model.code);
    strings.set(model.id, s);
    const plan = plans.get(model.id)!;
    dropped.set(
      model.id,
      plan.bail ? new Set() : shakeBody(model, plan.constFold, plan.narrow, plan, s),
    );
  }
  // Phase 2 — call sites: remove attributes for props the child actually dropped.
  for (const model of models.values()) {
    removeCallSiteAttributes(model, dropped, strings.get(model.id)!);
  }

  const out: Record<ComponentId, string> = {};
  for (const model of models.values()) out[model.id] = strings.get(model.id)!.toString();
  return out;
}

/**
 * Slim one component's body against the fold (`env`) and narrow (`setEnv`)
 * environments, editing `s` in place, and return the set of props that left the
 * `defineProps` signature.
 *
 * Vue strategy (docs §7): a folded prop is DEMOTED from the destructure to a
 * local `const name = <value>`, rather than substituted at every reference.  Vue
 * resolves template/script identifiers to setup bindings, so the demoted const
 * keeps every reference valid with no dangling identifier — and the prop still
 * leaves the public signature, so call sites can drop the attribute.  This avoids
 * the substitution-completeness hazard (a missed reference would dangle).
 */
export function shakeBody(
  model: FileModel,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
  cssPlan: ComponentPlan,
  s: MagicString,
): Set<string> {
  if (env.size === 0 && setEnv.size === 0) return new Set();

  // (1) Fold `v-if` chains (L1 const + L1.5 narrowing), recording dead spans.
  const dead: Span[] = [];
  foldIfChains(model, env, setEnv, s, dead);

  // (2) Demote folded (constFold) props to local consts and drop them from the
  // `defineProps` signature (+ type members).  Narrowed props stay (still used).
  const dropped = demoteFoldedProps(model, env, s);

  // (3) CSS rule removal: drop `<style scoped>` rules targeting a class the
  // component can provably never produce given the value sets (docs §3 CSS).
  const cssView: ComponentPlan = { ...cssPlan, constFold: env, narrow: setEnv };
  shakeCss(model, cssView, s);

  return dropped;
}

/**
 * Fold `v-if` / `v-else-if` / `v-else` chains across every children list, turning
 * each {@link decideChain} decision into MagicString edits and recording the
 * removed element spans in `dead`.
 */
function foldIfChains(
  model: FileModel,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
  s: MagicString,
  dead: Span[],
): void {
  const code = model.code;
  eachChildList(model.sfc.template, (children) => {
    for (const arms of collectChains(children)) {
      if (nodeInSpans(arms[0]!.el, dead)) continue;
      const decision = decideChain(arms, env, setEnv);
      for (const [a, b] of decision.removed) {
        removeWithLeadingSpace(code, a, b, s);
        dead.push([a, b]);
      }
      for (const [a, b] of decision.dirRemovals) removeWithLeadingSpace(code, a, b, s);
      if (decision.promotion) {
        const { from, to, text } = decision.promotion;
        s.overwrite(from, to, text);
      }
    }
  });
}

/** Remove `[a,b)` plus one run of preceding spaces/tabs (keep one newline tidy). */
function removeWithLeadingSpace(code: string, a: number, b: number, s: MagicString): void {
  let start = a;
  while (start > 0 && (code[start - 1] === ' ' || code[start - 1] === '\t')) start -= 1;
  s.remove(start, b);
}

/**
 * Drop each `constFold` prop from the destructure pattern (+ its type member) and
 * declare a local `const name = <value>` so every reference stays valid.  Returns
 * the set of dropped prop names (the call sites whose attribute can be removed).
 */
function demoteFoldedProps(
  model: FileModel,
  env: Map<string, Literal>,
  s: MagicString,
): Set<string> {
  const dropped = new Set<string>();
  const ss = model.sfc.scriptSetup;
  if (!model.props || env.size === 0 || !ss || !model.propsDeclaration || !model.propsPattern)
    return dropped;
  const base = ss.base;

  const fold = model.props.filter((p) => env.has(p.name));
  if (fold.length === 0) return dropped;
  for (const p of fold) dropped.add(p.name);

  const constLines = fold
    .map((p) => `const ${p.name} = ${literalSource(env.get(p.name)!)};`)
    .join('\n');

  const remaining = model.props.filter((p) => !env.has(p.name));
  const declStart = base + (model.propsDeclaration!.start ?? 0);
  let declEnd = base + (model.propsDeclaration!.end ?? 0);
  if (model.code[declEnd] === ';') declEnd += 1;

  if (remaining.length === 0 && !model.hasRestProp) {
    // No props survive: replace the whole `const {…} = defineProps<…>()`.
    s.overwrite(declStart, declEnd, constLines);
    return dropped;
  }

  // Some props survive: surgically remove the folded ones, append the consts.
  const properties = model.propsPattern?.properties ?? [];
  for (const p of fold) {
    removePatternProperty(properties, p.property, base, s, model.code);
    removeTypeMember(model.definePropsCall, p.name, base, s, model.code);
  }
  s.appendLeft(declEnd, `\n${constLines}`);
  return dropped;
}

function removePatternProperty(
  properties: AnyNode[],
  property: AnyNode,
  base: number,
  s: MagicString,
  code: string,
): void {
  const i = properties.indexOf(property);
  removeListItem(property, properties[i - 1], base, s, code);
}

/** Remove a prop's type member from `defineProps<{ … }>()`'s type literal. */
function removeTypeMember(
  definePropsCall: AnyNode | undefined,
  name: string,
  base: number,
  s: MagicString,
  code: string,
): void {
  const typeArg = definePropsCall?.typeParameters?.params?.[0];
  const members = typeArg?.members ?? [];
  const i = members.findIndex((m) => m.key?.type === 'Identifier' && m.key.name === name);
  if (i === -1) return;
  removeListItem(members[i]!, members[i - 1], base, s, code);
}

/**
 * Remove one comma-separated list item (an object-pattern property or a type
 * member) together with its separator, so no dangling `,` survives.  We delete
 * the item plus the comma + whitespace that follows it; for a trailing item
 * (no following comma before the closing `}`) we instead also consume the comma
 * that precedes it.  The scan is on the *original* source, so overlapping
 * removals across several siblings still compose correctly in MagicString.
 */
function removeListItem(
  item: AnyNode,
  prev: AnyNode | undefined,
  base: number,
  s: MagicString,
  code: string,
): void {
  const start = base + (item.start ?? 0);
  const end = base + (item.end ?? 0);

  // Look for a trailing `,` after the item (skipping whitespace).
  let after = end;
  while (after < code.length && (code[after] === ' ' || code[after] === '\t')) after += 1;
  if (code[after] === ',') {
    // Consume the comma and the run of whitespace/newline after it.
    let to = after + 1;
    while (to < code.length && (code[to] === ' ' || code[to] === '\t' || code[to] === '\n'))
      to += 1;
    s.remove(start, to);
    return;
  }

  // No trailing comma (item is last) — drop the preceding comma instead.
  if (prev) {
    s.remove(base + (prev.end ?? 0), end);
    return;
  }
  s.remove(start, end);
}

function removeCallSiteAttributes(
  model: FileModel,
  dropped: Map<ComponentId, Set<string>>,
  s: MagicString,
): void {
  const code = model.code;
  walkTemplate(model.sfc.template, (node) => {
    if (!isComponentNode(node) || !node.tag) return;
    const childId = model.imports.get(node.tag);
    const drop = childId ? dropped.get(childId) : undefined;
    if (!drop || drop.size === 0) return;
    for (const p of node.props ?? []) {
      if (p.type === VueNode.ATTRIBUTE) {
        if (p.name && drop.has(p.name)) removeAttrSpan(code, p, s);
      } else if (p.type === VueNode.DIRECTIVE && p.name === 'bind') {
        const argName = exprContent(p.arg);
        if (argName && drop.has(argName) && isLiteralBind(p)) removeAttrSpan(code, p, s);
      }
    }
  });
}

/**
 * A `:foo="…"` bind is safe to delete only if its value is a pure literal (no
 * side effects).  A dropped prop's call sites are all literal/static by
 * construction (anything dynamic would have poisoned its value set), so this is
 * a defensive check that never removes a side-effecting expression.
 */
function isLiteralBind(dir: AnyNode): boolean {
  const content = exprContent(dir.exp);
  if (content == null) return false;
  const ast = parseExpr(content);
  return ast != null && evaluate(ast, new Map()).known;
}

function removeAttrSpan(code: string, node: AnyNode, s: MagicString): void {
  const loc = node.loc!;
  let start = loc.start.offset;
  while (
    start > 0 &&
    (code[start - 1] === ' ' || code[start - 1] === '\t' || code[start - 1] === '\n')
  )
    start -= 1;
  s.remove(start, loc.end.offset);
}

function literalSource(value: Literal): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}
