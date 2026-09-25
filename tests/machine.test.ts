import test from 'node:test';
import assert from 'node:assert/strict';

import type { Closure, Env, Frame, State, Sym, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { emptyEnv, fromBindings } from '../src/env.ts';
import { int, listToArray, sym, NIL } from '../src/values.ts';
import { makeError } from '../src/errors.ts';
import { print } from '../src/printer.ts';
import { kontDepth, resume, resumeThrow, resumeValue, run, start, startExpr, step } from '../src/machine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Wraps `src` in `(do ...)` (a top-level bare `let`/`defun` is a load-error
// in 'expr' mode, per the manager's note), expands it as a single expression,
// and runs it to a fixed point or the step limit.
function run1(src: string, R: Env = emptyEnv(), limit = 10_000): State {
    const forms = read(`(do ${src})`, 'test');
    const [expr] = expand(forms, 'expr');
    const s0 = startExpr(expr!, R);
    return run(s0, limit);
}

// Builds a global-style closure (group: null) from a top-level `(defun ...)`
// source string, the way the loader would (SPEC-CPI section 9), without
// going through the full loader.
function globalClosure(src: string): { closure: Closure; name: Sym } {
    const [form] = expand(read(src, 'test'), 'file');
    const arr = listToArray(form!)!; // [sym('defun'), name, paramsForm, ...body]
    const name = arr[1] as Sym;
    const params = listToArray(arr[2]!) as Sym[];
    const body = arr.slice(3);
    const closure: Closure = { t: 'closure', name, params, body, scope: null, group: null };
    return { closure, name };
}

function done(s: State): Value {
    assert.equal(s.mode.m, 'done', s.mode.m === 'failed' ? print(s.mode.e) : s.mode.m);
    return (s.mode as { m: 'done'; v: Value }).v;
}

function failed(s: State): { tag: string; payload: Value; e: import('../src/types.ts').ErrorValue } {
    assert.equal(s.mode.m, 'failed');
    const e = (s.mode as { m: 'failed'; e: import('../src/types.ts').ErrorValue }).e;
    return { tag: e.tag.name, payload: e.payload, e };
}

// ---------------------------------------------------------------------------
// Special forms
// ---------------------------------------------------------------------------

test('quote returns the datum unevaluated', () => {
    const s = run1("(quote (1 2 3))");
    assert.equal(print(done(s)), '(1 2 3)');
});

test('lambda: anonymous closure application', () => {
    const s = run1('((lambda (x y) (+ x y)) 3 4)');
    assert.equal(print(done(s)), '7');
});

test('defun: local group of one, self-recursive', () => {
    const s = run1(`
        (defun fact (n) (if (eq? n 0) 1 (* n (fact (- n 1)))))
        (fact 5)
    `);
    assert.equal(print(done(s)), '120');
});

test('let: binds for the rest of the body', () => {
    const s = run1('(let x 5) (+ x 1)');
    assert.equal(print(done(s)), '6');
});

test('do: empty do is nil, sequencing returns the last value', () => {
    assert.equal(print(done(run1('(do)'))), '()');
    assert.equal(print(done(run1('(do 1 2 3)'))), '3');
});

test('cond: first non-false test wins; empty body returns the test value; no match is nil', () => {
    assert.equal(print(done(run1('(cond (#false 1) (#true 2))'))), '2');
    assert.equal(print(done(run1('(cond (5))'))), '5');
    assert.equal(print(done(run1('(cond (#false 1))'))), '()');
    assert.equal(print(done(run1('(cond)'))), '()');
});

test('and: stops at first #false, else last value; (and) is #true', () => {
    assert.equal(print(done(run1('(and 1 2 3)'))), '3');
    assert.equal(print(done(run1('(and 1 #false 3)'))), '#false');
    assert.equal(print(done(run1('(and)'))), '#true');
});

test('or: stops at first non-#false value; (or) is #false', () => {
    assert.equal(print(done(run1('(or #false #false 5)'))), '5');
    assert.equal(print(done(run1('(or)'))), '#false');
});

test('catch: binds the error and evaluates the handler', () => {
    const s = run1('(catch (throw (make-error :boom "bad" 42)) e (error-payload e))');
    assert.equal(print(done(s)), '42');
});

test('catch: a successful body just returns its value', () => {
    const s = run1('(catch 5 e 99)');
    assert.equal(print(done(s)), '5');
});

// Derived forms (if/when/case), sanity: the expander rewrites these to cond,
// so this also exercises cond's tail positions.
test('derived forms: if, when, case', () => {
    assert.equal(print(done(run1('(if #true 1 2)'))), '1');
    assert.equal(print(done(run1('(if #false 1 2)'))), '2');
    assert.equal(print(done(run1('(when #true 1 2)'))), '2');
    assert.equal(print(done(run1('(when #false 1 2)'))), '()');
    assert.equal(print(done(run1('(case 2 (1 :one) (2 :two) (else :other))'))), 'two');
    assert.equal(print(done(run1('(case 9 (1 :one) (else :other))'))), 'other');
});

// ---------------------------------------------------------------------------
// Errors: wrap-error, already-thrown, unbound, arity, type
// ---------------------------------------------------------------------------

test('wrap-error: a fresh error distinct from the one it wraps', () => {
    const s = run1(`
        (catch
            (throw (make-error :a "first" 1))
            e
            (throw (wrap-error e :b "second" 2)))
    `);
    const { tag, e } = failed(s);
    assert.equal(tag, 'b');
    assert.equal(e.cause?.tag.name, 'a');
});

test('already-thrown: rethrowing the same error object', () => {
    const s = run1(`
        (catch
            (throw (make-error :a "first" 1))
            e
            (throw e))
    `);
    const { tag, payload } = failed(s);
    assert.equal(tag, 'already-thrown');
    assert.equal(payload.t, 'error');
    assert.equal((payload as { tag: Sym }).tag.name, 'a');
});

test('unbound: throws unbound with the symbol as payload', () => {
    const s = run1('undefined-name');
    const { tag, payload } = failed(s);
    assert.equal(tag, 'unbound');
    assert.equal(payload, sym('undefined-name'));
});

test('arity-error: core operation', () => {
    const s = run1('(+ 1)');
    assert.equal(failed(s).tag, 'arity-error');
});

test('arity-error: closure application', () => {
    const s = run1('((lambda (x y) x) 1)');
    assert.equal(failed(s).tag, 'arity-error');
});

test('type-error: applying a non-procedure', () => {
    const s = run1('(5 1 2)');
    assert.equal(failed(s).tag, 'type-error');
});

test('apply: applies a closure to a list of arguments, and checks its arity', () => {
    const ok = run1('(apply (lambda (a b) (+ a b)) (cons 3 (cons 4 ())))');
    assert.equal(print(done(ok)), '7');
    const bad = run1('(apply (lambda (a b) (+ a b)) (cons 3 ()))');
    assert.equal(failed(bad).tag, 'arity-error');
});

test('trace: stack-trace-for shows the throwing procedure, and elides tail calls', () => {
    const s = run1(`
        (defun boom (x) (throw (make-error :oops "boom" x)))
        (defun caller (x) (boom x))
        (catch (caller 1) e (stack-trace-for e))
    `);
    const entries = listToArray(done(s))!;
    // caller's call to boom is a tail call, so caller leaves no trace entry;
    // the innermost (first) entry names boom.
    const first = listToArray(entries[0]!)!;
    assert.equal((first[0] as Sym).name, 'boom');
    for (const entry of entries) {
        const fields = listToArray(entry)!;
        assert.notEqual((fields[0] as Sym | { t: 'bool' }), sym('caller'));
    }
});

// ---------------------------------------------------------------------------
// Tail calls and local defun groups
// ---------------------------------------------------------------------------

test('mutual recursion in a local defun group', () => {
    const s = run1(`
        (defun even? (n) (if (eq? n 0) #true (odd? (- n 1))))
        (defun odd? (n) (if (eq? n 0) #false (even? (- n 1))))
        (even? 10)
    `);
    assert.equal(print(done(s)), '#true');
    const s2 = run1(`
        (defun even? (n) (if (eq? n 0) #true (odd? (- n 1))))
        (defun odd? (n) (if (eq? n 0) #false (even? (- n 1))))
        (even? 7)
    `);
    assert.equal(print(done(s2)), '#false');
});

test('tail calls run in constant space over 1,000,000 iterations', () => {
    const { closure, name } = globalClosure(
        '(defun loop (n acc) (if (eq? n 0) acc (loop (- n 1) (+ acc 1))))'
    );
    const R = fromBindings([[name.name, closure]]);
    let s = start(closure, [int(1_000_000n), int(0n)], R);

    let maxDepth = 0;
    let steps = 0;
    while (s.mode.m !== 'done' && s.mode.m !== 'failed') {
        s = step(s);
        const d = kontDepth(s.K);
        if (d > maxDepth) maxDepth = d;
        steps += 1;
        if (steps > 50_000_000) throw new Error('runaway: loop did not terminate');
    }

    assert.equal(print(done(s)), '1000000');
    assert.ok(maxDepth <= 2, `kontDepth reached ${maxDepth}, expected <= 2`);
});

test('the checkpoint slot tracks a loop\'s arguments, matched by name', () => {
    const { closure, name } = globalClosure(
        '(defun loop (n) (if (eq? n 0) n (loop (- n 1))))'
    );
    const R = fromBindings([[name.name, closure]]);
    let s = start(closure, [int(5n)], R);
    assert.equal(s.A.name, 'loop');
    assert.equal(print(s.A.args[0]!), '5');

    s = run(s, 1000);
    assert.equal(print(done(s)), '0');
    assert.equal(s.A.name, 'loop');
    assert.equal(s.A.args.length, 1);
    assert.equal(print(s.A.args[0]!), '0');
});

test('a global defun does not bind its own name locally', () => {
    // If `loop` bound itself in local scope, shadowing the env, then swapping
    // the env's binding out from under it would have no effect. Since it
    // resolves through R instead, the swap changes what the next call reaches.
    const { closure, name } = globalClosure('(defun loop (n) (helper n))');
    const { closure: helperV1 } = globalClosure('(defun helper (n) (+ n 1))');
    const { closure: helperV2 } = globalClosure('(defun helper (n) (+ n 100))');
    const R1 = fromBindings([[name.name, closure], ['helper', helperV1]]);
    const s1 = run(start(closure, [int(1n)], R1), 100);
    assert.equal(print(done(s1)), '2');

    const R2 = fromBindings([[name.name, closure], ['helper', helperV2]]);
    const s2 = run(start(closure, [int(1n)], R2), 100);
    assert.equal(print(done(s2)), '101');
});

// ---------------------------------------------------------------------------
// Host requests and resume (SPEC-CPI section 8)
// ---------------------------------------------------------------------------

function hostState(): State {
    const s = run1('(io::print 42 "hi")');
    assert.equal(s.mode.m, 'host');
    return s;
}

test('a host request evaluates its arguments and enters host mode', () => {
    const s = hostState();
    const mode = s.mode as { m: 'host'; ns: string; action: string; args: readonly Value[] };
    assert.equal(mode.ns, 'io');
    assert.equal(mode.action, 'print');
    assert.deepEqual(mode.args.map(print), ['42', '"hi"']);
});

test('resume with a val frame delivers the value', () => {
    const s = hostState();
    const frames: Frame[] = [{ k: 'val', v: int(99n) }];
    const s2 = run(resume(s, frames), 10);
    assert.equal(print(done(s2)), '99');
});

test('resume with a throw frame throws the error', () => {
    const s = hostState();
    const e = makeError('custom', 'oops', NIL);
    const frames: Frame[] = [{ k: 'throw', e, site: { fn: null, pos: null }, scope: null }];
    const s2 = run(resume(s, frames), 10);
    const { tag } = failed(s2);
    assert.equal(tag, 'custom');
});

test('resumeValue is resume with a single val frame', () => {
    const s = hostState();
    const s2 = run(resumeValue(s, int(99n)), 10);
    assert.equal(print(done(s2)), '99');
});

test('resumeThrow: an error from a host handler gets the request\'s trace and pad, and is catchable', () => {
    const s = run1(`
        (defun asker () (io::ask 1))
        (catch (asker) e (stack-trace-for e))
    `);
    assert.equal(s.mode.m, 'host');
    const e = makeError('denied', 'not granted', NIL);
    const s2 = run(resumeThrow(s, e), 100);

    const entries = listToArray(done(s2))!;
    const first = listToArray(entries[0]!)!;
    // entry 0 names the procedure that made the host request, and carries its
    // source position, not an empty one.
    assert.equal((first[0] as Sym).name, 'asker');
    const line = first[2]!;
    const col = first[3]!;
    assert.ok(!(print(line) === '0' && print(col) === '0'), 'expected a real source position, not "" 0 0');
});

test('resumeThrow requires a state in host mode', () => {
    const s = run1('5');
    assert.throws(() => resumeThrow(s, makeError('x', 'x', NIL)));
});

test('resume with an eval frame splices in an evaluation', () => {
    const s = hostState();
    const x = int(7n);
    const frames: Frame[] = [{ k: 'eval', x, scope: null, site: { fn: null, pos: null } }];
    const s2 = run(resume(s, frames), 10);
    assert.equal(print(done(s2)), '7');
});

test('resume splices frames in order: frames[0] ends up on top', () => {
    const s = hostState();
    // eval 8, then discard it and deliver 3.
    const frames: Frame[] = [
        { k: 'eval', x: int(8n), scope: null, site: { fn: null, pos: null } },
        { k: 'val', v: int(3n) },
    ];
    const s2 = run(resume(s, frames), 10);
    assert.equal(print(done(s2)), '3');
});
