// Building environments from roles (DECISIONS.md, Spec changes, 2026-09-27).

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Closure, Env, ErrorValue, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { bindingHashOf, compose, conflicts, emptyEnv, fromBindings } from '../src/env.ts';
import { loadSource } from '../src/loader.ts';
import { LoadError } from '../src/errors.ts';
import { print } from '../src/printer.ts';
import { run, startExpr } from '../src/machine.ts';
import { Runtime } from '../src/runtime.ts';
import { int, list, sym, vec } from '../src/values.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Evaluates one expression (no host requests) and returns its value.
function evalExpr(src: string): Value {
    const [expr] = expand(read(src, 'test'), 'expr');
    const s = run(startExpr(expr!, emptyEnv()), 10_000);
    assert.equal(s.mode.m, 'done', s.mode.m === 'failed' ? print(s.mode.e) : s.mode.m);
    return (s.mode as { m: 'done'; v: Value }).v;
}

function roleEnv(src: string): Env {
    const v = evalExpr(src);
    assert.equal(v.t, 'env');
    return (v as { t: 'env'; env: Env }).env;
}

function loadError(src: string, pattern?: RegExp): void {
    assert.throws(() => expand(read(src, 'test'), 'expr'), (e: unknown) => {
        assert.ok(e instanceof LoadError, `expected a LoadError, got ${e}`);
        if (pattern) assert.match(String((e as Error).message), pattern);
        return true;
    });
}

// Boots a CPI program and returns what `main` returned, printed.
async function cpi(src: string): Promise<string> {
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual' });
    const result = await rt.boot(loadSource(src, 'test'));
    assert.equal(result.ok, true, result.ok ? '' : print((result as { e: ErrorValue }).e));
    return print((result as { ok: true; v: Value }).v);
}

function slotKind(env: Env, name: string): string | undefined {
    return env.slots.get(name)?.s;
}

// ---------------------------------------------------------------------------
// The role special form
// ---------------------------------------------------------------------------

test('role: defuns, consts and requires become slots', () => {
    const env = roleEnv(`
        (role
            (require g)
            (defun f (x) (g x))
            (const k 3)
            (const table '(1 2))
            (const colour :red)
            (const greeting "hi")
            (const nothing ()))
    `);
    assert.equal(slotKind(env, 'g'), 'required');
    const f = env.slots.get('f')!;
    assert.equal(f.s, 'defined');
    const closure = (f as { value: Value }).value as Closure;
    assert.equal(closure.t, 'closure');
    assert.equal(closure.name?.name, 'f');
    assert.deepEqual(closure.params.map((p) => p.name), ['x']);
    assert.equal(closure.scope, null);
    assert.equal(closure.group, null);
    const value = (name: string) => print((env.slots.get(name) as { value: Value }).value);
    assert.equal(value('k'), '3');
    assert.equal(value('table'), '(1 2)');
    assert.equal(value('colour'), 'red');
    assert.equal(value('greeting'), '"hi"');
    assert.equal(value('nothing'), '()');
});

test('role: an empty role is an empty environment', () => {
    assert.equal(roleEnv('(role)').slots.size, 0);
});

test('role: the value depends only on the forms', () => {
    assert.equal(print(evalExpr(`
        (do
            (let make (lambda () (role (const k 1))))
            (eq? (make) (make)))
    `)), '#true');
});

test('role: captures nothing from where it appears', () => {
    loadError('((lambda (x) (role (defun f () x))) 1)', /'x'/);
});

test('role: local names are not global uses', () => {
    const env = roleEnv(`
        (role
            (defun f (x)
                (let y (+ x 1))
                (defun g (z) (h z y))
                (defun h (a b) (catch (g a) e (list e b)))
                ((lambda (w) w) (g x))))
    `);
    assert.equal(env.slots.size, 1);
});

test('role: a global the role neither defines nor requires is a load-error', () => {
    loadError('(role (defun f () (helper)))', /'helper'/);
    loadError('(role (defun f () (list g)))', /'g'/);
    assert.equal(slotKind(roleEnv('(role (defun f () (helper)) (defun helper () 1))'), 'helper'), 'defined');
});

