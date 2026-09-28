// The plan's monitor node (DECISIONS.md, Spec changes; DESIGN-PLAN.md step 3)
// against its reference, the actor in tests/programs/monitor-reference.slight:
// both are sent the same messages, and every summary must be the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadSource } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';
import { listToArray } from '../src/values.ts';
import { HeadlessTui } from '../src/tui/headless.ts';

const reference = path.join(path.dirname(fileURLToPath(import.meta.url)), 'programs', 'monitor-reference.slight');

async function boot(main: string, tui?: HeadlessTui) {
    const rt = new Runtime({ out: () => {}, clock: 'virtual', ...(tui === undefined ? {} : { tui: () => tui }) });
    let env = loadSource(readFileSync(reference, 'utf-8'), reference);
    env = loadSource(main, 'test', env);
    const result = await rt.boot(env);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    return (result as { v: import('../src/types.ts').Value }).v;
}

// Messages as they come from the host: served log entries (SPEC-HTTP
// section 6), queue samples, ticks and new seconds.
const messages = `
    (list
        '(served 8080 get ("hello" "ada") 200 0 1 3)
        '(served 8080 get ("hello" "bob") 200 0 2 9)
        '(served 8080 get ("counter" "ada") 200 1 1 1)
        '(served 8080 get ("nope") 404 1 1 2)
        '(served 8080 get () 404 2 2 2)
        '(served 8080 get ("hello" "x") 503 3 #false 3)
        '(sample ("hello" 2) ("system" 1))
        '(sample ("hello" 0))
        '(ticks "hello" 430)
        '(ticks "counter" 0)
        '(ticks "router" 120)
        '(second 1)
        '(second 1)
        '(served 8080 get ("system" "stats") 200 1000 1000 1000)
        '(served 8080 get ("slow") 504 1000 1001 3001)
        '(served 8080 get ("hello" "cy") 500 1500 1600 1700)
        '(served 8080 get ("counter" "bob") #false 1700 1710 1710)
        '(sample ("counter" 5) ("hello" 1))
        '(ticks "counter" 7)
        '(second 2)
        '(second 9)
        '(unknown 1)
        '(served 8080 get ("hello" "di") 200 9000 9000 9004)
        '(second 10))
`;

