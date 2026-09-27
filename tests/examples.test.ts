// The programs in examples/ are the ones TUTORIAL.md walks through. Each test
// runs one with its exact expected output, so the tutorial and the examples
// stay true as the prototype changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadFiles } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';
import { read } from '../src/reader.ts';
import { HeadlessTui } from '../src/tui/headless.ts';

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

async function run(...files: string[]): Promise<{ output: string[]; failure: string | null }> {
    const env = loadFiles(files.map((f) => path.join(examples, f)));
    const output: string[] = [];
    const result = await new Runtime({ out: (line) => output.push(line), clock: 'virtual' }).boot(env);
    return { output, failure: result.ok ? null : print(result.e) };
}

test('hello.slight', async () => {
    assert.deepEqual(await run('hello.slight'), { output: ['hello, world 42'], failure: null });
});

test('roles.slight', async () => {
    assert.deepEqual(await run('roles.slight'), {
        output: [
            'needs (actor::recv actor::send born survives member?)',
            'unfilled (born survives member?)',
            'conway 1 0',
            'seeds 0 1',
            'changed (born survives)',
        ],
        failure: null,
    });
});

test('tour.slight', async () => {
    assert.deepEqual(await run('tour.slight'), {
        output: [
            'counting down',
            'sum 5050',
            'red warm green unknown',
            'twice 45',
            'list (1 two three)',
        ],
        failure: null,
    });
});

test('errors.slight: a caught chain, then an uncaught error', async () => {
    const file = path.join(examples, 'errors.slight');
    assert.deepEqual(await run('errors.slight'), {
        output: [
            'tag bad-user cause bad-age',
            `trace ((parse-age ${file} 3 9) (load-user ${file} 7 5) (main ${file} 12 12) (main ${file} 12 12))`,
        ],
        failure: '#<error bad-user "could not load user">',
    });
});

test('processes.slight', async () => {
    assert.deepEqual(await run('processes.slight'), {
        output: [
            'state (ready)',
            'run1 (blocked recv)',
            'state (blocked recv)',
            'state (ready)',
            'run2 (quota)',
            'g got hello',
            'run3 (blocked recv)',
            'checkpoint (g)',
            'sneaky (not-granted host)',
        ],
        failure: null,
    });
});

test('actors/ping-pong.slight on the actors.slight system', async () => {
    assert.deepEqual(await run('actors/actors.slight', 'actors/ping-pong.slight'), {
        output: [
            '[system] spawned pong',
            '[system] spawned ping',
            '[system] pong (blocked recv)',
            '[system] ping (blocked recv)',
            'pong: got ping 3',
            '[system] pong (blocked recv)',
            'ping: got pong 3',
            '[system] ping (blocked recv)',
            'pong: got ping 2',
            '[system] pong (blocked recv)',
            'ping: got pong 2',
            '[system] ping (blocked recv)',
            'pong: got ping 1',
            '[system] pong (blocked recv)',
            'ping: got pong 1',
            '[system] ping (exited done)',
            '[system] stopping idle pong',
        ],
        failure: null,
    });
});

// The TUI examples, headless, on the virtual clock.

async function runTui(files: string[], input: string[] = []): Promise<{ frames: string[]; output: string[]; failure: string | null }> {
    const tui = new HeadlessTui({ columns: 80, rows: 30, input: input.map((s) => read(s, 'input')[0]!) });
    const output: string[] = [];
    const result = await new Runtime({ out: (line) => output.push(line), clock: 'virtual', tui: () => tui })
        .boot(loadFiles(files.map((f) => path.join(examples, '..', f))));
    return { frames: tui.frames, output, failure: result.ok ? null : print(result.e) };
}

test('tui/life.slight draws every generation, paced on the clock', async () => {
    const { frames, failure } = await runTui(['examples/life/lib/lists.slight', 'examples/life/lib/life.slight', 'examples/tui/life.slight']);
    assert.equal(failure, null);
    assert.equal(frames.length, 33);
    assert.equal(frames.at(-1), [
        ' ╭──────────────────╮',
        ' │ ················ │  Game of Life',
        ' │ ················ │  generation 32',
        ' │ ················ │  live cells 0',
        ' │ ················ │  elapsed ms 3840',
        ' │ ················ │  population',
        ' │ ················ │  ▃▃▃▃▃▃▃▄▄▄▄▄▅▅█▇▆▅▄▃▂▃▃▂▃▂▂▁▁▁▁▁▁',
        ' │ ················ │',
        ' │ ················ │',
        ' ╰──────────────────╯',
    ].join('\n'));
});

test('tui/top.slight: scheduling, a failure, and the keys (select, kill, pause, step, quota, quit)', async () => {
    // Scripted input arrives in place of time passing: 40 rounds, each ended
    // by a resize event, then the keys.
    const rounds = Array.from({ length: 40 }, () => '(resize 80 30)');
    const keys = ['(key down ())', '(key down ())', '(key down ())', '(key down ())', '(key down ())',
        '(key "k" ())', '(key " " ())', '(key "s" ())', '(key "+" ())', '(key "q" ())'];
    const { frames, output, failure } = await runTui(['examples/life/lib/lists.slight', 'examples/tui/top.slight'], [...rounds, ...keys]);
    assert.equal(failure, null);
    assert.equal(frames.length, 50);
    assert.equal(frames.at(-1), [
        '╭────────────────────────────────────────────────────────────────────╮',
        '│ CPI top  round 47 · quota 400 ticks · paused                       │',
        '│                                                                    │',
        '│   name      state           last stop                     runs     │',
        '│   counter   (ready)         (quota)                       47       │',
        '│   napper    (blocked host)  (blocked host)                1        │',
        '│   echo      (ready)         (blocked recv)                47       │',
        '│   caller    (blocked recv)  (blocked recv)                47       │',
        '│   doomed    (ended failed … (failed #<error boom "reache… 28       │',
        '│ > waiter    (ended killed … (blocked recv)                1        │',
        '│                                                                    │',
        '│ quota 400 ticks                                                    │',
        '│ paused                                                             │',
        '│ killed waiter                                                      │',
        '│ doomed (failed #<error boom "reached 300">)                        │',
        '│ started 6 processes                                                │',
        '│                                                                    │',
        '│ space pause · s step · ↑↓ select · k kill · +/- quota · q quit     │',
        '╰────────────────────────────────────────────────────────────────────╯',
    ].join('\n'));
    assert.deepEqual(output, ['top: quit after 47 rounds']);
});

test('tui/counter.slight: keys change the count, q quits', async () => {
    const { frames, output, failure } = await runTui(['examples/tui/counter.slight'],
        ['(key up ())', '(key up ())', '(key "x" ())', '(key down ())', '(resize 80 30)', '(key up ())', '(key "q" ())']);
    assert.equal(failure, null);
    assert.deepEqual(frames.map((f) => f.split('\n')[1]), [
        '│ count 0  ↑/↓ change · q quit │',
        '│ count 1  ↑/↓ change · q quit │',
        '│ count 2  ↑/↓ change · q quit │',
        '│ count 2  ↑/↓ change · q quit │',
        '│ count 1  ↑/↓ change · q quit │',
        '│ count 1  ↑/↓ change · q quit │',
        '│ count 2  ↑/↓ change · q quit │',
    ]);
    assert.deepEqual(output, ['final count 2']);
});