test('role: every host action must be declared', () => {
    loadError('(role (defun f (a) (actor::send a 1)))', /'actor::send'/);
    const env = roleEnv('(role (require actor::send) (defun f (a) (actor::send a 1)))');
    assert.equal(slotKind(env, 'actor::send'), 'required');
});

test('role: a const holds a literal or quoted datum only', () => {
    loadError('(role (const k (+ 1 2)))');
    loadError('(role (const k other))');
    loadError('(role (const k))');
});

test('role: two definitions of a name are a load-error', () => {
    loadError('(role (defun f () 1) (defun f () 2))', /'f'/);
    loadError('(role (defun f () 1) (const f 2))', /'f'/);
});

test('role: reserved names cannot be defined or required', () => {
    loadError('(role (defun car (x) x))');
    loadError('(role (const if 1))');
    loadError('(role (require car))');
    loadError('(role (defun IO::print () 1))');
    assert.equal(slotKind(roleEnv('(role (require IO::print))'), 'IO::print'), 'required');
});

test('role: only defun, const and require forms', () => {
    loadError('(role (let x 1))');
    loadError('(role 5)');
    loadError('(role (f))');
});

test('require: only inside a role', () => {
    loadError('(require foo)');
});

test('role and require are reserved', () => {
    loadError('(do (let role 1) role)');
    loadError('(do (let require 1) require)');
});

// ---------------------------------------------------------------------------
// Composition compares values by content
// ---------------------------------------------------------------------------

const MODULE = `
(defun life-rule (alive n)
    (if (= alive 1) (if (= n 2) 1 (if (= n 3) 1 0)) (if (= n 3) 1 0)))
(defun helper (x) (+ x 1))
(const table '(1 2 3))
(const answer 42)
`;

test('compose: an unchanged module loaded twice has no conflicts', () => {
    assert.deepEqual(conflicts(compose(loadSource(MODULE, 'a'), loadSource(MODULE, 'b'))), []);
});

test('compose: a changed defun conflicts on its own name only', () => {
    const changed = MODULE.replace('(if (= n 3) 1 0)))', '(if (= n 6) 1 (if (= n 3) 1 0))))');
    assert.notEqual(changed, MODULE);
    assert.deepEqual(conflicts(compose(loadSource(MODULE, 'a'), loadSource(changed, 'b'))), ['life-rule']);
});

test('compose: two role literals with the same forms compose without conflicts', () => {
    const src = '(role (require g) (defun f (x) (g x)) (const k (1 2)))'.replace('(1 2)', "'(1 2)");
    assert.deepEqual(conflicts(compose(roleEnv(src), roleEnv(src))), []);
});

test('compose: vectors compare element by element', () => {
    const a = fromBindings([['v', vec([int(1), list(sym('x'))])]]);
    const b = fromBindings([['v', vec([int(1), list(sym('x'))])]]);
    const c = fromBindings([['v', vec([int(1), list(sym('y'))])]]);
    assert.deepEqual(conflicts(compose(a, b)), []);
    assert.deepEqual(conflicts(compose(a, c)), ['v']);
});

test('compose: closures that captured local variables compare by identity', () => {
    const mk = () => evalExpr('((lambda (n) (lambda () n)) 1)');
    assert.deepEqual(conflicts(compose(fromBindings([['f', mk()]]), fromBindings([['f', mk()]]))), ['f']);
});

// ---------------------------------------------------------------------------
// The binding hash covers roles inside code
// ---------------------------------------------------------------------------

test('bindingHashOf: a changed const in a role returned by a defun changes the hash', () => {
    const one = loadSource('(defun params () (role (const k 1)))', 'a');
    const two = loadSource('(defun params () (role (const k 2)))', 'b');
    const same = loadSource('(defun params () (role (const k 1)))', 'c');
    assert.notEqual(bindingHashOf(one), bindingHashOf(two));
    assert.equal(bindingHashOf(one), bindingHashOf(same));
});

// ---------------------------------------------------------------------------
// environment:: builtins
// ---------------------------------------------------------------------------

test('environment::define and environment::required', async () => {
    assert.equal(await cpi(`
        (defun main ()
            (let e (environment::define (role (require b c)) 'a 1))
            (list (environment::lookup e 'a) (environment::required e)))
    `), '(1 (b c))');
});

