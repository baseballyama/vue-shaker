import { parse as sfcParse } from '@vue/compiler-sfc';
import { parse as babelModuleParse, parseExpression } from '@babel/parser';

// ----------------------------------------------------------------------
// A deliberately loose view of the two ASTs this engine reads:
//   1. Vue's template AST (`@vue/compiler-sfc` -> `descriptor.template.ast`),
//      whose nodes use a NUMERIC `type` (NodeTypes) and a `loc` with absolute
//      SFC byte offsets (`loc.start.offset` / `loc.end.offset`).
//   2. Babel's script/expression AST (`<script setup>` parsed with
//      `@babel/parser`), whose nodes use a STRING `type` and `start` / `end`
//      offsets RELATIVE to whatever source string was parsed.
//
// Only the fields the engine actually touches are listed (each optional, no
// index signature) so named access stays compatible with strict TS while we
// walk an untyped tree.  `value`/`content` are `unknown` because they mean
// different things on different node kinds.
// ----------------------------------------------------------------------

export interface Pos {
  offset: number;
  line?: number | undefined;
  column?: number | undefined;
}
export interface Loc {
  start: Pos;
  end: Pos;
  source?: string | undefined;
}

export interface AnyNode {
  /** Numeric for Vue template nodes (NodeTypes), string for Babel nodes. */
  type: string | number;

  // Babel offsets (relative to the parsed source string).
  start?: number | undefined;
  end?: number | undefined;
  // Vue template offsets (absolute SFC offsets).
  loc?: Loc | undefined;

  // ---- Babel expression / statement fields ----
  operator?: string | undefined;
  left?: AnyNode | undefined;
  right?: AnyNode | undefined;
  argument?: AnyNode | undefined;
  test?: AnyNode | undefined;
  consequent?: AnyNode | undefined;
  alternate?: AnyNode | null | undefined;
  callee?: AnyNode | undefined;
  arguments?: AnyNode[] | undefined;
  object?: AnyNode | undefined;
  property?: AnyNode | undefined;
  computed?: boolean | undefined;
  shorthand?: boolean | undefined;
  expressions?: AnyNode[] | undefined;
  quasis?: AnyNode[] | undefined;
  elements?: (AnyNode | null)[] | undefined;
  properties?: AnyNode[] | undefined;
  key?: AnyNode | undefined;
  id?: AnyNode | undefined;
  init?: AnyNode | null | undefined;
  /** `VariableDeclaration.kind`: `'const' | 'let' | 'var'`. */
  kind?: string | undefined;
  declarations?: AnyNode[] | undefined;
  declaration?: AnyNode | null | undefined;
  specifiers?: AnyNode[] | undefined;
  local?: AnyNode | undefined;
  imported?: AnyNode | undefined;
  exported?: AnyNode | undefined;
  source?: AnyNode | undefined;
  params?: AnyNode[] | undefined;
  body?: AnyNode | AnyNode[] | undefined;
  typeParameters?: AnyNode | undefined;
  typeAnnotation?: AnyNode | undefined;
  members?: AnyNode[] | undefined;
  program?: AnyNode | undefined;

  // ---- Vue template fields ----
  tag?: string | undefined;
  /** ElementTypes: 0=ELEMENT 1=COMPONENT 2=SLOT 3=TEMPLATE. */
  tagType?: number | undefined;
  isSelfClosing?: boolean | undefined;
  props?: AnyNode[] | undefined;
  children?: AnyNode[] | undefined;
  /** SimpleExpressionNode `arg`/`exp` (DirectiveNode) — has `.content` string. */
  arg?: AnyNode | undefined;
  exp?: AnyNode | undefined;
  modifiers?: unknown[] | undefined;
  isStatic?: boolean | undefined;
  /** Vue's precompiled Babel AST for a complex expression (may be absent). */
  ast?: AnyNode | false | null | undefined;

  // Shared / overloaded:
  /** Babel: `Identifier.name`/import name; Vue: DirectiveNode name (`if`,`bind`). */
  name?: string | undefined;
  /** Babel literal value; Vue AttributeNode `value` is itself a TextNode. */
  value?: unknown;
  /** Vue TextNode / SimpleExpressionNode string, or InterpolationNode child. */
  content?: unknown;
}

