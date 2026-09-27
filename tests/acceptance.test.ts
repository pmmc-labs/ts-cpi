// Acceptance programs (task brief "Task A"): each `.slight` program under
// tests/programs/ is loaded with loadFiles, booted with a Runtime whose
// output goes to an array, and the exact output lines are asserted. Every
// run is deterministic (virtual time, in-process scheduling), so exact
// assertions are appropriate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadFiles } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';
import type { ErrorValue, Value } from '../src/types.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const programsDir = path.join(dir, 'programs');

function programPath(name: string): string {
    return path.join(programsDir, name);
}

// Loads and boots a program, returning its printed output lines and the
// boot result. Fails the test immediately (with the error printed) if the
// CPI itself fails, unless `allowFailure` is set.
async function runProgram(name: string): Promise<{ output: string[]; result: { ok: true; v: Value } | { ok: false; e: ErrorValue } }> {
    const env = loadFiles([programPath(name)]);
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual' });
    const result = await rt.boot(env);
    return { output, result };
}

async function expectOk(name: string): Promise<{ output: string[]; v: Value }> {
    const { output, result } = await runProgram(name);
    assert.equal(result.ok, true, result.ok ? '' : `CPI failed: ${print((result as { ok: false; e: ErrorValue }).e)}`);
    return { output, v: (result as { ok: true; v: Value }).v };
}

// ---------------------------------------------------------------------------
// Scenario 1: scheduler
// ---------------------------------------------------------------------------

test('scenario 1: round-robin scheduler over two ping-pong actors', async () => {
    const { output, v } = await expectOk('scheduler.slight');
    assert.deepEqual(output, [
        'stop (blocked recv)',
        'stop (quota)',
        'a recv 5',
        'stop (quota)',
        'b recv 5',
        'stop (quota)',
        'stop (quota)',
        'stop (quota)',
        'a recv 4',
        'stop (quota)',
        'b recv 4',
        'stop (quota)',
        'stop (quota)',
        'stop (quota)',
        'a recv 3',
        'stop (quota)',
        'b recv 3',
        'stop (quota)',
        'stop (quota)',
        'stop (quota)',
        'stop (blocked recv)',
        'b recv 2',
        'stop (quota)',
        'a recv 2',
        'stop (quota)',
        'stop (quota)',
        'stop (quota)',
        'b recv 1',
        'stop (quota)',
        'a recv 1',
        'stop (quota)',
        'stop (quota)',
        'a done',
        'stop (quota)',
        'b done',
        'stop (exited done)',
        'stop (exited done)',
    ]);
    assert.equal(print(v), 'done');
});

// ---------------------------------------------------------------------------
// Scenario 2: tail calls
// ---------------------------------------------------------------------------

test('scenario 2: a 1,000,000-iteration tail loop runs in constant space, both in the CPI and in a process', async () => {
    const before = process.memoryUsage().heapUsed;
    const { output } = await expectOk('tailcalls.slight');
    const after = process.memoryUsage().heapUsed;
    assert.deepEqual(output, ['cpi done', 'process (exited done)']);
    // A loose bound: a million-deep non-tail recursion would balloon the heap
    // by tens of megabytes at least. Constant-space tail calls should not.
    const grownBy = after - before;
    assert.ok(grownBy < 200 * 1024 * 1024, `heap grew by ${grownBy} bytes, expected roughly constant space`);
});

// ---------------------------------------------------------------------------
// Scenario 3: errors
// ---------------------------------------------------------------------------

test('scenario 3: catch, wrap-error, error-cause, stack-trace-for, already-thrown, error-pad', async () => {
    const { output, v } = await expectOk('errors.slight');
    const file = programPath('errors.slight');
    assert.deepEqual(output, [
        'tag wrapped',
        'message middle wrapped it',
        'cause-tag fail',
        'cause-message bad y',
        'cause-of-cause #false',
        `trace-outer ((middle ${file} 11 9) (main ${file} 15 17) (main ${file} 15 17))`,
        `trace-cause ((compute ${file} 6 5) (middle ${file} 9 5) (main ${file} 15 17) (main ${file} 15 17))`,
        'pad ((y 42) (x 21))',
        'r1 boom',
        'r2 already-thrown',
        'r2-payload-tag boom',
    ]);
    assert.equal(print(v), 'done');
});

// ---------------------------------------------------------------------------
// Scenario 4: restart from checkpoint
// ---------------------------------------------------------------------------

test('scenario 4: an actor restarts from its checkpoint after failing, on the same durable mailbox', async () => {
    const { output, v } = await expectOk('restart.slight');
    assert.deepEqual(output, [
        'count 1',
        'count 2',
        'stop failed',
        'error-tag boom',
        'checkpoint (2)',
        'count 3',
        'restarted-stop blocked',
    ]);
    assert.equal(print(v), 'done');
});

// ---------------------------------------------------------------------------
// Scenario 5: traps
// ---------------------------------------------------------------------------

test('scenario 5: a trapped send effect is performed by the CPI and the actor is resumed', async () => {
    const { output } = await expectOk('traps.slight');
    assert.deepEqual(output, [
        'stop trap',
        'effect send',
        'final (exited sent)',
        'mailbox-size 1',
    ]);
});

// ---------------------------------------------------------------------------
// Scenario 6: parking
// ---------------------------------------------------------------------------

test('scenario 6: a blocked actor is parked, unparked into its environment, and wakes on a message', async () => {
    const { output } = await expectOk('parking.slight');
    assert.deepEqual(output, [
        'r1 blocked',
        'parked-tag parked',
        'got hello',
        'r2 (exited hello)',
    ]);
});

// ---------------------------------------------------------------------------
// Scenario 7: timers
// ---------------------------------------------------------------------------

test('scenario 7: two actors sleeping for different virtual durations wake in virtual-time order', async () => {
    const { output } = await expectOk('timers.slight');
    assert.deepEqual(output, [
        'time 50',
        'b woke',
        'time 100',
        'a woke',
        'time 100',
    ]);
});
