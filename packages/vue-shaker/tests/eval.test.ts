import { describe, expect, it } from 'vitest';
import { evaluate, evaluateWithSets } from '../src/eval';
import { parseExpr } from '../src/parse';
import type { Literal } from '../src/ir';

const E = (src: string, env: Record<string, Literal> = {}) =>
  evaluate(parseExpr(src), new Map(Object.entries(env)));

describe('evaluate', () => {
  it('folds literals (Babel split-literal node kinds)', () => {
    expect(E("'a'")).toEqual({ known: true, value: 'a' });
    expect(E('42')).toEqual({ known: true, value: 42 });
    expect(E('true')).toEqual({ known: true, value: true });
    expect(E('null')).toEqual({ known: true, value: null });
  });

  it('reads the environment, leaves unknown identifiers unknown', () => {
    expect(E('x', { x: 5 })).toEqual({ known: true, value: 5 });
    expect(E('y')).toEqual({ known: false });
    expect(E('undefined')).toEqual({ known: true, value: undefined });
  });

  it('folds unary / binary / logical operators', () => {
    expect(E('!false')).toEqual({ known: true, value: true });
    expect(E('1 + 2')).toEqual({ known: true, value: 3 });
    expect(E("'a' === 'b'")).toEqual({ known: true, value: false });
    expect(E('x && 2', { x: true })).toEqual({ known: true, value: 2 });
  });

  it('is total — never throws on unsupported nodes', () => {
    expect(E('foo()')).toEqual({ known: false });
    expect(E('a.b.c')).toEqual({ known: false });
  });
});

describe('evaluateWithSets (L1.5 Kleene narrowing)', () => {
  const sets = (o: Record<string, Literal[]>) => new Map(Object.entries(o));

  it('proves a branch dead for the whole value set', () => {
    const r = evaluateWithSets(
      parseExpr("v === 'danger'"),
      new Map(),
      sets({ v: ['primary', 'secondary'] }),
    );
    expect(r).toEqual({ known: true, value: false }); // never danger
  });

  it('keeps a branch that some set member can take', () => {
    const r = evaluateWithSets(
      parseExpr("v === 'primary'"),
      new Map(),
      sets({ v: ['primary', 'secondary'] }),
    );
    expect(r).toEqual({ known: false }); // depends on the runtime value
  });

  it('honors loose vs strict equality coercion', () => {
    // `{0,1}` with `n == false` really matches 0, so it must stay unknown.
    const loose = evaluateWithSets(parseExpr('n == false'), new Map(), sets({ n: [0, 1] }));
    expect(loose).toEqual({ known: false });
    const strict = evaluateWithSets(parseExpr('n === false'), new Map(), sets({ n: [0, 1] }));
    expect(strict).toEqual({ known: true, value: false }); // numbers never === false
  });
});
