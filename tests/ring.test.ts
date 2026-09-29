// The ring benchmark (examples/ring): the three ways of running a ring must
// agree, and the benchmark's tables must print. Both run small rings on the
// virtual clock, where every time is 0 and everything else is exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { Env } from '../src/types.ts';
import { loadFiles, loadSource } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';

const ring = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'ring');
const files = (...names: string[]) => loadFiles(names.map((f) => path.join(ring, f)));

async function run(env: Env): Promise<string[]> {
    const output: string[] = [];
    const result = await new Runtime({ out: (line) => output.push(line), clock: 'virtual' }).boot(env);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    return output;
}

// Loops are rounds for process::run and process::run-ready, and calls for
// plan::run, which returns when processes end: with PIDs rising, the relays
// all exit in the last lap's round and the head in the next. A ring takes
// M + 1 rounds, except by process::run-ready with PIDs falling and N > 1:
// then every hop but one a lap waits for the next round, (N - 1) * M + 1
// in all.
test('check.slight: every scheduler agrees on every ring', async () => {
    assert.deepEqual(await run(files('ring.slight', 'check.slight')), [
        'N 1 M 3 rising | 3 messages | loops (4 4 1) | agree',
        'N 2 M 3 rising | 6 messages | loops (4 4 2) | agree',
        'N 5 M 4 rising | 20 messages | loops (5 5 2) | agree',
        'N 40 M 3 rising | 120 messages | loops (4 4 2) | agree',
        'N 1 M 3 falling | 3 messages | loops (4 4 1) | agree',
        'N 2 M 3 falling | 6 messages | loops (4 4 1) | agree',
        'N 5 M 4 falling | 20 messages | loops (5 17 4) | agree',
        'N 40 M 3 falling | 120 messages | loops (4 118 39) | agree',
    ]);
});

test('the benchmark tables, on small rings', async () => {
    files('ring.slight', 'bench.slight');   // the benchmark itself loads
    const env = loadSource(`(defun main ()
    (let env (environment::resolve (ring-code) '(actor)))
    (ring-table env '((3 2) (10 100)) 2)
    (order-table env '((5 4) (100 10)) 1))`, 'tables', files('ring.slight'));
    assert.deepEqual(await run(env), [
        '      N       M  messages  spawn ms  process::run  process::run-ready  plan::run',
        '      3       2         6         0             0                   0          0',
        '     10     100     1,000         0             0                   0          0',
        '                                 run-ready       run-ready    process::run',
        '                               PIDs rising    PIDs falling    PIDs falling',
        '       N       M  messages   rounds     ms   rounds     ms   rounds     ms',
        '       5       4        20        5      0       17      0        5      0',
        '     100      10     1,000       11      0      991      0       11      0',
    ]);
});
