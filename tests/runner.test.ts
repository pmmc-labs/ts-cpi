// The Life runner (examples/runner): every loaded engine must produce the
// reference engine's boards, and the runner itself must drive a session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { loadFiles } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { HeadlessTui } from '../src/tui/headless.ts';
import { read } from '../src/reader.ts';
import { print } from '../src/printer.ts';

const engineFiles = readdirSync('examples/runner/engines')
    .filter((f) => f.endsWith('.slight'))
    .map((f) => `examples/runner/engines/${f}`);

const files = (program: string) => [
    'examples/life/lib/lists.slight', 'examples/runner/lib/board.slight', ...engineFiles,
    'examples/runner/engines.slight', `examples/runner/${program}.slight`,
];

test('every loaded engine agrees with the reference, case by case', async () => {
    const output: string[] = [];
    const result = await new Runtime({ out: (line) => output.push(line), clock: 'virtual' }).boot(loadFiles(files('check')));
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    const loaded = output.filter((line) => !line.endsWith('| missing'));
    assert.ok(loaded.length >= 6, 'at least the reference and decision tree engines ran their three cases');
    for (const line of loaded) assert.match(line, /\| agree \|/, line);
});

test('the runner: menu, a run of 30 generations, and back to the menu', async () => {
    const events = ['(key up ())', '(key left ())', '(key left ())', '(key return ())',
        ...Array.from({ length: 30 }, () => '(resize 120 40)'), '(key "q" ())', '(key "q" ())'];
    const tui = new HeadlessTui({ columns: 120, rows: 40, input: events.map((e) => read(e, 'event')[0]!) });
    const result = await new Runtime({ out: () => {}, clock: 'virtual', tui: () => tui }).boot(loadFiles(files('runner')));
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    const runFrames = tui.frames.filter((f) => f.includes('R-pentomino · Conway'));
    assert.equal(runFrames.length, 31);
    assert.match(runFrames.at(-1)!, /30 {2}generation/);
    assert.match(runFrames.at(-1)!, /27 {2}live cells/);
    assert.match(runFrames.at(-1)!, /\d+ {2}cells born this generation/);
    assert.match(tui.frames.at(-1)!, /Reference stopped at generation 30/);
});
