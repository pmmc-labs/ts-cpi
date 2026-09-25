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

function boot(src: string, extra: ReadonlyArray<readonly [string, Value]> = []) {
  const output: string[] = [];
  const rt = new Runtime({ out: (line) => output.push(line) });
  const env = buildEnv(src, extra);
  const result = rt.boot(env);
  return { rt, result, output };
}

function ok(src: string, extra: ReadonlyArray<readonly [string, Value]> = []): Value {
  const { result } = boot(src, extra);
  assert.equal(result.ok, true, result.ok ? '' : print((result as { e: ErrorValue }).e));
  return (result as { ok: true; v: Value }).v;
}

function failedBoot(src: string): ErrorValue {
  const { result } = boot(src);
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

test('spawn and run to exit', () => {
  const v = ok(`
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

test('quota: preemption at n ticks, then resuming to completion', () => {
  const v = ok(`
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

test('send and recv between two processes: delivery at the batch boundary', () => {
  const v = ok(`
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

test('a blocked-recv process becomes ready when a message arrives', () => {
  const v = ok(`
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

test('join: blocks until the target ends, then reports its detail', () => {
  const v = ok(`
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

test('traps: process::resume answers a trapped send', () => {
  const v = ok(`
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

test('traps: process::resume-throw answers a trapped send by throwing', () => {
  const v = ok(`
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

test('process::checkpoint reads the most recent call after a failure', () => {
  const v = ok(`
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
// Park, then unpark and continue
// ---------------------------------------------------------------------------

test('park then unpark: the unparked process re-attempts recv and continues', () => {
  const v = ok(`
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
// set-env: a pending call reaches the new code
// ---------------------------------------------------------------------------

test('process::set-env: a call pending in a blocked process reaches the new code', () => {
  const otherEnv = buildEnv('(defun helper () :new)');
  const v = ok(
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

test('not-granted: a process calling process:: without that grant fails', () => {
  const v = ok(`
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

test('environment::error-pad and environment::error-env', () => {
  const v = ok(`
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

test('environment::closure-pad reads a closure\'s captured local scope', () => {
  const v = ok(`
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

test('timer::sleep blocks a process; host::wait advances the virtual clock', () => {
  const v = ok(`
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

test('host::wait with a timeout shorter than the earliest deadline advances only to the timeout', () => {
  const v = ok(`
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

test('a failing main reports the error through boot\'s return value', () => {
  const e = failedBoot(`
    (defun main () (throw (make-error :oops "boom" 42)))
  `);
  assert.equal(e.tag.name, 'oops');
  assert.equal(print(e.payload), '42');
});

// ---------------------------------------------------------------------------
// Extra coverage: watchers/lifecycle signals, dead letters, IO::print
// ---------------------------------------------------------------------------

test('process::watch: an address watcher gets a terminated signal, appended like any message', () => {
  const v = ok(`
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

test('dead letters: a send to a non-durable mailbox whose process has ended is recorded', () => {
  const output: string[] = [];
  const rt = new Runtime({ out: (line) => output.push(line) });
  const env = buildEnv(`
    (defun worker () 1)
    (defun main ()
      (let w (process::spawn worker () (environment::self) '() #false))
      (let addr (process::address w))
      (process::run w 5)
      (mailbox::send addr :too-late)
      addr)
  `);
  const result = rt.boot(env);
  assert.equal(result.ok, true);
  assert.equal(rt.deadLetters.length, 1);
  assert.equal(print(rt.deadLetters[0]!.msg), 'too-late');
});

test('IO::print writes space-separated, newline-terminated, strings unquoted', () => {
  const { output } = boot(`
    (defun main () (IO::print "hi" 42 :tag))
  `);
  assert.deepEqual(output, ['hi 42 tag']);
});
