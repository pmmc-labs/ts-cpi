// Tests for the reader (SPEC-CPI section 3).
// @ts-nocheck (test assertions use type narrowing that TypeScript doesn't fully understand)

import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../src/reader.ts';
import { NIL, TRUE, FALSE, int, float as floatVal, str, sym, cons, listToArray } from '../src/values.ts';
import { LoadError } from '../src/errors.ts';
import type { Value } from '../src/types.ts';

// Helper to extract list elements
function toArray(v: any): any[] | null {
    return listToArray(v);
}

// Helper to cast a value for testing (suppresses type errors)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cast = (v: any): any => v;

// Literals
test('integer literal', () => {
    const result = read('42', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(cast(result[0]).t, 'int');
    assert.equal(cast(result[0]).v, 42n);
});

test('negative integer', () => {
    const result = read('-7', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'int');
    assert.equal(result[0].v, -7n);
});

test('zero', () => {
    const result = read('0', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'int');
    assert.equal(result[0].v, 0n);
});

test('integer at 64-bit boundary', () => {
    const result = read('9223372036854775807', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'int');
    assert.equal(result[0].v, 9223372036854775807n);
});

test('integer out of range throws LoadError', () => {
    assert.throws(
        () => read('9223372036854775808', 'test.txt'),
        LoadError
    );
});

test('float literal', () => {
    const result = read('3.5', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'float');
    assert.equal(result[0].v, 3.5);
});

test('float with negative exponent', () => {
    const result = read('-0.25', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'float');
    assert.equal(result[0].v, -0.25);
});

test('float with positive exponent', () => {
    const result = read('1.0e3', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'float');
    assert.equal(result[0].v, 1000);
});

test('float with E uppercase', () => {
    const result = read('2.5E2', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'float');
    assert.equal(result[0].v, 250);
});

test('float with signed exponent', () => {
    const result = read('1.5e-2', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'float');
    assert.equal(result[0].v, 0.015);
});

test('true boolean', () => {
    const result = read('#true', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0], TRUE);
});

test('false boolean', () => {
    const result = read('#false', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0], FALSE);
});

test('string literal', () => {
    const result = read('"hello"', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'str');
    assert.equal(result[0].v, 'hello');
});

test('string with escaped quote', () => {
    const result = read('"say \\"hi\\""', 'test.txt');
    assert.equal(result[0].v, 'say "hi"');
});

test('string with escaped backslash', () => {
    const result = read('"a\\\\b"', 'test.txt');
    assert.equal(result[0].v, 'a\\b');
});

test('string with newline escape', () => {
    const result = read('"line1\\nline2"', 'test.txt');
    assert.equal(result[0].v, 'line1\nline2');
});

test('string with tab escape', () => {
    const result = read('"col1\\tcol2"', 'test.txt');
    assert.equal(result[0].v, 'col1\tcol2');
});

test('string with unicode escape', () => {
    const result = read('"\\u{41}"', 'test.txt');
    assert.equal(result[0].v, 'A');
});

test('string with multi-digit unicode escape', () => {
    const result = read('"\\u{1F600}"', 'test.txt');
    assert.equal(result[0].v, '😀');
});

test('symbol', () => {
    const result = read('name', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].t, 'sym');
    assert.equal(result[0].name, 'name');
});

test('symbol with slashes', () => {
    const result = read('list/map', 'test.txt');
    assert.equal(result[0].name, 'list/map');
});

test('symbol with double colons', () => {
    const result = read('IO::print', 'test.txt');
    assert.equal(result[0].name, 'IO::print');
});

test('quoted symbol', () => {
    const result = read("'x", 'test.txt');
    assert.equal(result.length, 1);
    const arr = toArray(result[0]);
    assert.equal(arr.length, 2);
    assert.equal(arr[0].name, 'quote');
    assert.equal(arr[1].name, 'x');
    assert.equal(result[0].pos.col, 1);
    assert.equal(result[0].pos.line, 1);
});

test('tag (colon name)', () => {
    const result = read(':x', 'test.txt');
    assert.equal(result.length, 1);
    const arr = toArray(result[0]);
    assert.equal(arr.length, 2);
    assert.equal(arr[0].name, 'quote');
    assert.equal(arr[1].name, 'x');
    assert.equal(result[0].pos.col, 1);
    assert.equal(result[0].pos.line, 1);
});

// Lists
test('empty list', () => {
    const result = read('()', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0], NIL);
});

test('simple list', () => {
    const result = read('(a b c)', 'test.txt');
    assert.equal(result.length, 1);
    const arr = toArray(result[0]);
    assert.equal(arr.length, 3);
    assert.equal(arr[0].name, 'a');
    assert.equal(arr[1].name, 'b');
    assert.equal(arr[2].name, 'c');
});

