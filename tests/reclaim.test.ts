// Reclaiming what nothing can name (DECISIONS.md): a process that has ended,
// and a mailbox, are kept while a value refers to their PID or address, and
// collected after. These tests take a WeakRef to every entry as the runtime
// stores it, drop what they don't keep, and collect garbage themselves.

import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import type { Value } from '../src/types.ts';
import { loadSource } from '../src/loader.ts';
import { sym } from '../src/values.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

// A WeakRef to every value stored in `table`, a runtime's Map or WeakMap.
function watch(table: { set(key: unknown, value: object): unknown }): WeakRef<object>[] {
    const refs: WeakRef<object>[] = [];
    const set = table.set.bind(table);
    table.set = (key: unknown, value: object) => {
        refs.push(new WeakRef(value));
        return set(key, value);
    };
    return refs;
}

// Boots `src` and returns main's value, with the runtime and the WeakRefs to
// the process entries and mailbox entries it made.
async function run(src: string) {
    const rt = new Runtime({ out: () => {}, clock: 'virtual' });
    const internals = rt as unknown as { procs: Map<number, object>; mailboxes: WeakMap<object, object> };
    const procs = watch(internals.procs);
    const mailboxes = watch(internals.mailboxes);
    const result = await rt.boot(loadSource(src, 'reclaim'));
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    return { rt, v: (result as { v: Value }).v, procs, mailboxes };
}

// What is left of `refs` after a full collection. A WeakRef keeps its target
// until the task that made it ends, so this waits for the next one first.
async function survivors(refs: readonly WeakRef<object>[]): Promise<any[]> {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    return refs.map((r) => r.deref()).filter((x) => x !== undefined);
}

const answer = (r: { kind: string; v?: Value }) => (r.kind === 'value' ? print(r.v!) : r.kind);

test('an ended process and its mailbox are collected once nothing names them, and kept while something does', async () => {
    const { rt, v: kept, procs, mailboxes } = await run(`
        (defun quit () :done)
        (defun spawn-all (n acc)
            (if (= n 0)
                acc
                (spawn-all (- n 1) (cons (process::spawn quit () (environment::self) '() #false) acc))))
        (defun run-all (ps)
            (when (not (nil? ps))
                (do
                    (process::run (car ps) 10)
                    (run-all (cdr ps)))))
        (defun main ()
            (let ps (spawn-all 20 ()))
            (run-all ps)
            (car ps))
    `);
    assert.equal(procs.length, 20);
    assert.equal(mailboxes.length, 20);
    const entries = await survivors(procs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].pidV, kept);
    assert.deepEqual(await survivors(mailboxes), [entries[0].mbox]);
    // What can still be asked of it.
    assert.equal(answer(rt.processState(kept)), '(ended exited done)');
    assert.equal(answer(rt.processCheckpoint(kept)), '()');
    assert.match(answer(rt.processTicks(kept)), /^[1-9][0-9]*$/);
});

test('a process that has not ended is kept, whether or not anything names it', async () => {
    const { rt, procs, mailboxes } = await run(`
        (defun waiter () (actor::recv))
        (defun main ()
            (let box (mailbox::create #true 10))
            (let p (process::spawn waiter () (environment::self) '(actor) box))
            (process::run p 10)
            :dropped)
    `);
    const entries = await survivors(procs);
    assert.equal(entries.length, 1);
    assert.equal(answer(rt.processState(entries[0].pidV)), '(blocked recv)');
    // Its entry holds its address, so its mailbox stays too, and a message
    // to it still wakes the process.
    assert.deepEqual(await survivors(mailboxes), [entries[0].mbox]);
    assert.equal(answer(rt.mailboxSend(entries[0].addr, sym('hello'))), '#true');
    assert.equal(answer(rt.processState(entries[0].pidV)), '(ready)');
});

test('a mailbox without a process is kept while its address is', async () => {
    const { rt, v: kept, mailboxes } = await run(`
        (defun make (n acc)
            (if (= n 0) acc (make (- n 1) (cons (mailbox::create #false 1) acc))))
        (defun main ()
            (let boxes (make 10 ()))
            (mailbox::send (car boxes) :hello)
            (car boxes))
    `);
    assert.equal(mailboxes.length, 10);
    assert.equal((await survivors(mailboxes)).length, 1);
    assert.equal(answer(rt.mailboxSize(kept)), '1');
    assert.equal(answer(rt.mailboxTake(kept)), 'hello');
});