test('environment::define: the name must be a symbol that can be bound', async () => {
    assert.equal(await cpi(`
        (defun tag-of (thunk) (catch (thunk) e (error-tag e)))
        (defun main ()
            (list
                (tag-of (lambda () (environment::define (role) 'car 1)))
                (tag-of (lambda () (environment::define (role) "a" 1)))
                (tag-of (lambda () (environment::define (role) 'actor::send 1)))
                (tag-of (lambda () (environment::define 5 'a 1)))))
    `), '(type-error type-error type-error type-error)');
});

const STRATEGY = `
(defun compose-with (a b strategy)
    (let e (environment::compose a b))
    (environment::accept e (accepted-names e (environment::conflicts e) strategy)))

(defun accepted-names (e names strategy)
    (cond
        ((nil? names) ())
        ((eq? (strategy (car names) (environment::history e (car names))) :accept)
            (cons (car names) (accepted-names e (cdr names) strategy)))
        (#true (accepted-names e (cdr names) strategy))))

(defun track-score (name history)
    (if (eq? name 'score) :retain :accept))

(defun set (e name value)
    (compose-with e (environment::define (role) name value) track-score))
`;

test('history, accept and a strategy: tracked names keep history, others are flattened', async () => {
    assert.equal(await cpi(STRATEGY + `
        (defun main ()
            (let s0 (environment::define (environment::define (role) 'score 0) 'level 1))
            (let s1 (set (set s0 'score 10) 'level 2))
            (let s2 (set s1 'score 25))
            (list
                (environment::history s2 'score)
                (environment::history s2 'level)
                (environment::lookup s2 'score)
                (environment::conflicts s2)
                (environment::history (environment::accept s2 '(score)) 'score)
                (environment::history s2 'missing)))
    `), '((0 10 25) (2) 25 (score) (25) ())');
});

test('environment::difference: what composing one environment onto another would change', async () => {
    assert.equal(await cpi(`
        (defun main ()
            (let x (environment::define (environment::define (role) 'a 1) 'b 2))
            (let y (environment::define (environment::define (environment::define (role) 'a 1) 'b 3) 'c 4))
            (let d (environment::difference y x))
            (list
                (environment::lookup d 'b)
                (environment::lookup d 'c)
                (catch (environment::lookup d 'a) e (error-tag e))))
    `), '(3 4 unbound)');
});

test('environment::resolve: unfilled names, missing grants, and success', async () => {
    assert.equal(await cpi(`
        (defun code ()
            (role
                (require helper actor::send)
                (defun f (a) (actor::send a (helper)))))
        (defun main ()
            (let filled (environment::compose (code) (role (defun helper () 1))))
            (list
                (catch (environment::resolve (code) '(actor)) e (list (error-tag e) (error-payload e)))
                (catch (environment::resolve filled '()) e (list (error-tag e) (error-payload e)))
                (eq? filled (environment::resolve filled '(actor)))))
    `), '((unbound (helper)) (not-granted actor) #true)');
});

test('environment::select: exactly the named slots, as they are', async () => {
    assert.equal(await cpi(`
        (defun main ()
            (let e (environment::define (environment::define (environment::define (role) 'a 1) 'b 2) 'c 3))
            (let e2 (environment::compose e (environment::define (role) 'a 10)))
            (let s (environment::select e2 '(a c missing actor::send)))
            (list
                (environment::history s 'a)
                (environment::lookup s 'c)
                (catch (environment::lookup s 'b) err (error-tag err))
                (catch (environment::lookup s 'missing) err (error-tag err))
                (environment::required s)
                (environment::conflicts s)))
    `), '((1 10) 3 unbound unbound () (a))');
});

test('environment::select: a Required slot stays Required', async () => {
    assert.equal(await cpi(`
        (defun main ()
            (environment::required (environment::select (role (require x y)) '(x))))
    `), '(x)');
});

test('environment::select: types are checked', async () => {
    assert.equal(await cpi(`
        (defun tag-of (thunk) (catch (thunk) e (error-tag e)))
        (defun main ()
            (list
                (tag-of (lambda () (environment::select 5 '(a))))
                (tag-of (lambda () (environment::select (role) 'a)))
                (tag-of (lambda () (environment::select (role) '(a "b"))))))
    `), '(type-error type-error type-error)');
});