// ---- Vue node-type constants (NodeTypes / ElementTypes) -----------------
// Hard-coded rather than imported so a single numeric source of truth lives
// here; verified against `@vue/compiler-dom`'s NodeTypes enum.

export const VueNode = {
  ROOT: 0,
  ELEMENT: 1,
  TEXT: 2,
  COMMENT: 3,
  SIMPLE_EXPRESSION: 4,
  INTERPOLATION: 5,
  ATTRIBUTE: 6,
  DIRECTIVE: 7,
} as const;

export const ElementType = {
  ELEMENT: 0,
  COMPONENT: 1,
  SLOT: 2,
  TEMPLATE: 3,
} as const;

export const isElementNode = (n: AnyNode): boolean => n.type === VueNode.ELEMENT;
export const isComponentNode = (n: AnyNode): boolean =>
  n.type === VueNode.ELEMENT && n.tagType === ElementType.COMPONENT;
export const isDirective = (n: AnyNode): boolean => n.type === VueNode.DIRECTIVE;
export const isAttribute = (n: AnyNode): boolean => n.type === VueNode.ATTRIBUTE;
export const isInterpolation = (n: AnyNode): boolean => n.type === VueNode.INTERPOLATION;
export const isText = (n: AnyNode): boolean => n.type === VueNode.TEXT;

/** Absolute SFC span of a Vue template node. */
export function tspan(n: AnyNode): [number, number] {
  const loc = n.loc!;
  return [loc.start.offset, loc.end.offset];
}

// ----------------------------------------------------------------------
// SFC parsing
// ----------------------------------------------------------------------

/** One `<script setup>` block, with the base offset to map Babel -> SFC. */
export interface ScriptSetup {
  content: string;
  /** Absolute SFC offset where `content` begins (loc.start.offset). */
  base: number;
  /** Absolute SFC offset where `content` ends (loc.end.offset). */
  endOffset: number;
  /** Babel `Program` node (its `.body` are the top-level statements). */
  ast: AnyNode;
  lang: string | undefined;
}

/** One `<style>` block. */
export interface StyleBlock {
  content: string;
  /** Absolute SFC offset where the style content begins. */
  base: number;
  scoped: boolean;
}

/** Everything one `.vue` SFC parse yields, in this engine's loose shape. */
export interface ParsedSfc {
  id: string;
  code: string;
  /** Vue template RootNode (`descriptor.template.ast`), or undefined. */
  template: AnyNode | undefined;
  /** Parsed `<script setup>`, or undefined (Options API / plain script). */
  scriptSetup: ScriptSetup | undefined;
  /** True when the SFC has a non-setup `<script>` or no `<script setup>`. */
  hasPlainScript: boolean;
  styles: StyleBlock[];
}

const TS_PLUGINS = ['typescript'] as const;

/** Parse `<script setup>` content into a Babel `Program` node. */
function babelProgram(content: string): AnyNode {
  const file = babelModuleParse(content, {
    sourceType: 'module',
    plugins: [...TS_PLUGINS],
  }) as unknown as { program: AnyNode };
  return file.program;
}

/**
 * Parse a standalone `.ts`/`.js` module into a Babel `Program`, or null if it
 * does not parse.  Used to scan non-`.vue` files in scope for components that
 * escape into script (e.g. `createApp(Dialog, props)`), whose props are passed
 * outside any template call site and so must bail.
 */
export function parseModuleProgram(code: string): AnyNode | null {
  try {
    return babelProgram(code);
  } catch {
    return null;
  }
}

/**
 * Parse one `.vue` SFC into the engine's loose model.  Throws nothing the caller
 * must handle beyond Vue's own parse errors (a malformed SFC); the Shell decides
 * whether to pass such files through untouched.
 */
