// `list`, variadic `string-append`, `string-join`, `rethrow` and vectors
// (DECISIONS.md, Spec changes, 2026-09-27).

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ErrorValue, State, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { emptyEnv } from '../src/env.ts';
import { LoadError } from '../src/errors.ts';
import { print } from '../src/printer.ts';
import { run, startExpr } from '../src/machine.ts';
import { traceEntries } from '../src/core.ts';

function run1(src: string): State {
    const [expr] = expand(read(`(do ${src})`, 'test'), 'expr');
    return run(startExpr(expr!, emptyEnv()), 10_000);
}

function value(src: string): string {
    const s = run1(src);
    assert.equal(s.mode.m, 'done', s.mode.m === 'failed' ? print(s.mode.e) : s.mode.m);
    return print((s.mode as { m: 'done'; v: Value }).v);
}

function failure(src: string): ErrorValue {
    const s = run1(src);
    assert.equal(s.mode.m, 'failed');
    return (s.mode as { m: 'failed'; e: ErrorValue }).e;
}

function tag(src: string): string {
    return failure(src).tag.name;
}

function loadError(src: string): void {
    assert.throws(() => expand(read(`(do ${src})`, 'test'), 'expr'), LoadError);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list: builds a list of its arguments, evaluated in order', () => {
    assert.equal(value('(list 1 (+ 1 1) "three" :four)'), '(1 2 "three" four)');
    assert.equal(value('(list)'), '()');
    assert.equal(value('(list (list 1 2) ())'), '((1 2) ())');
});

test('list: a variadic core operation cannot be used as a value', () => {
    loadError('(apply list (quote (1 2)))');
    loadError('(let f list)');
});

test('list: cannot be bound', () => {
    loadError('(let list 1)');
    loadError('((lambda (list) list) 1)');
});

// ---------------------------------------------------------------------------
// string-append
// ---------------------------------------------------------------------------

test('string-append: joins any number of strings', () => {
    assert.equal(value('(string-append "a" "b" "c" "d")'), '"abcd"');
    assert.equal(value('(string-append "a" "b")'), '"ab"');
    assert.equal(value('(string-append "only")'), '"only"');
    assert.equal(value('(string-append)'), '""');
});

test('string-append: every argument must be a string', () => {
    assert.equal(tag('(string-append "a" "b" 3)'), 'type-error');
    assert.equal(tag('(string-append :a)'), 'type-error');
});

test('string-append: is no longer usable as a value', () => {
    loadError('(let f string-append)');
});

// ---------------------------------------------------------------------------
// string-join
// ---------------------------------------------------------------------------

test('string-join: separator first, like Perl', () => {
    assert.equal(value('(string-join ", " (list "a" "b" "c"))'), '"a, b, c"');
    assert.equal(value('(string-join "" (list "a" "b"))'), '"ab"');
    assert.equal(value('(string-join "-" (list "solo"))'), '"solo"');
    assert.equal(value('(string-join "-" ())'), '""');
});

test('string-join: strings only', () => {
    assert.equal(tag('(string-join ", " (list "a" 2))'), 'type-error');
    assert.equal(tag('(string-join 1 (list "a"))'), 'type-error');
    assert.equal(tag('(string-join "," "abc")'), 'type-error');
    assert.equal(tag('(string-join "," (cons "a" "b"))'), 'type-error');
});

test('string-join: has a fixed arity and works as a value', () => {
    assert.equal(tag('(string-join ",")'), 'arity-error');
    assert.equal(value('(apply string-join (list "+" (list "1" "2")))'), '"1+2"');
});

// ---------------------------------------------------------------------------
// rethrow
// ---------------------------------------------------------------------------

test('rethrow: passes a caught error on unchanged', () => {
    const e = failure(`
        (catch
            (throw (make-error :boom "first" 7))
            e
            (rethrow e))
    `);
    assert.equal(e.tag.name, 'boom');
    assert.equal(print(e.payload), '7');
});

