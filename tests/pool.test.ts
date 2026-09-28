// The plan's pool node (DECISIONS.md, Spec changes; DESIGN-PLAN.md step 4)
// against its reference, the CPI loop in tests/programs/pool-reference.slight:
// the same scenario runs under both, and the events, their times and the
// order the work was done in must be the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadSource } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';

const reference = path.join(path.dirname(fileURLToPath(import.meta.url)), 'programs', 'pool-reference.slight');

// Workers warm up, then take numbers off one queue and pass each to a sink
// with how many that worker has done, so a worker taken back from cold
// storage shows which one it was. A feeder sends bursts: seven at 100 ms,
// two at 2600 ms and four at 2650 ms.
const scenario = `
    (defun worker-code ()
        (role
            (require actor::recv actor::send)
            (defun worker (sink)
                (spin 200)
                (serve sink 0))
            (defun serve (sink done)
                (let n (actor::recv))
                (spin 30)
                (actor::send sink (list n (+ done 1)))
                (serve sink (+ done 1)))
            (defun spin (n) (if (= n 0) #true (spin (- n 1))))))

    (defun feeder-code ()
        (role
            (require actor::send timer::sleep)
            (defun feeder (queue)
                (timer::sleep 100)
                (send-all queue 1 7)
                (timer::sleep 2500)
                (send-all queue 8 2)
                (timer::sleep 50)
                (send-all queue 10 4))
            (defun send-all (queue i n)
                (when (> n 0)
                    (actor::send queue i)
                    (send-all queue (+ i 1) (- n 1))))))

    (defun run-until-blocked (p)
        (when (eq? (car (process::run p 1000)) :quota) (run-until-blocked p)))

    (defun drain (box) (let m (mailbox::take box)) (if m (cons m (drain box)) ()))

    ; (template env sink): a worker warmed and parked, the environment its
    ; copies run in, and where their work goes. The feeder is started.
    (defun setup ()
        (let queue (mailbox::create #true 100))
        (let sink (mailbox::create #true 100))
        (let env (environment::resolve (worker-code) '(actor)))
        (let w (process::spawn (environment::lookup env 'worker) (list sink) env '(actor) queue))
        (run-until-blocked w)
        (let template (process::park w))
        (let fenv (environment::resolve (feeder-code) '(actor timer)))
        (process::spawn (environment::lookup fenv 'feeder) (list queue) fenv '(actor timer) #false)
        (list template env sink))
`;

async function run(main: string) {
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual' });
    let env = loadSource(readFileSync(reference, 'utf-8'), reference);
    env = loadSource(scenario + main, 'test', env);
    const result = await rt.boot(env);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    return { output, done: print((result as { v: import('../src/types.ts').Value }).v) };
}

test('pool: the node runs the scenario exactly as its reference CPI loop does', async () => {
    const node = await run(`
        (defun main ()
            (let s (setup))
            (node-loop (list (list 'round 40 #false) (list 'pool "w" (car s) (car (cdr s)) 1 3 1000)) 6000)
            (drain (car (cdr (cdr s)))))
        (defun node-loop (plan end)
            (when (< (host::now) end)
                (print-all (plan::run plan (- end (host::now))))
                (node-loop plan end)))
        (defun print-all (events)
            (when (not (nil? events))
                (IO::print (host::now) (car events))
                (print-all (cdr events))))
    `);
    const byReference = await run(`
        (defun main ()
            (let s (setup))
            (ref-run 40 (car s) (car (cdr s)) 1 3 1000 6000)
            (drain (car (cdr (cdr s)))))
    `);
    assert.deepEqual(node, byReference);
    // What the scenario shows: the pool fills to its minimum, grows by one
    // worker a round to its maximum under the first burst, parks the idle
    // down to its minimum a second later, takes workers back from cold
    // storage (newest first) for the next bursts, and parks them again.
    assert.deepEqual(node.output, [
        '0 (#<pid 3> (joined w template))',
        '100 (#<pid 4> (joined w template))',
        '100 (#<pid 5> (joined w template))',
        '1100 (#<pid 3> (left w))',
        '1100 (#<pid 4> (left w))',
        '2600 (#<pid 6> (joined w cold))',
        '2650 (#<pid 7> (joined w cold))',
        '2650 (#<pid 2> (exited ()))',
        '3650 (#<pid 5> (left w))',
        '3650 (#<pid 6> (left w))',
    ]);
    // Each item with how many its worker had done. Worker 3 did three of
    // the first burst and worker 4 two; both were parked, 4 last, so 4 comes
    // back first (item 9, its third) and 3 next (item 12, its fourth).
    assert.equal(node.done, '((1 1) (2 1) (3 1) (4 2) (5 2) (6 2) (7 3) (8 3) (9 3) (10 4) (11 4) (12 4) (13 5))');
});

test('pool: a pool node is (pool name template env min max idle), one per name, with parked data as its template', async () => {
    const { done } = await run(`
        (defun main ()
            (let s (setup))
            (let t (car s))
            (let env (car (cdr s)))
            (list
                (catch (plan::run (list (list 'pool 'w t env 1 3 1000)) 0) e (error-tag e))
                (catch (plan::run (list (list 'pool "w" '(parked 99 () "h" 1) env 1 3 1000)) 0) e (error-tag e))
                (catch (plan::run (list (list 'pool "w" t 5 1 3 1000)) 0) e (error-tag e))
                (catch (plan::run (list (list 'pool "w" t env 3 1 1000)) 0) e (error-tag e))
                (catch (plan::run (list (list 'pool "w" t env 1 3)) 0) e (error-tag e))
                (catch (plan::run (list (list 'pool "w" t env 1 3 1000) (list 'pool "w" t env 1 3 1000)) 0) e (error-tag e))))
    `);
    assert.equal(done, '(type-error type-error type-error type-error type-error type-error)');
});