export function parseVue(code: string, filename: string): ParsedSfc {
  const { descriptor } = sfcParse(code, { filename }) as unknown as { descriptor: AnyNode };
  const d = descriptor as unknown as {
    template?: { ast?: AnyNode } | null;
    scriptSetup?: { content: string; loc: Loc; attrs?: Record<string, unknown> } | null;
    script?: unknown;
    styles?: Array<{ content: string; loc: Loc; scoped?: boolean }>;
  };

  let scriptSetup: ScriptSetup | undefined;
  if (d.scriptSetup) {
    const ss = d.scriptSetup;
    const langAttr = ss.attrs?.['lang'];
    scriptSetup = {
      content: ss.content,
      base: ss.loc.start.offset,
      endOffset: ss.loc.end.offset,
      ast: babelProgram(ss.content),
      lang: typeof langAttr === 'string' ? langAttr : undefined,
    };
  }

  const styles: StyleBlock[] = (d.styles ?? []).map((s) => ({
    content: s.content,
    base: s.loc.start.offset,
    scoped: s.scoped === true,
  }));

  return {
    id: filename,
    code,
    template: d.template?.ast ?? undefined,
    scriptSetup,
    hasPlainScript: d.script != null,
    styles,
  };
}

/**
 * Content-keyed parse cache: a hit returns the IDENTICAL parse for unchanged
 * source, so the dev engine re-parses only files that actually changed
 * (docs/RUST-MIGRATION.md §2.2).  Keyed by content, so a stale entry can never
 * return offsets that disagree with the source.
 */
export type ParseCache = Map<string, { code: string; sfc: ParsedSfc }>;

export function parseCached(filename: string, code: string, cache?: ParseCache): ParsedSfc {
  if (!cache) return parseVue(code, filename);
  const hit = cache.get(filename);
  if (hit && hit.code === code) return hit.sfc;
  const sfc = parseVue(code, filename);
  cache.set(filename, { code, sfc });
  return sfc;
}

// ----------------------------------------------------------------------
// Expression parsing (template `v-if` / `:bind` / `{{ }}` content)
// ----------------------------------------------------------------------

/**
 * Parse a Vue template expression string into a Babel AST.  Offsets on the
 * returned node are RELATIVE to `content`; map to absolute SFC offsets via the
 * owning expression node's `loc.start.offset` (which the probe confirmed aligns
 * exactly with `content`).  Returns `undefined` if the expression does not parse
 * (the caller then treats it as non-foldable).
 */
export function parseExpr(content: string | undefined): AnyNode | undefined {
  if (content == null || content.trim() === '') return undefined;
  try {
    return parseExpression(content, { plugins: [...TS_PLUGINS] }) as unknown as AnyNode;
  } catch {
    return undefined;
  }
}

/** The `.content` string of a Vue SimpleExpressionNode (`exp`/`arg`). */
export function exprContent(node: AnyNode | undefined): string | undefined {
  if (!node) return undefined;
  return typeof node.content === 'string' ? node.content : undefined;
}

// ----------------------------------------------------------------------
// Walkers
// ----------------------------------------------------------------------

/**
 * Depth-first walk over Vue TEMPLATE nodes (the `children` tree).  `visit` is
 * called for every node; returning `false` skips that node's children.  Does NOT
 * descend into directive expressions (those are Babel ASTs walked separately).
 */
export function walkTemplate(
  node: AnyNode | undefined,
  visit: (n: AnyNode) => boolean | void,
): void {
  if (!node) return;
  const recurse = visit(node);
  if (recurse === false) return;
  for (const child of node.children ?? []) walkTemplate(child, visit);
}

/**
 * For every node that owns a `children` array (root + element/template nodes),
 * call `fn(children, parent)`.  This is the level at which `v-if` / `v-else-if` /
 * `v-else` chains are folded, since in Vue those are sibling elements rather than
 * one nested block (docs §7).
 */
export function eachChildList(
  node: AnyNode | undefined,
  fn: (children: AnyNode[], parent: AnyNode) => void,
): void {
  if (!node) return;
  const children = node.children;
  if (children) {
    fn(children, node);
    for (const child of children) eachChildList(child, fn);
  }
}

/** Generic depth-first walk over a Babel AST node, with parent tracking. */
export function walkBabel(
  node: AnyNode | null | undefined,
  visit: (n: AnyNode, parent: AnyNode | null) => void,
  parent: AnyNode | null = null,
): void {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visit(node, parent);
  // Recurse into every child node/array.  Non-node values (strings, numbers,
  // `loc`) are skipped by the `typeof type === 'string'` guard on re-entry.
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walkBabel(item as AnyNode, visit, node);
    } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
      walkBabel(value as AnyNode, visit, node);
    }
  }
}
