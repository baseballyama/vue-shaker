// ----------------------------------------------------------------------
// Shared `v-if`-chain-folding predicate (docs/ARCHITECTURE.md §3, §7).
//
// Both the transform (which EDITS the source) and the analysis fixpoint (which
// needs to know WHICH call sites disappear) must agree, to the byte, on what
// folds away.  So the decision for one `v-if` / `v-else-if` / `v-else` chain
// lives here, once, and is consumed by both:
//   - transform.ts turns a `ChainDecision` into MagicString edits.
//   - computeDeadSpans() turns the same decisions into the element spans that
//     genuinely vanish from the output (used to drop call sites in dead code).
//
// Vue's conditional is NOT one nested block (as in Svelte) but a run of adjacent
// SIBLING elements: a `v-if` element, zero+ `v-else-if` elements, and an
// optional `v-else` element, possibly separated by whitespace / comments.  So a
// "chain" here is collected across a children array (docs §7).
// ----------------------------------------------------------------------

import { evaluateWithSets } from './eval';
import { eachChildList, exprContent, parseExpr, VueNode, type AnyNode } from './parse';
import type { Literal } from './ir';

export type Span = [number, number];

export type CondKind = 'if' | 'else-if' | 'else';

/** One arm of a `v-if` chain: its element, its conditional directive, its test. */
interface Arm {
  el: AnyNode;
  dir: AnyNode;
  kind: CondKind;
  /** Parsed test expression (undefined for `v-else` or an unparsable exp). */
  testAst: AnyNode | undefined;
}

/**
 * The outcome of folding one chain against the known environments.
 *
 * `removed` are element spans deleted from the output (dead arms).
 * `dirRemovals` are directive spans deleted because their element now renders
 * unconditionally (a `v-if`/`v-else-if` proven true, or a surviving `v-else`).
 * `promotion`, when present, rewrites a surviving `v-else-if` head to `v-if`.
 */
export interface ChainDecision {
  removed: Span[];
  dirRemovals: Span[];
  promotion?: { from: number; to: number; text: string } | undefined;
}

/** The conditional directive on an element, if any. */
export function conditionalOf(el: AnyNode): { dir: AnyNode; kind: CondKind } | undefined {
  if (el.type !== VueNode.ELEMENT) return undefined;
  for (const p of el.props ?? []) {
    if (p.type !== VueNode.DIRECTIVE) continue;
    if (p.name === 'if') return { dir: p, kind: 'if' };
    if (p.name === 'else-if') return { dir: p, kind: 'else-if' };
    if (p.name === 'else') return { dir: p, kind: 'else' };
  }
  return undefined;
}

const isBlank = (n: AnyNode): boolean =>
  (n.type === VueNode.TEXT && typeof n.content === 'string' && n.content.trim() === '') ||
  n.type === VueNode.COMMENT;

/**
 * Collect every `v-if` chain in one children array.  A chain begins at an
 * element carrying `v-if` and extends across following siblings (skipping blank
 * text / comments) that carry `v-else-if`, ending at a `v-else` or the first
 * sibling that continues no chain.
 */
export function collectChains(children: AnyNode[]): Arm[][] {
  const chains: Arm[][] = [];
  for (let i = 0; i < children.length; i++) {
    const head = children[i]!;
    const cond = conditionalOf(head);
    if (!cond || cond.kind !== 'if') continue;

    const arms: Arm[] = [armOf(head, cond.dir, 'if')];
    let j = i + 1;
    for (; j < children.length; j++) {
      const sib = children[j]!;
      if (isBlank(sib)) continue;
      const sc = conditionalOf(sib);
      if (!sc || sc.kind === 'if') break; // new element / new chain ends this one
      arms.push(armOf(sib, sc.dir, sc.kind));
      if (sc.kind === 'else') {
        j++;
        break;
      }
    }
    chains.push(arms);
    i = j - 1;
  }
  return chains;
}

function armOf(el: AnyNode, dir: AnyNode, kind: CondKind): Arm {
  return { el, dir, kind, testAst: kind === 'else' ? undefined : parseExpr(exprContent(dir.exp)) };
}