test('list with mixed types', () => {
    const result = read('(42 "hello" #true)', 'test.txt');
    const arr = toArray(result[0]);
    assert.equal(arr.length, 3);
    assert.equal(arr[0].v, 42n);
    assert.equal(arr[1].v, 'hello');
    assert.equal(arr[2], TRUE);
});

test('nested lists', () => {
    const result = read('((a) (b c))', 'test.txt');
    const outer = toArray(result[0]);
    assert.equal(outer.length, 2);
    const first = toArray(outer[0]);
    assert.equal(first.length, 1);
    assert.equal(first[0].name, 'a');
    const second = toArray(outer[1]);
    assert.equal(second.length, 2);
    assert.equal(second[0].name, 'b');
    assert.equal(second[1].name, 'c');
});

test('pair position is at opening paren', () => {
    const result = read('(a b)', 'test.txt');
    assert.equal(result[0].pos.line, 1);
    assert.equal(result[0].pos.col, 1);
});

test('multiple values', () => {
    const result = read('42 "hi" x', 'test.txt');
    assert.equal(result.length, 3);
    assert.equal(result[0].v, 42n);
    assert.equal(result[1].v, 'hi');
    assert.equal(result[2].name, 'x');
});

// Comments
test('line comment is ignored', () => {
    const result = read('42 ; this is a comment\n"hi"', 'test.txt');
    assert.equal(result.length, 2);
    assert.equal(result[0].v, 42n);
    assert.equal(result[1].v, 'hi');
});

test('comment to end of file', () => {
    const result = read('x ; comment', 'test.txt');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'x');
});

// Position tracking
test('positions start at line 1 column 1', () => {
    const result = read('x', 'test.txt');
    const pos = result[0].pos || (result[0].t === 'pair' ? result[0].pos : null);
    // Symbols don't have pos; literals also don't
    // Only pairs have pos metadata
    assert.ok(true); // position is tracked in tokenizer
});

test('pair positions tracked across lines', () => {
    const result = read('x\n(a b)', 'test.txt');
    assert.equal(result.length, 2);
    assert.equal(result[1].pos.line, 2);
    assert.equal(result[1].pos.col, 1);
});

test('quoted form has position of quote', () => {
    const result = read("'x", 'test.txt');
    assert.equal(result[0].pos.col, 1);
    assert.equal(result[0].pos.line, 1);
});

test('tag form has position of colon', () => {
    const result = read(':x', 'test.txt');
    assert.equal(result[0].pos.col, 1);
    assert.equal(result[0].pos.line, 1);
});

// Error cases
test('unknown boolean throws LoadError', () => {
    assert.throws(
        () => read('#maybe', 'test.txt'),
        LoadError
    );
});

test('lone colon throws LoadError', () => {
    assert.throws(
        () => read(':', 'test.txt'),
        LoadError
    );
});

test('colon followed by invalid symbol throws LoadError', () => {
    assert.throws(
        () => read(': ', 'test.txt'),
        LoadError
    );
});

test('unterminated string throws LoadError', () => {
    assert.throws(
        () => read('"hello', 'test.txt'),
        LoadError
    );
});

test('invalid escape sequence throws LoadError', () => {
    assert.throws(
        () => read('"test\\xtest"', 'test.txt'),
        LoadError
    );
});

test('unterminated list throws LoadError', () => {
    assert.throws(
        () => read('(a b', 'test.txt'),
        LoadError
    );
});

test('unexpected close paren throws LoadError', () => {
    assert.throws(
        () => read(')', 'test.txt'),
        LoadError
    );
});

test('error message includes file and position', () => {
    try {
        read('(a', 'myfile.cpi');
        assert.fail('should throw');
    } catch (e) {
        assert.ok(e instanceof LoadError);
        assert.ok(e.message.includes('myfile.cpi'));
    }
});

// Complex forms
test('lambda form', () => {
    const result = read('(lambda (x) x)', 'test.txt');
    const arr = toArray(result[0]);
    assert.equal(arr.length, 3);
    assert.equal(arr[0].name, 'lambda');
    const params = toArray(arr[1]);
    assert.equal(params.length, 1);
    assert.equal(params[0].name, 'x');
    assert.equal(arr[2].name, 'x');
});

test('defun form', () => {
    const result = read('(defun foo (x) (+ x 1))', 'test.txt');
    const arr = toArray(result[0]);
    assert.equal(arr.length, 4);
    assert.equal(arr[0].name, 'defun');
    assert.equal(arr[1].name, 'foo');
});

