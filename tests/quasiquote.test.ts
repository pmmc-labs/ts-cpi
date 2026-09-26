// Quasiquote: the reader syntax, the expansion into cons and append, the
// append core operation, and evaluation end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { State, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { emptyEnv } from '../src/env.ts';
import { CORE } from '../src/core.ts';
import { startExpr, run } from '../src/machine.ts';
import { print } from '../src/printer.ts';
import { LoadError } from '../src/errors.ts';
import { int, list, sym, NIL } from '../src/values.ts';

const readOne = (src: string): string => print(read(src, 't')[0]!);
const expansion = (src: string): string => print(expand(read(src, 't'), 'expr')[0]!);

function evaluate(src: string): string {
    let s: State = startExpr(expand(read(src, 't'), 'expr')[0]!, emptyEnv());
    s = run(s, 100_000);
    if (s.mode.m === 'failed') return `failed: ${print(s.mode.e)}`;
    assert.equal(s.mode.m, 'done');
    return print((s.mode as { v: Value }).v);
}

function loadError(src: string, message: RegExp): void {
    assert.throws(() => expand(read(src, 't'), 'expr'), (e: unknown) => e instanceof LoadError && message.test(e.message));
}

test('reader: ` , and ,@ read as quasiquote forms', () => {
    assert.equal(readOne('`x'), '(quasiquote x)');
    assert.equal(readOne(',x'), '(unquote x)');
    assert.equal(readOne(',@x'), '(unquote-splicing x)');
    assert.equal(readOne('`(a ,b ,@c)'), '(quasiquote (a (unquote b) (unquote-splicing c)))');
});

test('reader: ` and , end a symbol, and the form carries the position of its mark', () => {
    assert.equal(readOne('(a,b c`d)'), '(a (unquote b) c (quasiquote d))');
    const form = read('  `x', 't')[0]!;
    assert.equal(form.t === 'pair' && form.pos?.col, 3);
    assert.throws(() => read('`', 't'), LoadError);
});

test('expansion: cons for elements, append for a splice, quote for constant parts', () => {
    assert.equal(expansion('`(a ,b)'), '(cons (quote a) (cons b ()))');
    assert.equal(expansion('`(a ,@b c)'), '(cons (quote a) (append b (cons (quote c) ())))');
    assert.equal(expansion('`(1 (2 3) ,x)'), '(cons 1 (cons (quote (2 3)) (cons x ())))');
    assert.equal(expansion('`(no unquotes)'), '(quote (no unquotes))');
    assert.equal(expansion('`sym'), '(quote sym)');
    assert.equal(expansion('`42'), '42');
});

test('expansion: a splice at the end is the tail itself, with no copy', () => {
    assert.equal(expansion('`(a ,@xs)'), '(cons (quote a) xs)');
    assert.equal(expansion('`(,@xs)'), 'xs');
});

test('expansion: unquoted expressions are expanded like any expression', () => {
    assert.equal(expansion('`(,(if p 1 2))'), '(cons (cond (p 1) (#true 2)) ())');
});

test('errors: unquote outside quasiquote, splicing outside a list, nesting, bad shapes', () => {
    loadError(',x', /unquote may appear only inside a quasiquote/);
    loadError('(f ,@xs)', /unquote-splicing may appear only inside a quasiquote/);
    loadError('`,@xs', /unquote-splicing must be an element of a list/);
    loadError('`(a `(b ,c))', /nested quasiquote is not supported/);
    loadError('(quasiquote a b)', /quasiquote requires exactly one template/);
    loadError('`(a (unquote b c))', /unquote requires exactly one expression/);
    loadError('(do (let quasiquote 1))', /reserved/);
});

test('append: copies the first list onto the second', () => {
    const append = CORE.get('append')!;
    const r = append.fn([list(int(1), int(2)), list(int(3))]);
    assert.ok(r.ok);
    assert.equal(print(r.v), '(1 2 3)');
    const empty = append.fn([NIL, sym('tail')]);
    assert.ok(empty.ok && empty.v === sym('tail'));
    const bad = append.fn([sym('x'), NIL]);
    assert.ok(!bad.ok && bad.e.tag.name === 'type-error');
});

test('evaluation: views and lists built with quasiquote', () => {
    assert.equal(evaluate(`
        (do (let gen 4)
            (let rows '((Text "a") (Text "b")))
            \`(Box (@ (gap 1)) (Text "generation " ,gen) ,@rows))`),
        '(Box (@ (gap 1)) (Text "generation " 4) (Text "a") (Text "b"))');
    assert.equal(evaluate('(do (let xs (quote (1 2))) `(0 ,@xs 3 ,@xs))'), '(0 1 2 3 1 2)');
    assert.equal(evaluate('`(a ,@(quote b))'), '(a . b)');
    assert.equal(evaluate('(append (quote (1)) (quote (2)))'), '(1 2)');
    assert.match(evaluate('`(,@1 x)'), /failed: #<error type-error/);
});

test('append in value position is eta-expanded like any core operation', () => {
    assert.equal(evaluate('((lambda (f) (f (quote (1)) (quote (2)))) append)'), '(1 2)');
});
