import test from 'node:test';
import assert from 'node:assert/strict';

import type { Closure, Env, ErrorValue, Sym, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { fromBindings } from '../src/env.ts';
import { listToArray, sym } from '../src/values.ts';
import { print } from '../src/printer.ts';
import { Runtime } from '../src/runtime.ts';

// ---------------------------------------------------------------------------
// Helpers: build an env directly from `(defun ...)` source, the way the
// (still in-progress) loader eventually will, without depending on it.
// `extra` lets a test inject a binding CPI source cannot spell itself, such
// as a second env ref, so tests for process::set-env can exercise hot reload
// without needing the loader either.
// ---------------------------------------------------------------------------

function buildEnv(src: string, extra: ReadonlyArray<readonly [string, Value]> = []): Env {
    const forms = expand(read(src, 'test'), 'file');
    const bindings: [string, Value][] = [];
    for (const f of forms) {
        const arr = listToArray(f)!; // [sym('defun'), name, paramsForm, ...body]
        const name = arr[1] as Sym;
        const params = listToArray(arr[2]!) as Sym[];
        const body = arr.slice(3);
        const closure: Closure = { t: 'closure', name, params, body, scope: null, group: null };
        bindings.push([name.name, closure]);
    }
    return fromBindings([...bindings, ...extra]);
}

async function boot(src: string, extra: ReadonlyArray<readonly [string, Value]> = []) {
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual' });
    const env = buildEnv(src, extra);
    const result = await rt.boot(env);
    return { rt, result, output };
}

async function ok(src: string, extra: ReadonlyArray<readonly [string, Value]> = []): Promise<Value> {
    const { result } = await boot(src, extra);
    assert.equal(result.ok, true, result.ok ? '' : print((result as { e: ErrorValue }).e));
    return (result as { ok: true; v: Value }).v;
}

async function failedBoot(src: string): Promise<ErrorValue> {
    const { result } = await boot(src);
    assert.equal(result.ok, false);
    return (result as { ok: false; e: ErrorValue }).e;
}

// Unwraps a proper list value into a JS array, failing the test if it isn't one.
function arr(v: Value): Value[] {
    const a = listToArray(v);
    assert.ok(a !== null, `expected a proper list, got ${print(v)}`);
    return a!;
}

// ---------------------------------------------------------------------------
// Spawn and run to exit
// ---------------------------------------------------------------------------

test('spawn and run to exit', async () => {
    const v = await ok(`
        (defun worker (x) (+ x 1))
        (defun main ()
            (let p (process::spawn worker (cons 41 ()) (environment::self) '() #false))
            (process::run p 100))
    `);
    assert.equal(print(v), '(exited 42)');
});

// ---------------------------------------------------------------------------
// Quota preemption and resuming
// ---------------------------------------------------------------------------

test('quota: preemption at n ticks, then resuming to completion', async () => {
    const v = await ok(`
        (defun loop (n) (if (eq? n 0) :done (loop (- n 1))))
        (defun main ()
            (let p (process::spawn loop (cons 10 ()) (environment::self) '() #false))
            (let r1 (process::run p 3))
            (let r2 (process::run p 1000))
            (cons r1 (cons r2 ())))
    `);
    const [r1, r2] = arr(v);
    assert.equal(print(r1!), '(quota)');
    assert.equal(print(r2!), '(exited done)');
});

// ---------------------------------------------------------------------------
// Send and recv between two processes, delivery at the batch boundary
// ---------------------------------------------------------------------------

test('send and recv between two processes: delivery at the batch boundary', async () => {
    const v = await ok(`
        (defun receiver () (actor::recv))
        (defun sender (addr) (actor::send addr :hello))
        (defun main ()
            (let b (process::spawn receiver () (environment::self) '(actor) #false))
            (let r1 (process::run b 10))
            (let addrb (process::address b))
            (let a (process::spawn sender (cons addrb ()) (environment::self) '(actor) #false))
            (let r2 (process::run a 10))
            (let r3 (process::run b 10))
            (cons r1 (cons r2 (cons r3 ()))))
    `);
    const [r1, r2, r3] = arr(v);
    assert.equal(print(r1!), '(blocked recv)');
    assert.equal(print(r2!), '(exited #true)');
    assert.equal(print(r3!), '(exited hello)');
});

// ---------------------------------------------------------------------------
// (blocked recv) becoming ready when a message arrives (a direct CPI send)
// ---------------------------------------------------------------------------

test('a blocked-recv process becomes ready when a message arrives', async () => {
    const v = await ok(`
        (defun receiver () (actor::recv))
        (defun main ()
            (let b (process::spawn receiver () (environment::self) '(actor) #false))
            (let r1 (process::run b 5))
            (let s1 (process::state b))
            (mailbox::send (process::address b) :ping)
            (let s2 (process::state b))
            (let r2 (process::run b 5))
            (cons r1 (cons s1 (cons s2 (cons r2 ())))))
    `);
    const [r1, s1, s2, r2] = arr(v);
    assert.equal(print(r1!), '(blocked recv)');
    assert.equal(print(s1!), '(blocked recv)');
    assert.equal(print(s2!), '(ready)');
    assert.equal(print(r2!), '(exited ping)');
});

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

test('join: blocks until the target ends, then reports its detail', async () => {
    const v = await ok(`
        (defun worker () 99)
        (defun joiner (target) (actor::join target))
        (defun main ()
            (let w (process::spawn worker () (environment::self) '() #false))
            (let j (process::spawn joiner (cons w ()) (environment::self) '(actor) #false))
            (let rj1 (process::run j 5))
            (let rw (process::run w 5))
            (let rj2 (process::run j 5))
            (cons rj1 (cons rw (cons rj2 ()))))
    `);
    const [rj1, rw, rj2] = arr(v);
    assert.equal(print(rj1!), '(blocked join #<pid 1>)');
    assert.equal(print(rw!), '(exited 99)');
    assert.equal(print(rj2!), '(exited (exited 99))');
});

// ---------------------------------------------------------------------------
// Traps, with process::resume and process::resume-throw
// ---------------------------------------------------------------------------

test('traps: process::resume answers a trapped send', async () => {
    const v = await ok(`
        (defun sender (addr) (actor::send addr :hi))
        (defun main ()
            (host::set-traps '(send))
            (let mb (mailbox::create #false 10))
            (let p (process::spawn sender (cons mb ()) (environment::self) '(actor) #false))
            (let r1 (process::run p 5))
            (process::resume p #true)
            (let r2 (process::run p 5))
            (cons r1 (cons r2 ())))
    `);
    const [r1, r2] = arr(v);
    const r1arr = arr(r1!);
    assert.equal((r1arr[0] as Sym).name, 'trap');
    assert.equal((r1arr[1] as Sym).name, 'send');
    const trapArgs = arr(r1arr[2]!);
    assert.equal((trapArgs[1] as Sym).name, 'hi');
    assert.equal(print(r2!), '(exited #true)');
});

test('traps: process::resume-throw answers a trapped send by throwing', async () => {
    const v = await ok(`
        (defun sender (addr) (actor::send addr :hi))
        (defun main ()
            (host::set-traps '(send))
            (let mb (mailbox::create #false 10))
            (let p (process::spawn sender (cons mb ()) (environment::self) '(actor) #false))
            (let r1 (process::run p 5))
            (process::resume-throw p (make-error :boom "nope" ()))
            (process::run p 5))
    `);
    const rarr = arr(v);
    assert.equal((rarr[0] as Sym).name, 'failed');
    const e = rarr[1] as ErrorValue;
    assert.equal(e.tag.name, 'boom');
});

// ---------------------------------------------------------------------------
// process::checkpoint after a failure
// ---------------------------------------------------------------------------

test('process::checkpoint reads the most recent call after a failure', async () => {
    const v = await ok(`
        (defun looper (n) (if (eq? n 0) (throw (make-error :boom "die" n)) (looper (- n 1))))
        (defun main ()
            (let p (process::spawn looper (cons 3 ()) (environment::self) '() #false))
            (let r (process::run p 1000))
            (cons r (cons (process::checkpoint p) ())))
    `);
    const [r, cp] = arr(v);
    const rarr = arr(r!);
    assert.equal((rarr[0] as Sym).name, 'failed');
    assert.equal(print(cp!), '(0)');
});

// ---------------------------------------------------------------------------
// process::ticks (DECISIONS.md, Spec changes, 2026-09-28)
// ---------------------------------------------------------------------------

test('process::ticks: a new process has used none, and each run adds the ticks it used', async () => {
    const v = await ok(`
        (defun spin (n) (spin (+ n 1)))
        (defun waiter () (actor::recv))
        (defun main ()
            (let p (process::spawn spin (list 0) (environment::self) '() #false))
            (let t0 (process::ticks p))
            (process::run p 50)
            (let t1 (process::ticks p))
            (process::run p 30)
            (let w (process::spawn waiter () (environment::self) '(actor) #false))
            (let stop (process::run w 1000))
            (let tw (process::ticks w))
            (list t0 t1 (process::ticks p) stop (and (> tw 0) (< tw 1000))))
    `);
    assert.equal(print(v), '(0 50 80 (blocked recv) #true)');
});

test('process::ticks: readable after the process ends or is parked; an unparked process starts from 0', async () => {
    const v = await ok(`
        (defun one () 1)
        (defun waiter () (actor::recv))
        (defun main ()
            (let p (process::spawn one () (environment::self) '() #false))
            (process::run p 100)
            (let w (process::spawn waiter () (environment::self) '(actor) #false))
            (process::run w 100)
            (let before (process::ticks w))
            (let q (process::unpark (process::park w) (environment::self)))
            (list (> (process::ticks p) 0) (= (process::ticks w) before) (process::ticks q)))
    `);
    assert.equal(print(v), '(#true #true 0)');
});

test('process::ticks: a non-PID is a type-error', async () => {
    const v = await ok(`
        (defun main ()
            (catch (process::ticks 3) e (error-tag e)))
    `);
    assert.equal(print(v), 'type-error');
});

// ---------------------------------------------------------------------------
// process::run-ready (DECISIONS.md, Spec changes, 2026-09-28)
// ---------------------------------------------------------------------------

test('process::run-ready: one batch for each ready process, reporting only exits, failures and traps', async () => {
    const v = await ok(`
        (defun one () 1)
        (defun spin (n) (spin (+ n 1)))
        (defun bad () (car 5))
        (defun waiter () (actor::recv))
        (defun main ()
            (let a (process::spawn one () (environment::self) '() #false))
            (let b (process::spawn spin (list 0) (environment::self) '() #false))
            (let c (process::spawn bad () (environment::self) '() #false))
            (let d (process::spawn waiter () (environment::self) '(actor) #false))
            (let r (process::run-ready 50 #false))
            (let events (car r))
            (list
                (car (car events)) (car (car (cdr (car events)))) (car (cdr (car (cdr (car events)))))
                (car (car (cdr events))) (car (car (cdr (car (cdr events)))))
                (cdr (cdr events))
                (car (cdr r))
                (process::state b) (process::ticks b) (process::state d)))
    `);
    assert.equal(print(v), '(#<pid 1> exited 1 #<pid 3> failed () 1 (ready) 50 (blocked recv))');
});

test('process::run-ready: processes run in PID order, so one woken during the round runs in it only if it comes later', async () => {
    const v = await ok(`
        (defun waiter () (actor::recv))
        (defun sender (to1 to2)
            (actor::send to1 :early)
            (actor::send to2 :late))
        (defun main ()
            (let box (mailbox::create #true 10))
            (let w1 (process::spawn waiter () (environment::self) '(actor) #false))
            (let s (process::spawn sender (list (process::address w1) box) (environment::self) '(actor) #false))
            (let w2 (process::spawn waiter () (environment::self) '(actor) box))
            (process::run w1 100)
            (process::run w2 100)
            (let r1 (process::run-ready 100 #false))
            (let r2 (process::run-ready 100 #false))
            (let r3 (process::run-ready 100 #false))
            (list r1 r2 r3))
    `);
    assert.equal(print(v), [
        '((((#<pid 2> (exited #true)) (#<pid 3> (exited late))) 1)',
        '(((#<pid 1> (exited early))) 0)',
        '(() 0))',
    ].join(' '));
});

test('process::run-ready: a trapped effect is reported, and the process waits for process::resume', async () => {
    const v = await ok(`
        (defun sender (to) (actor::send to :hi) :sent)
        (defun main ()
            (host::set-traps '(send))
            (let box (mailbox::create #true 10))
            (let p (process::spawn sender (list box) (environment::self) '(actor) #false))
            (let r1 (process::run-ready 100 #false))
            (let event (car (car r1)))
            (let state (process::state p))
            (process::resume p #true)
            (let r2 (process::run-ready 100 #false))
            (list (car (car (cdr event))) (car (cdr (car (cdr event)))) (car (cdr r1)) state r2))
    `);
    assert.equal(print(v), '(trap send 0 (trapped) (((#<pid 1> (exited sent))) 0))');
});

test('process::run-ready: a process waiting in recv for idle ms is reported once, and again only after it has run', async () => {
    const v = await ok(`
        (defun waiter () (actor::recv) (waiter))
        (defun main ()
            (let w (process::spawn waiter () (environment::self) '(actor) #false))
            (let r1 (process::run-ready 100 1000))
            (host::wait 500)
            (let r2 (process::run-ready 100 1000))
            (host::wait 600)
            (let r3 (process::run-ready 100 1000))
            (host::wait 5000)
            (let r4 (process::run-ready 100 1000))
            (mailbox::send (process::address w) :wake)
            (let r5 (process::run-ready 100 1000))
            (host::wait 1000)
            (let r6 (process::run-ready 100 #false))
            (let r7 (process::run-ready 100 1000))
            (list r1 r2 r3 r4 r5 r6 r7))
    `);
    assert.equal(print(v), '((() 0) (() 0) (((#<pid 1> (idle))) 0) (() 0) (() 0) (() 0) (((#<pid 1> (idle))) 0))');
});

// ---------------------------------------------------------------------------
// plan::run (DECISIONS.md, Spec changes, 2026-09-28; DESIGN-PLAN.md)
// ---------------------------------------------------------------------------

test('plan::run: runs rounds until one reports an event, across quotas', async () => {
    const v = await ok(`
        (defun count (n) (if (= n 0) :done (count (- n 1))))
        (defun main ()
            (let p (process::spawn count (list 20) (environment::self) '() #false))
            (let r (plan::run (list (list 'round 100 #false)) #false))
            (list r (> (process::ticks p) 100)))
    `);
    assert.equal(print(v), '(((#<pid 1> (exited done))) #true)');
});

test('plan::run: mail in an inbox wakes the CPI, after the round\'s own events', async () => {
    const v = await ok(`
        (defun sender (to) (actor::send to :hi) :sent)
        (defun main ()
            (let box (mailbox::create #true 10))
            (let p (process::spawn sender (list box) (environment::self) '(actor) #false))
            (let plan (list (list 'round 100 #false) (list 'inbox box)))
            (let r1 (plan::run plan #false))
            (let r2 (plan::run plan #false))
            (list r1 (eq? (car (car r2)) box) (car (cdr (car r2))) (cdr r2) (mailbox::take box)))
    `);
    assert.equal(print(v), '(((#<pid 1> (exited sent))) #true (mail) () hi)');
});

test('plan::run: returns () when the timeout passes with nothing to report', async () => {
    const v = await ok(`
        (defun waiter () (actor::recv))
        (defun main ()
            (let w (process::spawn waiter () (environment::self) '(actor) #false))
            (let t0 (host::now))
            (let r (plan::run (list (list 'round 100 #false)) 1000))
            (list r (- (host::now) t0) (process::state w)))
    `);
    assert.equal(print(v), '(() 1000 (blocked recv))');
});

test('plan::run: a sleeping process wakes inside the request, which returns when it exits', async () => {
    const v = await ok(`
        (defun sleeper () (timer::sleep 500) :woke)
        (defun main ()
            (let p (process::spawn sleeper () (environment::self) '(timer) #false))
            (let t0 (host::now))
            (let r (plan::run (list (list 'round 100 #false)) #false))
            (list r (- (host::now) t0)))
    `);
    assert.equal(print(v), '(((#<pid 1> (exited woke))) 500)');
});

test('plan::run: reports idle processes, as the round does', async () => {
    const v = await ok(`
        (defun waiter () (actor::recv) (waiter))
        (defun main ()
            (let w (process::spawn waiter () (environment::self) '(actor) #false))
            (let t0 (host::now))
            (let r (plan::run (list (list 'round 100 2000)) 5000))
            (list r (- (host::now) t0)))
    `);
    assert.equal(print(v), '(((#<pid 1> (idle))) 2000)');
});

test('plan::run: without a round node, no process is run', async () => {
    const v = await ok(`
        (defun one () 1)
        (defun main ()
            (let box (mailbox::create #true 10))
            (let p (process::spawn one () (environment::self) '() #false))
            (let r (plan::run (list (list 'inbox box)) 100))
            (list r (process::state p)))
    `);
    assert.equal(print(v), '(() (ready))');
});

test('plan::run: returns () when nothing can happen, even with no timeout', async () => {
    const v = await ok(`
        (defun main ()
            (plan::run (list (list 'round 100 #false)) #false))
    `);
    assert.equal(print(v), '()');
});

test('plan::run: a plan is a list of known nodes, at most one round, and the timeout an integer >= 0 or #false', async () => {
    const v = await ok(`
        (defun main ()
            (let box (mailbox::create #true 10))
            (list
                (catch (plan::run 5 #false) e (error-tag e))
                (catch (plan::run (list (list 'mixer 1)) #false) e (error-tag e))
                (catch (plan::run (list (list 'round 100 #false) (list 'round 10 #false)) #false) e (error-tag e))
                (catch (plan::run (list (list 'round 0 #false)) #false) e (error-tag e))
                (catch (plan::run (list (list 'inbox 3)) #false) e (error-tag e))
                (catch (plan::run (list (list 'inbox box)) -1) e (error-tag e))
                (plan::run () 0)))
    `);
    assert.equal(print(v), '(type-error type-error type-error type-error type-error type-error ())');
});

test('process::run-ready: n must be a positive integer, and idle a non-negative integer or #false', async () => {
    const v = await ok(`
        (defun main ()
            (list
                (catch (process::run-ready 0 #false) e (error-tag e))
                (catch (process::run-ready :x #false) e (error-tag e))
                (catch (process::run-ready 10 -1) e (error-tag e))
                (catch (process::run-ready 10 #true) e (error-tag e))
                (process::run-ready 10 0)))
    `);
    assert.equal(print(v), '(type-error type-error type-error type-error (() 0))');
});

// ---------------------------------------------------------------------------
// Park, then unpark and continue
// ---------------------------------------------------------------------------

test('park then unpark: the unparked process re-attempts recv and continues', async () => {
    const v = await ok(`
        (defun receiver () (let m (actor::recv)) (+ m 1))
        (defun main ()
            (let p (process::spawn receiver () (environment::self) '(actor) #false))
            (let r1 (process::run p 5))
            (let parked (process::park p))
            (let np (process::unpark parked (environment::self)))
            (let r2 (process::run np 5))
            (mailbox::send (process::address np) 41)
            (let r3 (process::run np 20))
            (cons r1 (cons parked (cons r2 (cons r3 ())))))
    `);
    const [r1, parked, r2, r3] = arr(v);
    assert.equal(print(r1!), '(blocked recv)');
    const parr = arr(parked!);
    assert.equal((parr[0] as Sym).name, 'parked');
    assert.equal(parr[1]!.t, 'int');
    assert.equal(print(parr[2]!), '()'); // checkpoint args: receiver was spawned with none
    assert.equal(parr[3]!.t, 'str');
    assert.equal(parr[4]!.t, 'addr');
    assert.equal(print(r2!), '(blocked recv)');
    assert.equal(print(r3!), '(exited 42)');
});

// ---------------------------------------------------------------------------
// Several receivers on one mailbox (DECISIONS.md, Spec changes, 2026-09-28)
// ---------------------------------------------------------------------------

test('several receivers: a message wakes only the receiver that has waited longest', async () => {
    // b blocks first, so b has waited longest even though a was spawned first.
    const v = await ok(`
        (defun taker () (actor::recv))
        (defun main ()
            (let mb (mailbox::create #false 10))
            (let a (process::spawn taker () (environment::self) '(actor) mb))
            (let b (process::spawn taker () (environment::self) '(actor) mb))
            (process::run b 5)
            (process::run a 5)
            (mailbox::send mb 1)
            (let s1 (list (process::state a) (process::state b)))
            (let rb (process::run b 5))
            (mailbox::send mb 2)
            (list s1 rb (process::state a) (process::run a 5)))
    `);
    assert.equal(print(v), '(((blocked recv) (ready)) (exited 1) (ready) (exited 2))');
});

test('several receivers: a woken receiver that is killed passes its wake-up on', async () => {
    const v = await ok(`
        (defun taker () (actor::recv))
        (defun main ()
            (let mb (mailbox::create #false 10))
            (let a (process::spawn taker () (environment::self) '(actor) mb))
            (let b (process::spawn taker () (environment::self) '(actor) mb))
            (process::run a 5)
            (process::run b 5)
            (mailbox::send mb 1)
            (let s1 (process::state b))
            (process::kill a :gone)
            (list s1 (process::state b) (process::run b 5)))
    `);
    assert.equal(print(v), '((blocked recv) (ready) (exited 1))');
});

test('several receivers: unparking one value three times gives three receivers on one queue', async () => {
    const v = await ok(`
        (defun taker () (actor::recv))
        (defun main ()
            (let mb (mailbox::create #true 10))
            (let p (process::spawn taker () (environment::self) '(actor) mb))
            (process::run p 5)
            (let template (process::park p))
            (let w1 (process::unpark template (environment::self)))
            (let w2 (process::unpark template (environment::self)))
            (let w3 (process::unpark template (environment::self)))
            (process::run w1 5)
            (process::run w2 5)
            (process::run w3 5)
            (mailbox::send mb 1)
            (let s1 (list (process::state w1) (process::state w2) (process::state w3)))
            (mailbox::send mb 2)
            (mailbox::send mb 3)
            (list s1 (process::run w1 5) (process::run w2 5) (process::run w3 5)))
    `);
    assert.equal(print(v), '(((ready) (blocked recv) (blocked recv)) (exited 1) (exited 2) (exited 3))');
});

test('several receivers: a non-durable mailbox stays open while any receiver lives', async () => {
    const { rt, result } = await boot(`
        (defun taker () (actor::recv))
        (defun main ()
            (let a (process::spawn taker () (environment::self) '(actor) #false))
            (let addr (process::address a))
            (let b (process::spawn taker () (environment::self) '(actor) addr))
            (process::run a 5)
            (process::kill b :gone)
            (mailbox::send addr 3)
            (process::run a 5))
    `);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    assert.equal(print((result as { ok: true; v: Value }).v), '(exited 3)');
    assert.equal(rt.deadLetters.length, 0);
});

test('several receivers: a non-durable mailbox whose receivers are all parked is closed, and unpark reopens it', async () => {
    const { rt, result } = await boot(`
        (defun taker () (actor::recv))
        (defun main ()
            (let p (process::spawn taker () (environment::self) '(actor) #false))
            (let addr (process::address p))
            (process::run p 5)
            (let parked (process::park p))
            (mailbox::send addr :lost)
            (let q (process::unpark parked (environment::self)))
            (mailbox::send addr 7)
            (process::run q 5))
    `);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    assert.equal(print((result as { ok: true; v: Value }).v), '(exited 7)');
    assert.equal(rt.deadLetters.length, 1);
    assert.equal(print(rt.deadLetters[0]!.msg), 'lost');
});

test('several receivers: a process\'s send to a closed mailbox is a dead letter', async () => {
    const { rt, result } = await boot(`
        (defun taker () (actor::recv))
        (defun sender (addr) (actor::send addr :lost))
        (defun main ()
            (let p (process::spawn taker () (environment::self) '(actor) #false))
            (let addr (process::address p))
            (process::run p 5)
            (process::park p)
            (process::run (process::spawn sender (list addr) (environment::self) '(actor) #false) 10))
    `);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    assert.equal(rt.deadLetters.length, 1);
    assert.equal(print(rt.deadLetters[0]!.msg), 'lost');
});

test('several receivers: a durable mailbox keeps messages for a parked receiver', async () => {
    const { rt, result } = await boot(`
        (defun taker () (actor::recv))
        (defun main ()
            (let mb (mailbox::create #true 10))
            (let p (process::spawn taker () (environment::self) '(actor) mb))
            (process::run p 5)
            (let parked (process::park p))
            (mailbox::send mb 7)
            (process::run (process::unpark parked (environment::self)) 5))
    `);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    assert.equal(print((result as { ok: true; v: Value }).v), '(exited 7)');
    assert.equal(rt.deadLetters.length, 0);
});

test('several receivers: a mailbox that has never had a receiver keeps its messages', async () => {
    const v = await ok(`
        (defun taker () (actor::recv))
        (defun main ()
            (let mb (mailbox::create #false 10))
            (mailbox::send mb 9)
            (process::run (process::spawn taker () (environment::self) '(actor) mb) 5))
    `);
    assert.equal(print(v), '(exited 9)');
});

// ---------------------------------------------------------------------------
// set-env: a pending call reaches the new code
// ---------------------------------------------------------------------------

test('process::set-env: a call pending in a blocked process reaches the new code', async () => {
    const otherEnv = buildEnv('(defun helper () :new)');
    const v = await ok(
        `
            (defun helper () :old)
            (defun waiter () (let m (actor::recv)) (helper))
            (defun main ()
                (let p (process::spawn waiter () (environment::self) '(actor) #false))
                (let r1 (process::run p 5))
                (process::set-env p other-env)
                (mailbox::send (process::address p) :go)
                (let r2 (process::run p 20))
                (cons r1 (cons r2 ())))
    `,
        [['other-env', { t: 'env', env: otherEnv }]]
    );
    const [r1, r2] = arr(v);
    assert.equal(print(r1!), '(blocked recv)');
    assert.equal(print(r2!), '(exited new)');
});

// ---------------------------------------------------------------------------
// not-granted for a process calling process::
// ---------------------------------------------------------------------------

test('not-granted: a process calling process:: without that grant fails', async () => {
    const v = await ok(`
        (defun bad () (process::state 0))
        (defun main ()
            (let p (process::spawn bad () (environment::self) '() #false))
            (process::run p 5))
    `);
    const rarr = arr(v);
    assert.equal((rarr[0] as Sym).name, 'failed');
    const e = rarr[1] as ErrorValue;
    assert.equal(e.tag.name, 'not-granted');
});

// ---------------------------------------------------------------------------
// environment::error-pad and environment::error-env
// ---------------------------------------------------------------------------

test('environment::error-pad and environment::error-env', async () => {
    const v = await ok(`
        (defun thrower (x)
            (let y (+ x 1))
            (throw (make-error :oops "boom" y)))
        (defun main ()
            (catch
                (thrower 10)
                e
                (do
                    (let pad0 (environment::error-pad e 0))
                    (let env0 (environment::error-env e))
                    (cons pad0 (cons (environment::binding-hash env0) ())))))
    `);
    const [pad0, hash] = arr(v);
    const pad0arr = arr(pad0!).map((entry) => arr(entry));
    assert.equal(pad0arr.length, 2);
    assert.equal((pad0arr[0]![0] as Sym).name, 'y'); // innermost first
    assert.equal(print(pad0arr[0]![1]!), '11');
    assert.equal((pad0arr[1]![0] as Sym).name, 'x');
    assert.equal(print(pad0arr[1]![1]!), '10');
    assert.equal(hash!.t, 'str');
    assert.ok((hash as { v: string }).v.length > 0);
});

test('environment::closure-pad reads a closure\'s captured local scope', async () => {
    const v = await ok(`
        (defun main ()
            (let x 7)
            (let f (lambda () x))
            (environment::closure-pad f))
    `);
    const padArr = arr(v).map((entry) => arr(entry));
    assert.equal(padArr.length, 1);
    assert.equal((padArr[0]![0] as Sym).name, 'x');
    assert.equal(print(padArr[0]![1]!), '7');
});

// ---------------------------------------------------------------------------
// timer::sleep with host::wait advancing the virtual clock
// ---------------------------------------------------------------------------

test('timer::sleep blocks a process; host::wait advances the virtual clock', async () => {
    const v = await ok(`
        (defun sleeper (ms) (timer::sleep ms) :awake)
        (defun main ()
            (let p (process::spawn sleeper (cons 100 ()) (environment::self) '(timer) #false))
            (let r1 (process::run p 5))
            (let t0 (host::now))
            (let ready (host::wait #false))
            (let t1 (host::now))
            (let r2 (process::run p 5))
            (let ready2 (host::wait #false))
            (cons r1 (cons t0 (cons ready (cons t1 (cons r2 (cons ready2 ())))))))
    `);
    const [r1, t0, ready, t1, r2, ready2] = arr(v);
    assert.equal(print(r1!), '(blocked host)');
    assert.equal(print(t0!), '0');
    const readyArr = arr(ready!);
    assert.equal(readyArr.length, 1);
    assert.equal(readyArr[0]!.t, 'pid');
    assert.equal(print(t1!), '100');
    assert.equal(print(r2!), '(exited awake)');
    assert.equal(print(ready2!), '()'); // nothing pending: returns at once
});

test('host::wait with a timeout shorter than the earliest deadline advances only to the timeout', async () => {
    const v = await ok(`
        (defun sleeper (ms) (timer::sleep ms) :awake)
        (defun main ()
            (let p (process::spawn sleeper (cons 100 ()) (environment::self) '(timer) #false))
            (let r1 (process::run p 5))
            (let ready (host::wait 10))
            (let t1 (host::now))
            (cons ready (cons t1 ())))
    `);
    const [ready, t1] = arr(v);
    assert.equal(print(ready!), '()');
    assert.equal(print(t1!), '10');
});

// ---------------------------------------------------------------------------
// A failing main
// ---------------------------------------------------------------------------

test('a failing main reports the error through boot\'s return value', async () => {
    const e = await failedBoot(`
        (defun main () (throw (make-error :oops "boom" 42)))
    `);
    assert.equal(e.tag.name, 'oops');
    assert.equal(print(e.payload), '42');
});

// ---------------------------------------------------------------------------
// Extra coverage: watchers/lifecycle signals, dead letters, IO::print
// ---------------------------------------------------------------------------

test('process::watch: an address watcher gets a terminated signal, appended like any message', async () => {
    const v = await ok(`
        (defun worker () 5)
        (defun main ()
            (let w (process::spawn worker () (environment::self) '() #false))
            (let watchmb (mailbox::create #false 10))
            (process::watch w watchmb)
            (process::run w 5)
            (mailbox::take watchmb))
    `);
    const sigArr = arr(v);
    assert.equal((sigArr[0] as Sym).name, 'signal');
    assert.equal((sigArr[1] as Sym).name, 'terminated');
    assert.equal(sigArr[2]!.t, 'pid');
    assert.equal(print(sigArr[3]!), '(exited 5)');
});

test('dead letters: a send to a non-durable mailbox whose process has ended is recorded', async () => {
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual' });
    const env = buildEnv(`
        (defun worker () 1)
        (defun main ()
            (let w (process::spawn worker () (environment::self) '() #false))
            (let addr (process::address w))
            (process::run w 5)
            (mailbox::send addr :too-late)
            addr)
    `);
    const result = await rt.boot(env);
    assert.equal(result.ok, true);
    assert.equal(rt.deadLetters.length, 1);
    assert.equal(print(rt.deadLetters[0]!.msg), 'too-late');
});

test('IO::print writes space-separated, newline-terminated, strings unquoted', async () => {
    const { output } = await boot(`
        (defun main () (IO::print "hi" 42 :tag))
    `);
    assert.deepEqual(output, ['hi 42 tag']);
});

test('a PID returned by host::wait is eq? to the one process::spawn returned', async () => {
    const v = await ok(`
        (defun napper () (timer::sleep 10))
        (defun main ()
            (let p (process::spawn napper () (environment::self) '(timer) #false))
            (process::run p 100)
            (eq? (car (host::wait #false)) p))
    `);
    assert.equal(print(v), '#true');
});
