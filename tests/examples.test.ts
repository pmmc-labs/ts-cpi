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

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

function run(...files: string[]): { output: string[]; failure: string | null } {
    const env = loadFiles(files.map((f) => path.join(examples, f)));
    const output: string[] = [];
    const result = new Runtime({ out: (line) => output.push(line) }).boot(env);
    return { output, failure: result.ok ? null : print(result.e) };
}

test('hello.slight', () => {
    assert.deepEqual(run('hello.slight'), { output: ['hello, world 42'], failure: null });
});

test('tour.slight', () => {
    assert.deepEqual(run('tour.slight'), {
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

test('errors.slight: a caught chain, then an uncaught error', () => {
    const file = path.join(examples, 'errors.slight');
    assert.deepEqual(run('errors.slight'), {
        output: [
            'tag bad-user cause bad-age',
            `trace ((parse-age ${file} 3 9) (load-user ${file} 7 5) (main ${file} 12 12) (main ${file} 12 12))`,
        ],
        failure: '#<error bad-user "could not load user">',
    });
});

test('processes.slight', () => {
    assert.deepEqual(run('processes.slight'), {
        output: [
            'state (ready)',
            'run1 (blocked recv)',
            'state (blocked recv)',
            'state (ready)',
            'run2 (quota)',
            'g got hello',
            'run3 (blocked recv)',
            'checkpoint (g)',
            'sneaky failed not-granted',
        ],
        failure: null,
    });
});

test('actors/ping-pong.slight on the actors.slight system', () => {
    assert.deepEqual(run('actors/actors.slight', 'actors/ping-pong.slight'), {
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
