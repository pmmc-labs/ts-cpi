import test from 'node:test';
import assert from 'node:assert/strict';

import type { Value } from '../src/types.ts';
import { cons, list, sym, str, int, NIL, TRUE } from '../src/values.ts';
import { LoadError } from '../src/errors.ts';
import { expand } from '../src/expander.ts';

const S = sym;
const POS = { file: 'f.sl', line: 1, col: 1 };
const OTHER_POS = { file: 'f.sl', line: 9, col: 9 };

// Structural equality that ignores `pos`, so tests can focus on shape.
function eq(a: Value, b: Value): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'sym':
      return b.t === 'sym' && a.name === b.name;
    case 'bool':
      return b.t === 'bool' && a.v === b.v;
    case 'nil':
      return b.t === 'nil';
    case 'int':
      return b.t === 'int' && a.v === b.v;
    case 'float':
      return b.t === 'float' && a.v === b.v;
    case 'str':
      return b.t === 'str' && a.v === b.v;
    case 'pair':
      return b.t === 'pair' && eq(a.car, b.car) && eq(a.cdr, b.cdr);
    default:
      throw new Error(`unexpected value in test data: ${a.t}`);
  }
}

// A JSON-safe rendering for failure messages (Value has bigints in it).
function toPlain(v: Value): unknown {
  switch (v.t) {
    case 'pair':
      return [toPlain(v.car), toPlain(v.cdr)];
    case 'int':
      return v.v.toString();
    default:
      return v;
  }
}

function assertShape(actual: Value, expected: Value, message?: string) {
  assert.ok(
    eq(actual, expected),
    message ?? `expected structural match:\n  actual:   ${JSON.stringify(toPlain(actual))}\n  expected: ${JSON.stringify(toPlain(expected))}`,
  );
}