test('rethrow: keeps the context of the first throw', () => {
    assert.equal(value(`
        (defun thrower () (throw (make-error :boom "first" 7)))
        (defun passer (e) (rethrow e))
        (catch
            (thrower)
            e
            (do
                (let before (value->string (stack-trace-for e)))
                (catch (passer e) e2 (list (eq? e e2) (eq? before (value->string (stack-trace-for e2)))))))
    `), '(#true #true)');
});

test('rethrow: the trace still points at the original throw', () => {
    const src = `
        (defun inner () (throw (make-error :boom "deep" ())))
        (catch (inner) e (rethrow e))
    `;
    const e = failure(src);
    const trace = print(traceEntries(e));
    assert.match(trace, /^\(\(inner /);
});

test('rethrow: an error never thrown is bad-state', () => {
    assert.equal(tag('(rethrow (make-error :x "never" ()))'), 'bad-state');
});

test('rethrow: requires an error', () => {
    assert.equal(tag('(rethrow 5)'), 'type-error');
});

test('rethrow: can pass the same error on more than once', () => {
    const e = failure(`
        (catch
            (catch (throw (make-error :boom "x" ())) e (rethrow e))
            e
            (rethrow e))
    `);
    assert.equal(e.tag.name, 'boom');
});

test('throw: still refuses an error that was already thrown', () => {
    assert.equal(tag('(catch (throw (make-error :a "x" ())) e (throw e))'), 'already-thrown');
});

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

test('vector: builds a vector and prints it as #(...)', () => {
    assert.equal(value('(vector 1 "two" :three (list 4))'), '#(1 "two" three (4))');
    assert.equal(value('(vector)'), '#()');
});

test('vector: value->string uses the printed form', () => {
    assert.equal(value('(value->string (vector 1 2))'), '"#(1 2)"');
});

test('vector?: recognizes vectors only', () => {
    assert.equal(value('(list (vector? (vector)) (vector? (list 1)) (vector? ()) (pair? (vector 1)))'),
        '(#true #false #false #false)');
});

test('make-vector: n copies of fill', () => {
    assert.equal(value('(make-vector 3 0)'), '#(0 0 0)');
    assert.equal(value('(make-vector 0 :x)'), '#()');
    assert.equal(tag('(make-vector -1 0)'), 'range-error');
    assert.equal(tag('(make-vector "3" 0)'), 'type-error');
});

test('vector-length and vector-ref', () => {
    assert.equal(value('(vector-length (vector 1 2 3))'), '3');
    assert.equal(value('(vector-ref (vector :a :b :c) 2)'), 'c');
    assert.equal(tag('(vector-ref (vector :a) 1)'), 'range-error');
    assert.equal(tag('(vector-ref (vector :a) -1)'), 'range-error');
    assert.equal(tag('(vector-ref (list :a) 0)'), 'type-error');
    assert.equal(tag('(vector-ref (vector :a) "0")'), 'type-error');
    assert.equal(tag('(vector-length (list 1))'), 'type-error');
});

test('vector-set: returns a new vector and leaves the old one alone', () => {
    assert.equal(value(`
        (let v (vector 1 2 3))
        (let w (vector-set v 1 :x))
        (list v w (eq? v w))
    `), '(#(1 2 3) #(1 x 3) #false)');
    assert.equal(tag('(vector-set (vector 1) 1 0)'), 'range-error');
    assert.equal(tag('(vector-set (list 1) 0 0)'), 'type-error');
});

test('list->vector and vector->list', () => {
    assert.equal(value('(list->vector (list 1 2 3))'), '#(1 2 3)');
    assert.equal(value('(list->vector ())'), '#()');
    assert.equal(value('(vector->list (vector 1 2 3))'), '(1 2 3)');
    assert.equal(tag('(list->vector (cons 1 2))'), 'type-error');
    assert.equal(tag('(vector->list (list 1))'), 'type-error');
});

test('eq?: vectors compare by identity', () => {
    assert.equal(value('(let v (vector 1)) (list (eq? v v) (eq? (vector 1) (vector 1)))'), '(#true #false)');
});

test('vector: a variadic core operation cannot be used as a value', () => {
    loadError('(let f vector)');
});
