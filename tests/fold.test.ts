// `fold`, a core operation the machine handles with a FoldK frame
// (DECISIONS.md, Spec changes, 2026-10-02).

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ErrorValue, State, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { emptyEnv } from '../src/env.ts';
import { LoadError } from '../src/errors.ts';
import { print } from '../src/printer.ts';
import { int, listToArray } from '../src/values.ts';
import { kontDepth, resumeValue, run, startExpr, step } from '../src/machine.ts';
import { traceEntries } from '../src/core.ts';

function start(src: string): State {
    const [expr] = expand(read(`(do ${src})`, 'test'), 'expr');
    return startExpr(expr!, emptyEnv());
}

function value(src: string): string {
    const s = run(start(src), 100_000);
    assert.equal(s.mode.m, 'done', s.mode.m === 'failed' ? print(s.mode.e) : s.mode.m);
    return print((s.mode as { m: 'done'; v: Value }).v);
}

function failure(src: string): ErrorValue {
    const s = run(start(src), 100_000);
    assert.equal(s.mode.m, 'failed');
    return (s.mode as { m: 'failed'; e: ErrorValue }).e;
}

// Steps to run `src` to the end, and the deepest K on the way.
function measure(src: string): { ticks: number; depth: number } {
    let s = start(src);
    let ticks = 0;
    let depth = 0;
    while (s.mode.m === 'eval' || s.mode.m === 'ret' || s.mode.m === 'throw') {
        s = step(s);
        ticks += 1;
        depth = Math.max(depth, kontDepth(s.K));
    }
    assert.equal(s.mode.m, 'done');
    return { ticks, depth };
}

const quoted = (n: number): string => `'(${Array.from({ length: n }, (_, i) => i).join(' ')})`;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

test('fold: applies f to the accumulator and each element, left to right', () => {
    assert.equal(value(`(fold (lambda (acc x) (cons x acc)) () '(1 2 3))`), '(3 2 1)');
    assert.equal(value(`(fold (lambda (acc x) (- acc x)) 10 '(1 2 3))`), '4');
});

test('fold: an empty list returns the accumulator without calling f', () => {
    assert.equal(value(`(fold (lambda (acc x) (throw (make-error :called "f" x))) :acc ())`), 'acc');
});

test('fold: a core operation works as f, and fold works as a value', () => {
    assert.equal(value(`(fold + 0 '(1 2 3 4))`), '10');
    assert.equal(value(`(apply fold (list + 0 '(1 2)))`), '3');
    assert.equal(value(`(let f fold) (f * 1 '(2 3 4))`), '24');
});

test('fold: f can be any closure, local procedures included', () => {
    assert.equal(value(`
        (defun count-if (keep? xs)
            (defun step (n x) (if (keep? x) (+ n 1) n))
            (fold step 0 xs))
        (count-if (lambda (x) (> x 1)) '(1 2 3 4))
    `), '3');
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('fold: one tick per element, plus the ticks of f', () => {
    // The body of (lambda (acc x) x) is one step; (+ acc x) is five.
    for (const [f, perElement] of [['(lambda (acc x) x)', 2], ['(lambda (acc x) (+ acc x))', 6]] as const) {
        const base = measure(`(fold ${f} 0 ())`).ticks;
        for (const n of [1, 10, 100]) {
            assert.equal(measure(`(fold ${f} 0 ${quoted(n)})`).ticks - base, n * perElement, `${f} over ${n}`);
        }
    }
});

test('fold: the continuation does not grow with the list', () => {
    const f = '(lambda (acc x) (+ acc x))';
    assert.equal(measure(`(fold ${f} 0 ${quoted(1000)})`).depth, measure(`(fold ${f} 0 ${quoted(2)})`).depth);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('fold: requires a procedure and a proper list', () => {
    assert.equal(failure(`(fold 1 0 '(1))`).tag.name, 'type-error');
    assert.equal(failure(`(fold + 0 5)`).tag.name, 'type-error');
    assert.equal(failure(`(fold + 0 (cons 1 2))`).tag.name, 'type-error');
    assert.equal(failure(`(apply fold (list + 0))`).tag.name, 'arity-error');
    assert.equal(failure(`(fold (lambda (x) x) 0 '(1))`).tag.name, 'arity-error');
});

test('fold: f is checked even when the list is empty', () => {
    assert.equal(failure(`(fold 1 0 ())`).tag.name, 'type-error');
});

test('fold: an error in f is catchable, and its trace passes through the fold', () => {
    assert.equal(value(`
        (catch (fold (lambda (acc x) (car x)) 0 '(1)) e (error-tag e))
    `), 'type-error');
    const e = failure(`
        (defun boom (acc x) (throw (make-error :boom "in f" x)))
        (defun walk (xs) (fold boom 0 xs))
        (walk '(1 2))
    `);
    const fns = listToArray(traceEntries(e))!.map((entry) => print(listToArray(entry)![0]!));
    assert.deepEqual(fns.slice(0, 2), ['boom', 'walk']);
});

test('fold: cannot be bound', () => {
    for (const src of ['(let fold 1)', '(defun fold (f acc xs) acc)', '((lambda (fold) fold) 1)']) {
        assert.throws(() => expand(read(`(do ${src})`, 'test'), 'expr'), LoadError, src);
    }
});

// ---------------------------------------------------------------------------
// Host requests and resuming
// ---------------------------------------------------------------------------

test('fold: a host request in f suspends the fold, and resuming continues it in order', () => {
    let s = run(start(`(fold (lambda (acc x) (+ acc (io::ask x))) 0 '(1 2 3))`), 1000);
    const asked: string[] = [];
    while (s.mode.m === 'host') {
        asked.push(print(s.mode.args[0]!));
        s = run(resumeValue(s, int(BigInt(10 * asked.length))), 1000);
    }
    assert.deepEqual(asked, ['1', '2', '3']);
    assert.equal(s.mode.m, 'done');
    assert.equal(print((s.mode as { m: 'done'; v: Value }).v), '60');
});

test('fold: a state in the middle of a fold can be resumed more than once', () => {
    // A parked continuation may be unparked any number of times, so the
    // FoldK frame must never be updated in place.
    const mid = run(start(`(fold (lambda (acc x) (+ acc (io::ask x))) 0 '(1 2 3))`), 1000);
    assert.equal(mid.mode.m, 'host');
    const finish = (answer: bigint): string => {
        let s = run(resumeValue(mid, int(answer)), 1000);
        while (s.mode.m === 'host') s = run(resumeValue(s, int(answer)), 1000);
        return print((s.mode as { m: 'done'; v: Value }).v);
    };
    assert.equal(finish(1n), '3');
    assert.equal(finish(100n), '300');
    assert.equal(finish(1n), '3');
});