test('monitor: the node sends the same summaries as its reference actor, given the same messages', async () => {
    const v = await boot(`
        (defun for-each (f xs) (when (not (nil? xs)) (f (car xs)) (for-each f (cdr xs))))
        (defun drain (box) (let m (mailbox::take box)) (if m (cons m (drain box)) ()))
        (defun run-until-blocked (p)
            (when (eq? (car (process::run p 100000)) :quota) (run-until-blocked p)))
        (defun main ()
            (let rows '("hello" "counter" "slow" "router" "system" "other"))
            (let routes '("hello" "counter" "slow" "system"))
            (let bins '(1 2 5 10 20 50 100 200 500 1000))
            (let history 3)
            (let node-box (mailbox::create #true 100))
            (let node-out (mailbox::create #true 100))
            (plan::run
                (list (list 'monitor node-box node-out (cons 'rows rows) (cons 'routes routes) (cons 'bins bins) (list 'history history)))
                0)
            (let env (environment::resolve (monitor-code) '(actor)))
            (let ref-box (mailbox::create #true 100))
            (let ref-out (mailbox::create #true 100))
            (let ref (process::spawn (environment::lookup env 'monitor) (list ref-out rows routes bins history) env '(actor) ref-box))
            (for-each (lambda (m) (mailbox::send node-box m) (mailbox::send ref-box m)) ${messages})
            (run-until-blocked ref)
            (list (mailbox::size node-box) (drain node-out) (drain ref-out)))
    `);
    const [queued, node, ref] = listToArray(v)!;
    assert.equal(print(queued!), '0', 'the node takes its messages as they arrive');
    const nodeSummaries = listToArray(node!)!;
    assert.equal(nodeSummaries.length, 5, 'one at the start, and one for each new second: 1, 2, 9 and 10');
    assert.deepEqual(nodeSummaries.map(print), listToArray(ref!)!.map(print));
    // Checked by hand: after the first second, hello has had three requests
    // (ada, bob and one refused), and none in the new second so far.
    assert.match(print(nodeSummaries[1]!), /\("hello" #\(3 0 #\(/);
});

test('monitor: in a plan, the host feeds it ticks by env ref, queue lengths each round and each new second', async () => {
    const v = await boot(`
        (defun spin (n) (if (= n 0) :done (spin (- n 1))))
        (defun drain (box) (let m (mailbox::take box)) (if m (cons m (drain box)) ()))
        (defun endpoint (summary name) (endpoint-in (car (cdr (cdr (cdr summary)))) name))
        (defun endpoint-in (eps name) (if (eq? (car (car eps)) name) (car (cdr (car eps))) (endpoint-in (cdr eps) name)))
        (defun seconds (summaries) (if (nil? summaries) () (cons (car (cdr (car summaries))) (seconds (cdr summaries)))))
        (defun main ()
            (let env (environment::self))
            (let self (mailbox::create #true 10))
            (let out (mailbox::create #true 10))
            (let waiting (mailbox::create #true 10))
            (mailbox::send waiting :someone)
            ; Before the node is installed, a message waits in its mailbox.
            (mailbox::send self '(served 8080 get ("hello" "ada") 200 0 0 1))
            (let p (process::spawn spin (list 10) env '() #false))
            (let plan
                (list (list 'round 1000 #false)
                    (list 'monitor self out '(rows "hello") '(routes "hello") '(bins 1 2 5 10)
                        (list 'ticks (list "hello" env)) (list 'queues (list "hello" waiting)))))
            (let r1 (plan::run plan 2500))
            (let r2 (plan::run plan 2500))
            (let summaries (drain out))
            (let last (car (cdr (cdr summaries))))
            (let hello (endpoint last "hello"))
            (list r1 r2 (host::now) (seconds summaries) (vector-ref hello 0)
                ; The ticks p used, in the second they were used: the older of
                ; the two seconds in the history.
                (= (vector-ref (car (cdr (vector-ref hello 6))) 6) (process::ticks p))
                ; Queue samples: some, each of the one waiting message.
                (> (vector-ref (vector-ref hello 9) 0) 0) (vector-ref (vector-ref hello 9) 3)
                (mailbox::size self)))
    `);
    assert.equal(print(v), '(((#<pid 1> (exited done))) () 2500 (0 1 2) 1 #true #true 1 0)');
});

test('monitor: with a view, the node draws its template filled in, as tui::render draws it filled in by hand', async () => {
    const tui = new HeadlessTui({ columns: 60, rows: 10 });
    const v = await boot(`
        (defun waiter () (actor::recv))
        (defun view ()
            \`(Box (@ (flexDirection column))
                (Text "up " (Uptime) " · max " (Fact "max") " · requests " (Status "requests") " · 2xx " (Status "2xx"))
                (Table (@ (columns (("row" 6) ("req" 4 right) ("p95" 6 right) ("wait" 5 right) ("queue" 6 right) ("workers" 8))))
                    (Row "hello" (Metric "hello" requests) (Metric "hello" total-p95) (Metric "hello" wait-avg) (Metric "hello" queue-max)
                        ((Metric "hello" ready) "/" (Metric "hello" waiting) "/" (Metric "hello" parked))))
                (Sparkline (@ (data (Series "hello" requests)) (width 5)))))
        (defun main ()
            (tui::open 'inline)
            (let env (environment::self))
            (let self (mailbox::create #true 10))
            (let out (mailbox::create #true 10))
            (let waiting (mailbox::create #true 10))
            (mailbox::send waiting :someone)
            (process::spawn waiter () env '(actor) #false)
            (let plan
                (list (list 'round 100 #false)
                    (list 'monitor self out '(rows "hello") '(routes "hello") '(bins 1 2 5 10) (list 'ticks (list "hello" env))
                        (list 'queues (list "hello" waiting)) (list 'view (view)))))
            (mailbox::send self '(set "max" 5))
            (mailbox::send self '(served 8080 get ("hello" "ada") 200 0 1 3))
            (mailbox::send self '(served 8080 get ("hello" "bob") 200 0 2 9))
            (plan::run plan 0)
            (plan::run plan 1500)
            ; At second 1: two requests, total times 3 and 9 ms (p95 under
            ; 10 ms), waits 1 and 2 ms (1.5 on average), one message always
            ; waiting in the queue, and one process waiting in recv.
            (tui::render
                \`(Box (@ (flexDirection column))
                    (Text "up " "0:01" " · max " 5 " · requests " 2 " · 2xx " 2)
                    (Table (@ (columns (("row" 6) ("req" 4 right) ("p95" 6 right) ("wait" 5 right) ("queue" 6 right) ("workers" 8))))
                        (Row "hello" 2 "<10ms" "1.5" 1 (0 "/" 1 "/" 0)))
                    (Sparkline (@ (data (2)) (width 5)))))
            (list
                (catch (plan::run (list (list 'monitor self out '(rows "hello") '(bins 1) (list 'view '(Text (Metric "hello" nonsense))))) 0) e (error-tag e))
                (catch (plan::run (list (list 'monitor self out '(rows "hello"))) 0) e (error-tag e))))
    `, tui);
    assert.equal(print(v), '(type-error type-error)', 'a template with a field the monitor has not got; a monitor without bins');
    const frames = tui.frames;
    assert.ok(frames.length >= 3, frames.join('\n---\n'));
    assert.equal(frames[frames.length - 2], frames[frames.length - 1], 'the node drew what tui::render drew by hand');
    assert.match(frames[frames.length - 1]!, /up 0:01 · max 5 · requests 2/);
});
