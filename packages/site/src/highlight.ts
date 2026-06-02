// Syntax highlighting (Shiki) + a small line-level diff, shared by the
// playground's editor overlay and its "what was shaken" diff view.
//
// Uses Shiki's fine-grained core bundle with ONLY the Vue grammar + one theme,
// so the build doesn't emit a chunk for every bundled language (the full `shiki`
// entry would split out emacs-lisp, etc.).
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

const THEME = 'github-dark-default';

export type CodeHighlighter = HighlighterCore;

let loading: Promise<HighlighterCore> | null = null;

/** Lazily create the singleton Shiki highlighter (Vue grammar + dark theme). */
export function loadHighlighter(): Promise<HighlighterCore> {
  if (!loading) {
    loading = createHighlighterCore({
      themes: [import('shiki/themes/github-dark-default.mjs')],
      langs: [import('shiki/langs/vue.mjs')],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  }
  return loading;
}

/** One rendered line: a run of colored tokens. */
export type Line = ThemedToken[];

/** Tokenize `code` into per-line colored tokens (whole-file context kept). */
export function tokenize(hl: HighlighterCore, code: string): Line[] {
  return hl.codeToTokens(code, { lang: 'vue', theme: THEME }).tokens;
}

export type DiffKind = 'ctx' | 'del' | 'add';
export interface DiffRow {
  kind: DiffKind;
  line: Line;
}

/**
 * A unified line diff of `before` -> `after`, each row carrying its Shiki
 * tokens.  `del` rows are taken from `before` (what the shake removed), `add`
 * rows from `after` (what it introduced — e.g. a demoted `const`), `ctx` rows
 * are unchanged.  Uses a classic LCS so deletions/insertions line up.
 */
export function diffRows(hl: HighlighterCore, before: string, after: string): DiffRow[] {
  const aText = before.split('\n');
  const bText = after.split('\n');
  const aTok = tokenize(hl, before);
  const bTok = tokenize(hl, after);

  const n = aText.length;
  const m = bText.length;
  // dp[i][j] = LCS length of aText[i:] and bText[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = aText[i] === bText[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aText[i] === bText[j]) {
      rows.push({ kind: 'ctx', line: aTok[i] ?? [] });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: 'del', line: aTok[i] ?? [] });
      i++;
    } else {
      rows.push({ kind: 'add', line: bTok[j] ?? [] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', line: aTok[i++] ?? [] });
  while (j < m) rows.push({ kind: 'add', line: bTok[j++] ?? [] });
  return rows;
}