// Collects every gensym produced in a tree (symbols spelled `#:...`).
function findGensyms(v: Value, out: string[] = []): string[] {
  if (v.t === 'sym' && v.name.startsWith('#:')) out.push(v.name);
  if (v.t === 'pair') {
    findGensyms(v.car, out);
    findGensyms(v.cdr, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File mode: top-level shape
// ---------------------------------------------------------------------------

test('file mode accepts defun and const at top level', () => {
  const defun = list(S('defun'), S('f'), list(S('x')), S('x'));
  const konst = list(S('const'), S('c'), int(1n));
  const [outDefun, outConst] = expand([defun, konst], 'file');
  assertShape(outDefun!, list(S('defun'), S('f'), list(S('x')), S('x')));
  assertShape(outConst!, list(S('const'), S('c'), int(1n)));
});

test('file mode rejects a bare expression at top level', () => {
  assert.throws(() => expand([list(S('+'), int(1n), int(2n))], 'file'), LoadError);
});

test('file mode rejects const with wrong shape', () => {
  assert.throws(() => expand([list(S('const'), S('c'))], 'file'), LoadError);
});

test('file mode rejects defun with wrong shape', () => {
  assert.throws(() => expand([list(S('defun'), S('f'))], 'file'), LoadError);
});

// ---------------------------------------------------------------------------
// Expr mode
// ---------------------------------------------------------------------------

test('expr mode expands a plain expression', () => {
  const [out] = expand([list(S('+'), int(1n), int(2n))], 'expr');
  assertShape(out!, list(S('+'), int(1n), int(2n)));
});

test('expr mode rejects a top-level defun (not top-level file, not inside a body)', () => {
  assert.throws(() => expand([list(S('defun'), S('f'), list(), int(1n))], 'expr'), LoadError);
});

test('expr mode rejects a top-level const', () => {
  assert.throws(() => expand([list(S('const'), S('c'), int(1n))], 'expr'), LoadError);
});

// ---------------------------------------------------------------------------
// Derived forms (SPEC-CPI 4.1)
// ---------------------------------------------------------------------------

test('if expands to cond with #true else clause', () => {
  const input = list(S('if'), S('test'), S('then'), S('else-val'));
  const [out] = expand([input], 'expr');
  const expected = list(
    S('cond'),
    list(S('test'), S('then')),
    list(TRUE, S('else-val')),
  );
  assertShape(out!, expected);
});

test('if requires exactly test, then, and else', () => {
  assert.throws(() => expand([list(S('if'), S('test'), S('then'))], 'expr'), LoadError);
});

test('when expands to a single cond clause wrapped in do', () => {
  const input = list(S('when'), S('test'), S('a'), S('b'));
  const [out] = expand([input], 'expr');
  const expected = list(S('cond'), list(S('test'), list(S('do'), S('a'), S('b'))));
  assertShape(out!, expected);
});

test('case binds the topic with a gensym and rewrites to do/let/cond', () => {
  const input = list(
    S('case'),
    S('topic'),
    list(int(1n), S('one')),
    list(S('else'), S('other')),
  );
  const [out] = expand([input], 'expr');

  // Structure: (do (let t topic) (cond ((eq? t 1) one) (#true other)))
  assert.equal(out!.t, 'pair');
  const doElems = mustList(out!);
  assertShape(doElems[0]!, S('do'));
  const letForm = mustList(doElems[1]!);
  assertShape(letForm[0]!, S('let'));
  const t = letForm[1]!;
  assert.equal(t.t, 'sym');
  assert.ok((t as { name: string }).name.startsWith('#:case'));
  assertShape(letForm[2]!, S('topic'));

  const condForm = mustList(doElems[2]!);
  assertShape(condForm[0]!, S('cond'));
  const clause1 = mustList(condForm[1]!);
  const test1 = mustList(clause1[0]!);
  assertShape(test1[0]!, S('eq?'));
  assertShape(test1[1]!, t);
  assertShape(test1[2]!, int(1n));
  assertShape(clause1[1]!, S('one'));

  const clause2 = mustList(condForm[2]!);
  assertShape(clause2[0]!, TRUE);
  assertShape(clause2[1]!, S('other'));
});

test('case gensym uses the case hint and is fresh across expansions', () => {
  const input1 = list(S('case'), int(1n), list(int(1n), S('a')));
  const input2 = list(S('case'), int(1n), list(int(1n), S('a')));
  const [out1] = expand([input1], 'expr');
  const [out2] = expand([input2], 'expr');
  const g1 = findGensyms(out1!)[0]!;
  const g2 = findGensyms(out2!)[0]!;
  assert.ok(g1.startsWith('#:case'));
  assert.notEqual(g1, g2);
});

test('case rejects an else clause that is not last', () => {
  const input = list(
    S('case'),
    S('topic'),
    list(S('else'), S('x')),
    list(int(1n), S('y')),
  );
  assert.throws(() => expand([input], 'expr'), LoadError);
});

function mustList(v: Value): Value[] {
  const out: Value[] = [];
  let cur = v;
  while (cur.t === 'pair') {
    out.push(cur.car);
    cur = cur.cdr;
  }
  assert.equal(cur.t, 'nil');
  return out;
}

// ---------------------------------------------------------------------------
// Core operations in value position (SPEC-CPI 5.1)
// ---------------------------------------------------------------------------

test('core operation in value position is eta-expanded', () => {
  const input = list(S('list'), S('+'));
  const [out] = expand([input], 'expr');
  const elems = mustList(out!);
  assertShape(elems[0]!, S('list'));
  const lam = mustList(elems[1]!);
  assertShape(lam[0]!, S('lambda'));
  const params = mustList(lam[1]!);
  assert.equal(params.length, 2); // '+' has arity 2
  for (const p of params) assert.equal(p.t, 'sym');
  const call = mustList(lam[2]!);
  assertShape(call[0]!, S('+'));
  assertShape(call[1]!, params[0]!);
  assertShape(call[2]!, params[1]!);
});

test('core operation in head position is a plain application, not eta-expanded', () => {
  const input = list(S('+'), int(1n), int(2n));
  const [out] = expand([input], 'expr');
  assertShape(out!, list(S('+'), int(1n), int(2n)));
});

test('core operation arity for a unary op is 1', () => {
  const input = list(S('list'), S('not'));
  const [out] = expand([input], 'expr');
  const elems = mustList(out!);
  const lam = mustList(elems[1]!);
  const params = mustList(lam[1]!);
  assert.equal(params.length, 1);
});

// ---------------------------------------------------------------------------
// Reserved names (SPEC-CPI section 4; task's reserved-name rule)
// ---------------------------------------------------------------------------

test('binding a core name as a lambda parameter is a load-error', () => {
  const input = list(S('lambda'), list(S('+')), S('+'));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('binding a special-form name as a defun parameter is a load-error', () => {
  const input = list(S('defun'), S('f'), list(S('let')), int(1n));
  assert.throws(() => expand([input], 'file'), LoadError);
});

test('binding a reserved name with let is a load-error', () => {
  const input = list(S('do'), list(S('let'), S('cond'), int(1n)), int(1n));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('binding a reserved name as a defun name is a load-error', () => {
  assert.throws(() => expand([list(S('defun'), S('cond'), list(), int(1n))], 'file'), LoadError);
});

test('binding a reserved name as a const name is a load-error', () => {
  assert.throws(() => expand([list(S('const'), S('lambda'), int(1n))], 'file'), LoadError);
});

test('binding a reserved name as the catch variable is a load-error', () => {
  const input = list(S('catch'), int(1n), S('throw'), int(2n));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('a host (::) name used anywhere but the head of an application is a load-error', () => {
  const input = list(S('list'), S('IO::print'));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('a host (::) name in head position is fine', () => {
  const input = list(S('IO::print'), str('hi'));
  const [out] = expand([input], 'expr');
  assertShape(out!, list(S('IO::print'), str('hi')));
});

// ---------------------------------------------------------------------------
// Placement (SPEC-CPI section 4)
// ---------------------------------------------------------------------------

test('let outside a body is a load-error', () => {
  const input = list(S('and'), list(S('let'), S('x'), int(1n)), S('x'));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('let as the cond-clause test position is a load-error', () => {
  const input = list(S('cond'), list(list(S('let'), S('x'), int(1n)), S('x')));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('local defun outside a body is a load-error', () => {
  const input = list(S('cons'), list(S('defun'), S('f'), list(), int(1n)), int(2n));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

test('local defun inside a lambda body is allowed', () => {
  const input = list(
    S('lambda'),
    list(),
    list(S('defun'), S('f'), list(), int(1n)),
    list(S('f')),
  );
  const [out] = expand([input], 'expr');
  const elems = mustList(out!);
  assertShape(elems[0]!, S('lambda'));
  const localDefun = mustList(elems[2]!);
  assertShape(localDefun[0]!, S('defun'));
});

test('const outside the top level of a file is a load-error', () => {
  const input = list(S('do'), list(S('const'), S('c'), int(1n)), int(2n));
  assert.throws(() => expand([input], 'expr'), LoadError);
  assert.throws(() => expand([input], 'file'), LoadError);
});

test('defun outside a body and not top-level is a load-error in file mode too', () => {
  // A defun nested directly as a cond test (not a body element).
  const input = list(S('cond'), list(list(S('defun'), S('f'), list(), int(1n))));
  assert.throws(() => expand([input], 'expr'), LoadError);
});

// ---------------------------------------------------------------------------
// catch shape (SPEC-CPI section 4)
// ---------------------------------------------------------------------------

test('catch requires exactly a body, a name, and a handler', () => {
  assert.throws(() => expand([list(S('catch'), int(1n), S('e'))], 'expr'), LoadError);
  assert.throws(() => expand([list(S('catch'), int(1n), S('e'), int(2n), int(3n))], 'expr'), LoadError);
});

test('a well-formed catch expands its body and handler', () => {
  const input = list(S('catch'), list(S('+'), int(1n), int(2n)), S('e'), S('e'));
  const [out] = expand([input], 'expr');
  const expected = list(S('catch'), list(S('+'), int(1n), int(2n)), S('e'), S('e'));
  assertShape(out!, expected);
});

// ---------------------------------------------------------------------------
// Positions survive expansion
// ---------------------------------------------------------------------------

test('position is preserved on an unrewritten application', () => {
  const input = cons(S('+'), cons(int(1n), cons(int(2n), NIL, null), null), POS);
  const [out] = expand([input], 'expr');
  assert.equal(out!.t, 'pair');
  assert.deepEqual((out as { pos: unknown }).pos, POS);
});

test('position is preserved on a derived form rewritten to cond', () => {
  // else-val is itself a compound form `(else-val)`, carrying OTHER_POS: a
  // bare symbol has no position of its own to preserve.
  const elseForm = cons(S('else-val'), NIL, OTHER_POS);
  const input = cons(
    S('if'),
    cons(S('test'), cons(S('then'), cons(elseForm, NIL, null), null), null),
    POS,
  );
  const [out] = expand([input], 'expr');
  assert.equal(out!.t, 'pair');
  assert.deepEqual((out as { pos: unknown }).pos, POS);
  // The synthesized clause carries the position of the original else form.
  const elems = mustList(out!);
  const clause2 = elems[2]!;
  assert.equal(clause2.t, 'pair');
  assert.deepEqual((clause2 as { pos: unknown }).pos, OTHER_POS);
});

test('quote leaves its datum untouched, including reserved-looking names', () => {
  const datum = list(S('cond'), S('+'), S('IO::print'));
  const input = list(S('quote'), datum);
  const [out] = expand([input], 'expr');
  assertShape(out!, list(S('quote'), datum));
});

test('quote requires exactly one datum', () => {
  assert.throws(() => expand([list(S('quote'))], 'expr'), LoadError);
  assert.throws(() => expand([list(S('quote'), int(1n), int(2n))], 'expr'), LoadError);
});
