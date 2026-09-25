// Every Game of Life version in examples/life/ must print the same frames as
// 01-reference.slight. A frame is a `generation N` line and the board rows
// after it; anything else a version prints is its own commentary.
//
// A version can load extra files with header lines like
//     ; load: examples/actors/actors.slight
// (paths relative to the repository root). The files in examples/life/lib/
// are always loaded first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadFiles } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifeDir = path.join(root, 'examples', 'life');
const lib = ['lists.slight', 'life.slight'].map((f) => path.join(lifeDir, 'lib', f));
const height = 8;

export function filesFor(version: string): string[] {
    const source = readFileSync(path.join(lifeDir, version), 'utf8');
    const extra = [...source.matchAll(/^; load: (\S+)$/gm)].map((m) => path.join(root, m[1]!));
    return [...lib, ...extra, path.join(lifeDir, version)];
}

function run(version: string): string[] {
    const output: string[] = [];
    const result = new Runtime({ out: (line) => output.push(line) }).boot(loadFiles(filesFor(version)));
    assert.equal(result.ok, true, result.ok ? '' : `${version} failed: ${print(result.e)}`);
    return output;
}

function frames(output: string[]): string[][] {
    const out: string[][] = [];
    output.forEach((line, i) => {
        if (/^generation \d+$/.test(line)) out.push(output.slice(i, i + 1 + height));
    });
    return out;
}

const versions = readdirSync(lifeDir).filter((f) => /^\d\d-.*\.slight$/.test(f)).sort();
const reference = frames(run('01-reference.slight'));

test('the reference prints 9 frames', () => {
    assert.equal(reference.length, 9);
});

for (const version of versions.filter((v) => v !== '01-reference.slight')) {
    test(version, () => {
        assert.deepEqual(frames(run(version)), reference);
    });
}