/**
 * Decide how one chain folds against `env` (constFold) and `setEnv` (value
 * sets).  Soundness: an arm is dropped only when its test is provably FALSE for
 * every reachable value; the chain collapses to one arm only when that arm is
 * provably TRUE and every earlier arm is provably FALSE.  Otherwise the chain is
 * kept (with provably-dead later arms removed).
 */
export function decideChain(
  arms: Arm[],
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): ChainDecision {
  // `v-else` (no test) is the fallback: taken iff every earlier arm is false, so
  // its own truth — given control reached it — is constant true.
  const truth = arms.map((a) =>
    a.kind === 'else'
      ? ({ known: true, value: true } as const)
      : evaluateWithSets(a.testAst, env, setEnv),
  );
  const isTrue = (t: (typeof truth)[number]) => t.known && Boolean(t.value);
  const isFalse = (t: (typeof truth)[number]) => t.known && !t.value;

  const span = (a: Arm): Span => [a.el.loc!.start.offset, a.el.loc!.end.offset];
  const dirSpan = (a: Arm): Span => [a.dir.loc!.start.offset, a.dir.loc!.end.offset];

  // (a) An arm is provably TRUE with every earlier arm provably FALSE: it is
  // always taken -> render it unconditionally, remove every other arm.
  let allEarlierFalse = true;
  for (let i = 0; i < arms.length; i++) {
    if (isTrue(truth[i]!) && allEarlierFalse) {
      const removed: Span[] = [];
      for (let k = 0; k < arms.length; k++) if (k !== i) removed.push(span(arms[k]!));
      // The surviving element loses its conditional directive (it always renders).
      return { removed, dirRemovals: [dirSpan(arms[i]!)] };
    }
    if (!isFalse(truth[i]!)) allEarlierFalse = false;
  }

  // (b) Keep the arms that are not provably false.
  const firstKept = truth.findIndex((t) => !isFalse(t));
  if (firstKept === -1) {
    // Every arm is provably false (only possible with no `v-else`): nothing
    // renders -> remove the whole chain.
    return { removed: arms.map(span), dirRemovals: [] };
  }

  const removed: Span[] = [];
  for (let i = 0; i < firstKept; i++) removed.push(span(arms[i]!)); // dead prefix
  for (let i = firstKept + 1; i < arms.length; i++) {
    if (isFalse(truth[i]!)) removed.push(span(arms[i]!)); // dead tail
  }

  if (firstKept === 0) {
    // Head survives in place with its `v-if`; only dead later arms removed.
    return { removed, dirRemovals: [] };
  }

  // The original head is dead; promote the first survivor to the chain head.
  const head = arms[firstKept]!;
  if (head.kind === 'else') {
    // A surviving `v-else` with all earlier arms dead renders unconditionally.
    return { removed, dirRemovals: [dirSpan(head)] };
  }
  // `v-else-if="…"` -> `v-if="…"`: overwrite just the directive keyword.
  const from = head.dir.loc!.start.offset;
  return {
    removed,
    dirRemovals: [],
    promotion: { from, to: from + 'v-else-if'.length, text: 'v-if' },
  };
}

/** Is `span` fully contained in any of `spans`? */
export function inSpans(span: Span, spans: Span[]): boolean {
  return spans.some(([a, b]) => span[0] >= a && span[1] <= b);
}

/** Is the node's template span inside any dead span? */
export function nodeInSpans(node: AnyNode, spans: Span[]): boolean {
  const loc = node.loc;
  if (!loc) return false;
  return inSpans([loc.start.offset, loc.end.offset], spans);
}

/**
 * Element spans that genuinely vanish from a component's output when its plan is
 * applied (dead `v-if` arms).  The SAME predicate the transform uses, so a call
 * site is excluded from a child's prop profile iff the transform would actually
 * delete it (docs §2.1 cascade).
 */
export function computeDeadSpans(
  template: AnyNode | undefined,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): Span[] {
  if (!template || (env.size === 0 && setEnv.size === 0)) return [];
  const dead: Span[] = [];
  eachChildList(template, (children) => {
    for (const arms of collectChains(children)) {
      // Skip a chain whose head already lives inside a region we removed.
      if (nodeInSpans(arms[0]!.el, dead)) continue;
      const decision = decideChain(arms, env, setEnv);
      for (const r of decision.removed) dead.push(r);
    }
  });
  return dead;
}
