import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadSource, loadFiles } from '../src/loader.ts';
import { emptyEnv } from '../src/env.ts';
import { LoadError } from '../src/errors.ts';
import { lookup } from '../src/env.ts';
import { listToArray } from '../src/values.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempFile(content: string): string {
    const path = join(tmpdir(), `test-${Math.random()}.slight`);
    writeFileSync(path, content);
    return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('loader: defun creates a closure with name, params, body, scope=null, group=null', () => {
    const source = '(defun add (a b) (+ a b))';
    const env = loadSource(source, 'test');

    const addValue = lookup(env, 'add');
    assert(addValue !== null, 'add should be defined');
    assert.equal(addValue.t, 'closure');
    const closure = addValue as any;
    assert.equal(closure.name.name, 'add');
    assert.equal(closure.params.length, 2);
    assert.equal(closure.scope, null);
    assert.equal(closure.group, null);
});

test('loader: const evaluates expression and adds value to env', () => {
    const source = '(const x 42)';
    const env = loadSource(source, 'test');

    const xValue = lookup(env, 'x');
    assert(xValue !== null, 'x should be defined');
    assert.equal(xValue.t, 'int');
    assert.equal((xValue as any).v, 42n);
});

test('loader: const can reference earlier definition', () => {
    const source = `
        (defun double (x) (* x 2))
        (const y (double 5))
    `;
    const env = loadSource(source, 'test');

    const yValue = lookup(env, 'y');
    assert(yValue !== null, 'y should be defined');
    assert.equal(yValue.t, 'int');
    assert.equal((yValue as any).v, 10n);
});

test('loader: duplicate defun is a LoadError', () => {
    const source = `
        (defun f (x) x)
        (defun f (y) (+ y 1))
    `;
    assert.throws(() => loadSource(source, 'test'), LoadError);
});

test('loader: const that throws becomes a LoadError', () => {
    const source = '(const z (/ 1 0))';
    assert.throws(() => loadSource(source, 'test'), LoadError);
});

test('loader: const that makes a host request is a LoadError', () => {
    const source = '(const w (process::run #false 100))';
    assert.throws(() => loadSource(source, 'test'), LoadError);
});

test('loader: multiple defuns in sequence work', () => {
    const source = `
        (defun f1 (x) (+ x 1))
        (defun f2 (x) (+ x 2))
        (defun f3 (x) (+ x 3))
    `;
    const env = loadSource(source, 'test');

    assert(lookup(env, 'f1') !== null);
    assert(lookup(env, 'f2') !== null);
    assert(lookup(env, 'f3') !== null);
});

test('loader: loadFiles reads multiple files in order', () => {
    const file1 = tempFile('(defun f (x) (+ x 1))');
    const file2 = tempFile('(const y (f 5))');

    const env = loadFiles([file1, file2]);

    const yValue = lookup(env, 'y');
    assert(yValue !== null);
    assert.equal((yValue as any).v, 6n);
});

test('loader: load error includes source position in message', () => {
    // This will have the defun at a specific line/col position
    const source = `
        (defun f (x) x)
        (defun f (y) y)
    `;
    try {
        loadSource(source, 'test');
        assert.fail('should have thrown LoadError');
    } catch (e) {
        assert(e instanceof LoadError);
        // The message should include file:line:col prefix
        assert(e.message.includes('test:'), `message should include file position: ${e.message}`);
    }
});