test('environment::select: a process gets exactly what its role requires from the CPI', async () => {
    assert.equal(await cpi(`
        (defun helper (x) (+ x 1))
        (defun secret () :leaked)
        (defun code ()
            (role
                (require helper)
                (defun worker (x) (helper x))))
        (defun main ()
            (let env (environment::compose (environment::select (environment::self) (environment::required (code))) (code)))
            (list
                (environment::lookup env 'helper)
                (catch (environment::lookup env 'secret) e (error-tag e))
                (catch (environment::lookup env 'main) e (error-tag e))))
    `), '(#<procedure helper> unbound unbound)');
});

// ---------------------------------------------------------------------------
// Grants are checked when a process gets an environment
// ---------------------------------------------------------------------------

test('process::spawn: refuses an environment that needs a namespace it does not grant', async () => {
    assert.equal(await cpi(`
        (defun code () (role (require actor::recv) (defun f () (actor::recv))))
        (defun main ()
            (let e (code))
            (let f (environment::lookup e 'f))
            (list
                (catch (process::spawn f () e '() #false) err (list (error-tag err) (error-payload err)))
                (pid? (process::spawn f () e '(actor) #false))))
    `), '((not-granted actor) #true)');
});

test('process::set-env: checks the process\'s own grants', async () => {
    assert.equal(await cpi(`
        (defun plain () (role (defun f () 1)))
        (defun needs-actor () (role (require actor::recv) (defun f () (actor::recv))))
        (defun main ()
            (let e (plain))
            (let pid (process::spawn (environment::lookup e 'f) () e '() #false))
            (catch (process::set-env pid (needs-actor)) err (list (error-tag err) (error-payload err))))
    `), '(not-granted actor)');
});

test('process::unpark: checks the parked process\'s grants', async () => {
    assert.equal(await cpi(`
        (defun waiter () (role (require actor::recv) (defun f () (actor::recv))))
        (defun sleeper () (role (require actor::recv timer::sleep) (defun f () (actor::recv))))
        (defun main ()
            (let e (waiter))
            (let pid (process::spawn (environment::lookup e 'f) () e '(actor) #false))
            (process::run pid 100)
            (let data (process::park pid))
            (catch (process::unpark data (sleeper)) err (list (error-tag err) (error-payload err))))
    `), '(not-granted timer)');
});

// ---------------------------------------------------------------------------
// A hot reload that changes parameters, not code
// ---------------------------------------------------------------------------

test('hot reload: a required const is a parameter, swapped with set-env', async () => {
    assert.equal(await cpi(`
        (defun rule-code ()
            (role
                (require actor::recv actor::send born survives member?)
                (defun rule-server ()
                    (let msg (actor::recv))
                    (actor::send (car msg) (life-rule (car (cdr msg)) (car (cdr (cdr msg)))))
                    (rule-server))
                (defun life-rule (alive n)
                    (if (= alive 1)
                        (if (member? n survives) 1 0)
                        (if (member? n born) 1 0)))))

        (defun lists ()
            (role
                (defun member? (x xs)
                    (cond
                        ((nil? xs) #false)
                        ((eq? x (car xs)) #true)
                        (#true (member? x (cdr xs)))))))

        (defun highlife ()
            (role
                (const born '(3 6))
                (const survives '(2 3))))

        (defun seeds ()
            (role
                (const born '(2))
                (const survives ())))

        (defun server-env (params)
            (environment::resolve
                (environment::compose (environment::compose (lists) (rule-code)) params)
                '(actor)))

        (defun ask (pid box alive n)
            (mailbox::send (process::address pid) (list box alive n))
            (process::run pid 1000)
            (mailbox::take box))

        (defun main ()
            (let box (mailbox::create #false 10))
            (let env (server-env (highlife)))
            (let pid (process::spawn (environment::lookup env 'rule-server) () env '(actor) #false))
            (let a (ask pid box 0 6))
            (process::set-env pid (server-env (seeds)))
            (let b (ask pid box 0 6))
            (let c (ask pid box 0 2))
            (process::set-env pid env)
            (let d (ask pid box 0 6))
            (list a b c d))
    `), '(1 0 1 1)');
});