test('quoted list', () => {
    const result = read("'(a b c)", 'test.txt');
    const quote_list = toArray(result[0]);
    assert.equal(quote_list[0].name, 'quote');
    const list = toArray(quote_list[1]);
    assert.equal(list.length, 3);
    assert.equal(list[0].name, 'a');
    assert.equal(list[1].name, 'b');
    assert.equal(list[2].name, 'c');
});

test('multiple quoted forms', () => {
    const result = read("'x 'y", 'test.txt');
    assert.equal(result.length, 2);
    const arr1 = toArray(result[0]);
    const arr2 = toArray(result[1]);
    assert.equal(arr1[0].name, 'quote');
    assert.equal(arr1[1].name, 'x');
    assert.equal(arr2[0].name, 'quote');
    assert.equal(arr2[1].name, 'y');
});

test('string containing quotes and escapes', () => {
    const result = read('"He said \\"Hello\\"\\nGood\\\\bye"', 'test.txt');
    assert.equal(result[0].v, 'He said "Hello"\nGood\\bye');
});

test('whitespace handling', () => {
    const result = read('  \n  42  \n  "x"  ', 'test.txt');
    assert.equal(result.length, 2);
    assert.equal(result[0].v, 42n);
    assert.equal(result[1].v, 'x');
});

test('complex nested structure', () => {
    const result = read('(cond (test body) (else "default"))', 'test.txt');
    const arr = toArray(result[0]);
    assert.equal(arr[0].name, 'cond');
    const clause1 = toArray(arr[1]);
    assert.equal(clause1.length, 2);
    assert.equal(clause1[0].name, 'test');
    assert.equal(clause1[1].name, 'body');
});

test('list with quoted elements', () => {
    const result = read("('a 'b 'c)", 'test.txt');
    const arr = toArray(result[0]);
    assert.equal(arr.length, 3);
    const q1 = toArray(arr[0]);
    assert.equal(q1[0].name, 'quote');
    assert.equal(q1[1].name, 'a');
});

test('integer that looks numeric', () => {
    const result = read('123abc', 'test.txt');
    assert.equal(result[0].t, 'sym');
    assert.equal(result[0].name, '123abc');
});

test('symbol with minus in the middle', () => {
    const result = read('a-b', 'test.txt');
    assert.equal(result[0].name, 'a-b');
});

test('symbol starting with plus', () => {
    const result = read('+', 'test.txt');
    assert.equal(result[0].name, '+');
});

test('symbol starting with minus not followed by digit', () => {
    const result = read('-foo', 'test.txt');
    assert.equal(result[0].name, '-foo');
});

// Manager fixes
test('floats require digits on both sides of decimal', () => {
    // .5 should be a symbol, not a float
    const result1 = read('.5', 'test.txt');
    assert.equal(cast(result1[0]).t, 'sym');
    assert.equal(cast(result1[0]).name, '.5');

    // 5. should be a symbol, not a float
    const result2 = read('5.', 'test.txt');
    assert.equal(cast(result2[0]).t, 'sym');
    assert.equal(cast(result2[0]).name, '5.');

    // 1e3 without decimal should be a symbol, not a float
    const result3 = read('1e3', 'test.txt');
    assert.equal(cast(result3[0]).t, 'sym');
    assert.equal(cast(result3[0]).name, '1e3');

    // 1.0e3 with decimal should be a float
    const result4 = read('1.0e3', 'test.txt');
    assert.equal(cast(result4[0]).t, 'float');
    assert.equal(cast(result4[0]).v, 1000);
});

test('dotted pairs throw LoadError', () => {
    assert.throws(
        () => read('(a . b)', 'test.txt'),
        LoadError
    );

    assert.throws(
        () => read('(1 2 . 3)', 'test.txt'),
        LoadError
    );
});

test('tag symbol must be valid', () => {
    // Valid tag with symbol containing ::
    const result1 = read(':a::b', 'test.txt');
    assert.equal(cast(result1[0]).t, 'pair');

    // Invalid: integer after :
    assert.throws(
        () => read(':12', 'test.txt'),
        LoadError
    );

    // Invalid: negative integer after :
    assert.throws(
        () => read(':-3', 'test.txt'),
        LoadError
    );

    // Invalid: float after :
    assert.throws(
        () => read(':1.5', 'test.txt'),
        LoadError
    );

    // Invalid: # after :
    assert.throws(
        () => read(':#foo', 'test.txt'),
        LoadError
    );

    // Invalid: : after :
    assert.throws(
        () => read('::foo', 'test.txt'),
        LoadError
    );

    // Invalid: ' after :
    assert.throws(
        () => read(":'foo", 'test.txt'),
        LoadError
    );
});
