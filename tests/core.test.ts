import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE, eq, traceEntries } from '../src/core.ts';
import {
    NIL, TRUE, FALSE, bool, sym, int, float, str, cons, list, listToArray,
    INT_MIN, INT_MAX, fitsInt
} from '../src/values.ts';
import { makeError, ok } from '../src/errors.ts';
import { CORE_ARITY } from '../src/names.ts';

function callOp(name: string, args: any[]) {
    const op = CORE.get(name);
    assert(op, `operation ${name} not found`);
    return op.fn(args);
}

// Helper to extract value from ok result
function unwrap(result: any) {
    assert(result.ok === true, `Expected ok result but got error`);
    return result.v;
}

// Helper to extract error from fail result
function expectFail(result: any, expectedTag?: string) {
    assert(result.ok === false, 'Expected fail result but got ok');
    if (expectedTag) {
        assert.equal(result.e.tag.name, expectedTag);
    }
    return result.e;
}

test('arithmetic: addition', () => {
    // Integer addition
    assert.equal(unwrap(callOp('+', [int(2), int(3)])).v, 5n);
    assert.equal(unwrap(callOp('+', [int(-5), int(10)])).v, 5n);

    // Float addition
    const floatRes = unwrap(callOp('+', [float(2.5), float(3.5)]));
    assert.equal(floatRes.v, 6.0);

    // Type error: mixed types
    expectFail(callOp('+', [int(1), float(1.5)]), 'type-error');
});

test('arithmetic: overflow', () => {
    // Integer overflow
    expectFail(callOp('+', [int(INT_MAX), int(1)]), 'overflow');
    expectFail(callOp('+', [int(INT_MIN), int(-1)]), 'overflow');
    expectFail(callOp('*', [int(INT_MAX), int(2)]), 'overflow');
    expectFail(callOp('-', [int(INT_MIN), int(1)]), 'overflow');
});

test('arithmetic: subtraction', () => {
    assert.equal(unwrap(callOp('-', [int(5), int(3)])).v, 2n);
    assert.equal(unwrap(callOp('-', [int(3), int(5)])).v, -2n);

    const floatRes = unwrap(callOp('-', [float(5.5), float(2.5)]));
    assert.equal(floatRes.v, 3.0);
});

test('arithmetic: multiplication', () => {
    assert.equal(unwrap(callOp('*', [int(3), int(4)])).v, 12n);
    assert.equal(unwrap(callOp('*', [int(-3), int(4)])).v, -12n);
    assert.equal(unwrap(callOp('*', [int(0), int(999)])).v, 0n);

    const floatRes = unwrap(callOp('*', [float(2.5), float(2.0)]));
    assert.equal(floatRes.v, 5.0);
});

test('arithmetic: division', () => {
    // Integer division truncates toward zero
    assert.equal(unwrap(callOp('/', [int(7), int(2)])).v, 3n);
    assert.equal(unwrap(callOp('/', [int(-7), int(2)])).v, -3n);
    assert.equal(unwrap(callOp('/', [int(7), int(-2)])).v, -3n);
    assert.equal(unwrap(callOp('/', [int(-7), int(-2)])).v, 3n);

    // Divide by zero
    expectFail(callOp('/', [int(5), int(0)]), 'divide-by-zero');

    // INT_MIN / -1 overflows (would be 2^63)
    expectFail(callOp('/', [int(INT_MIN), int(-1)]), 'overflow');

    // Float division
    const floatRes = unwrap(callOp('/', [float(7.0), float(2.0)]));
    assert.equal(floatRes.v, 3.5);
});

test('arithmetic: modulo', () => {
    // Remainder takes sign of dividend
    assert.equal(unwrap(callOp('%', [int(7), int(3)])).v, 1n);
    assert.equal(unwrap(callOp('%', [int(-7), int(3)])).v, -1n);
    assert.equal(unwrap(callOp('%', [int(7), int(-3)])).v, 1n);
    assert.equal(unwrap(callOp('%', [int(-7), int(-3)])).v, -1n);

    // Divide by zero
    expectFail(callOp('%', [int(5), int(0)]), 'divide-by-zero');

    // Type error: floats not allowed
    expectFail(callOp('%', [float(7.0), float(3.0)]), 'type-error');
});

test('comparison: numeric equality', () => {
    // Integer comparison
    assert.equal(unwrap(callOp('=', [int(5), int(5)])).v, true);
    assert.equal(unwrap(callOp('=', [int(5), int(3)])).v, false);

    // Float comparison
    assert.equal(unwrap(callOp('=', [float(5.5), float(5.5)])).v, true);
    assert.equal(unwrap(callOp('=', [float(5.5), float(3.3)])).v, false);

    // Type error: mixed types
    expectFail(callOp('=', [int(5), float(5.0)]), 'type-error');
});

test('comparison: less than', () => {
    assert.equal(unwrap(callOp('<', [int(3), int(5)])).v, true);
    assert.equal(unwrap(callOp('<', [int(5), int(3)])).v, false);
    assert.equal(unwrap(callOp('<', [int(5), int(5)])).v, false);

    assert.equal(unwrap(callOp('<', [float(3.0), float(5.0)])).v, true);
});

test('comparison: less than or equal', () => {
    assert.equal(unwrap(callOp('<=', [int(3), int(5)])).v, true);
    assert.equal(unwrap(callOp('<=', [int(5), int(5)])).v, true);
    assert.equal(unwrap(callOp('<=', [int(5), int(3)])).v, false);
});

test('comparison: greater than', () => {
    assert.equal(unwrap(callOp('>', [int(5), int(3)])).v, true);
    assert.equal(unwrap(callOp('>', [int(3), int(5)])).v, false);
    assert.equal(unwrap(callOp('>', [int(5), int(5)])).v, false);
});

test('comparison: greater than or equal', () => {
    assert.equal(unwrap(callOp('>=', [int(5), int(3)])).v, true);
    assert.equal(unwrap(callOp('>=', [int(5), int(5)])).v, true);
    assert.equal(unwrap(callOp('>=', [int(3), int(5)])).v, false);
});

test('eq?: value types by value', () => {
    // Booleans by value
    assert.equal(unwrap(callOp('eq?', [TRUE, TRUE])).v, true);
    assert.equal(unwrap(callOp('eq?', [FALSE, FALSE])).v, true);
    assert.equal(unwrap(callOp('eq?', [TRUE, FALSE])).v, false);

    // Nil
    assert.equal(unwrap(callOp('eq?', [NIL, NIL])).v, true);

    // Integers
    assert.equal(unwrap(callOp('eq?', [int(5), int(5)])).v, true);
    assert.equal(unwrap(callOp('eq?', [int(5), int(3)])).v, false);

    // Floats
    assert.equal(unwrap(callOp('eq?', [float(5.5), float(5.5)])).v, true);
    assert.equal(unwrap(callOp('eq?', [float(5.5), float(3.3)])).v, false);

    // Symbols (interned)
    assert.equal(unwrap(callOp('eq?', [sym('x'), sym('x')])).v, true);
    assert.equal(unwrap(callOp('eq?', [sym('x'), sym('y')])).v, false);

    // Strings by content
    assert.equal(unwrap(callOp('eq?', [str('hello'), str('hello')])).v, true);
    assert.equal(unwrap(callOp('eq?', [str('hello'), str('world')])).v, false);

    // Different types
    assert.equal(unwrap(callOp('eq?', [int(5), float(5.0)])).v, false);
    assert.equal(unwrap(callOp('eq?', [NIL, FALSE])).v, false);
});

test('not', () => {
    assert.equal(unwrap(callOp('not', [FALSE])).v, true);
    assert.equal(unwrap(callOp('not', [TRUE])).v, false);

    // Only #false is false, everything else is true
    assert.equal(unwrap(callOp('not', [NIL])).v, false);
    assert.equal(unwrap(callOp('not', [int(0)])).v, false);
    assert.equal(unwrap(callOp('not', [str('')])).v, false);
});

test('type predicates', () => {
    // nil?
    assert.equal(unwrap(callOp('nil?', [NIL])).v, true);
    assert.equal(unwrap(callOp('nil?', [int(0)])).v, false);

    // pair?
    assert.equal(unwrap(callOp('pair?', [cons(int(1), NIL)])).v, true);
    assert.equal(unwrap(callOp('pair?', [NIL])).v, false);

    // boolean?
    assert.equal(unwrap(callOp('boolean?', [TRUE])).v, true);
    assert.equal(unwrap(callOp('boolean?', [FALSE])).v, true);
    assert.equal(unwrap(callOp('boolean?', [int(1)])).v, false);

    // integer?
    assert.equal(unwrap(callOp('integer?', [int(5)])).v, true);
    assert.equal(unwrap(callOp('integer?', [float(5.0)])).v, false);

    // float?
    assert.equal(unwrap(callOp('float?', [float(5.5)])).v, true);
    assert.equal(unwrap(callOp('float?', [int(5)])).v, false);

    // string?
    assert.equal(unwrap(callOp('string?', [str('hello')])).v, true);
    assert.equal(unwrap(callOp('string?', [int(5)])).v, false);

    // symbol?
    assert.equal(unwrap(callOp('symbol?', [sym('x')])).v, true);
    assert.equal(unwrap(callOp('symbol?', [str('x')])).v, false);

    // procedure? (closure)
    const closure = { t: 'closure' as const, name: null, params: [], body: [], scope: null, group: null };
    assert.equal(unwrap(callOp('procedure?', [closure])).v, true);
    assert.equal(unwrap(callOp('procedure?', [int(5)])).v, false);

    // error?
    const err = makeError('test', 'test message');
    assert.equal(unwrap(callOp('error?', [err])).v, true);
    assert.equal(unwrap(callOp('error?', [int(5)])).v, false);
});

test('pairs: cons, car, cdr', () => {
    const pair = unwrap(callOp('cons', [int(1), int(2)]));
    assert.equal(pair.t, 'pair');
    assert.equal((pair as any).car.v, 1n);
    assert.equal((pair as any).cdr.v, 2n);

    // car
    assert.equal(unwrap(callOp('car', [pair])).v, 1n);

    // cdr
    assert.equal(unwrap(callOp('cdr', [pair])).v, 2n);

    // Type error: car/cdr on non-pair
    expectFail(callOp('car', [int(5)]), 'type-error');
    expectFail(callOp('cdr', [NIL]), 'type-error');
});

test('pairs: apply', () => {
    // apply is handled by the machine, not by this function
    // The function returns type-error as a placeholder
    const result = callOp('apply', [int(5), NIL]);
    assert.equal(result.ok, false);
    assert.equal(result.e.tag.name, 'type-error');
});

test('strings: string-length', () => {
    assert.equal(unwrap(callOp('string-length', [str('hello')])).v, 5n);
    assert.equal(unwrap(callOp('string-length', [str('')])).v, 0n);

    // Unicode scalar values (emoji)
    assert.equal(unwrap(callOp('string-length', [str('🎉')])).v, 1n);

    // Type error
    expectFail(callOp('string-length', [int(5)]), 'type-error');
});

test('strings: string-ref', () => {
    const s = str('hello');
    assert.equal(unwrap(callOp('string-ref', [s, int(0)])).v, 104n); // 'h'
    assert.equal(unwrap(callOp('string-ref', [s, int(1)])).v, 101n); // 'e'
    assert.equal(unwrap(callOp('string-ref', [s, int(4)])).v, 111n); // 'o'

    // Range error
    expectFail(callOp('string-ref', [s, int(-1)]), 'range-error');
    expectFail(callOp('string-ref', [s, int(5)]), 'range-error');

    // Type error
    expectFail(callOp('string-ref', [int(5), int(0)]), 'type-error');
    expectFail(callOp('string-ref', [s, float(0.0)]), 'type-error');
});

test('strings: string-append', () => {
    const result = unwrap(callOp('string-append', [str('hello'), str(' world')]));
    assert.equal(result.v, 'hello world');

    // Empty strings
    assert.equal(unwrap(callOp('string-append', [str(''), str('')])).v, '');

    // Type error
    expectFail(callOp('string-append', [int(5), str('world')]), 'type-error');
    expectFail(callOp('string-append', [str('hello'), int(5)]), 'type-error');
});

test('strings: symbol->string', () => {
    const result = unwrap(callOp('symbol->string', [sym('foo')]));
    assert.equal(result.v, 'foo');

    // Type error
    expectFail(callOp('symbol->string', [str('foo')]), 'type-error');
});

test('strings: string->symbol', () => {
    const result = unwrap(callOp('string->symbol', [str('foo')]));
    assert.equal(result.t, 'sym');
    assert.equal((result as any).name, 'foo');

    // Symbols are interned
    const result2 = unwrap(callOp('string->symbol', [str('foo')]));
    assert(result === result2);

    // Type error
    expectFail(callOp('string->symbol', [int(5)]), 'type-error');
});

test('conversions: integer->float', () => {
    const result = unwrap(callOp('integer->float', [int(42)]));
    assert.equal(result.v, 42.0);

    assert.equal(unwrap(callOp('integer->float', [int(0)])).v, 0.0);
    assert.equal(unwrap(callOp('integer->float', [int(-100)])).v, -100.0);

    // Type error
    expectFail(callOp('integer->float', [float(5.0)]), 'type-error');
});

test('conversions: float->integer', () => {
    // Truncate toward zero
    assert.equal(unwrap(callOp('float->integer', [float(42.7)])).v, 42n);
    assert.equal(unwrap(callOp('float->integer', [float(-42.7)])).v, -42n);
    assert.equal(unwrap(callOp('float->integer', [float(0.5)])).v, 0n);

    // NaN and infinity are type-error (not finite)
    expectFail(callOp('float->integer', [float(Infinity)]), 'type-error');
    expectFail(callOp('float->integer', [float(-Infinity)]), 'type-error');
    expectFail(callOp('float->integer', [float(NaN)]), 'type-error');

    // Overflow: finite value that doesn't fit
    // Create a float that's too large
    const bigFloat = float(2 ** 64);
    expectFail(callOp('float->integer', [bigFloat]), 'overflow');

    // Type error
    expectFail(callOp('float->integer', [int(5)]), 'type-error');
});

test('errors: make-error', () => {
    const err = unwrap(callOp('make-error', [sym('my-error'), str('message'), int(42)]));
    assert.equal(err.t, 'error');
    assert.equal(err.tag.name, 'my-error');
    assert.equal(err.message, 'message');
    assert.equal(err.payload.v, 42n);
    assert.equal(err.cause, null);
    assert.equal(err.box.ctx, null); // Not yet thrown

    // Type error: invalid tag
    expectFail(callOp('make-error', [int(5), str('msg'), NIL]), 'type-error');

    // Type error: invalid message
    expectFail(callOp('make-error', [sym('tag'), int(5), NIL]), 'type-error');
});

test('errors: wrap-error', () => {
    const cause = makeError('cause-tag', 'cause message');
    const wrapped = unwrap(callOp('wrap-error', [cause, sym('wrapper'), str('wrapper message'), int(100)]));

    assert.equal(wrapped.t, 'error');
    assert.equal(wrapped.tag.name, 'wrapper');
    assert.equal(wrapped.message, 'wrapper message');
    assert.equal(wrapped.payload.v, 100n);
    assert.equal(wrapped.cause, cause);

    // Type error: invalid cause
    expectFail(callOp('wrap-error', [int(5), sym('tag'), str('msg'), NIL]), 'type-error');

    // Type error: invalid tag
    expectFail(callOp('wrap-error', [cause, int(5), str('msg'), NIL]), 'type-error');

    // Type error: invalid message
    expectFail(callOp('wrap-error', [cause, sym('tag'), int(5), NIL]), 'type-error');
});

test('errors: throw', () => {
    const err = makeError('test', 'message');

    // Fresh error should be throwable
    const result = callOp('throw', [err]);
    assert.equal(result.ok, false);
    assert.equal(result.e, err);

    // throw doesn't check already-thrown; machine handles that rule
    // Manually mark error as thrown to verify throw still accepts it
    (err as any).box.ctx = { site: { fn: null, pos: null }, scope: null, K: null, R: { slots: new Map() } };
    const result2 = callOp('throw', [err]);
    assert.equal(result2.ok, false);
    assert.equal(result2.e, err);

    // Type error: non-error
    expectFail(callOp('throw', [int(5)]), 'type-error');
});

test('errors: error accessors', () => {
    const err = makeError('my-tag', 'my message', int(999));

    // error-tag
    assert.equal(unwrap(callOp('error-tag', [err])).name, 'my-tag');

    // error-message
    assert.equal(unwrap(callOp('error-message', [err])).v, 'my message');

    // error-payload
    assert.equal(unwrap(callOp('error-payload', [err])).v, 999n);

    // error-cause (null -> FALSE)
    assert.equal(unwrap(callOp('error-cause', [err])), FALSE);

    // With cause
    const cause = makeError('cause-tag', 'cause message');
    const wrapped = makeError('wrapper', 'wrapper message', NIL, cause);
    assert.equal(unwrap(callOp('error-cause', [wrapped])), cause);
});

test('errors: stack-trace-for on non-thrown error', () => {
    const err = makeError('test', 'message');
    const trace = unwrap(callOp('stack-trace-for', [err]));

    // Non-thrown error has no trace
    assert.equal(trace.t, 'nil');
});

test('errors: traceEntries uses site.fn for all frames', () => {
    // Create an error with context that has multiple frames
    const procName = sym('my-procedure');
    const site1 = { fn: procName, pos: { file: 'test.slight', line: 10, col: 5 } };
    const site2 = { fn: sym('other-proc'), pos: { file: 'test.slight', line: 20, col: 10 } };

    // Create frames with explicit sites
    const letFrame: any = { k: 'let', name: sym('x'), rest: [], scope: null, site: site2 };
    const seqFrame: any = { k: 'seq', rest: [], scope: null, site: site1 };

    // Build continuation (K is a linked list, top first)
    const K = { top: seqFrame, next: { top: letFrame, next: null } };

    const err = makeError('test-trace', 'test message');
    (err as any).box.ctx = {
        site: site1,
        scope: null,
        K: K,
        R: { slots: new Map() }
    };

    // Get the trace
    const trace = traceEntries(err);
    assert.notEqual(trace.t, 'nil', 'trace should not be empty');

    // Verify trace entries
    const traceArray = listToArray(trace);
    assert(traceArray !== null);
    assert(traceArray.length >= 3, 'should have at least 3 entries (throwing + 2 frames)');

    const entry0 = listToArray(traceArray[0]!);
    assert(entry0 !== null);
    assert.equal(entry0[0], procName, 'first entry (throwing site) should use site.fn');
    assert.equal((entry0[1] as any).v, 'test.slight');

    const entry1 = listToArray(traceArray[1]!);
    assert(entry1 !== null);
    // seqFrame has site1 (my-procedure), so entry1 should be my-procedure
    assert.equal(entry1[0], procName, 'second entry (seqFrame) should use its site.fn');

    const entry2 = listToArray(traceArray[2]!);
    assert(entry2 !== null);
    // letFrame has site2 (other-proc)
    assert.equal(entry2[0], sym('other-proc'), 'third entry (letFrame) should use its site.fn');
});

test('all core operations are in CORE map', () => {
    const opNames = [
        '+', '-', '*', '/', '%',
        '=', '<', '<=', '>', '>=', 'eq?', 'not',
        'nil?', 'pair?', 'boolean?', 'integer?', 'float?', 'string?',
        'symbol?', 'procedure?', 'error?', 'address?', 'pid?', 'env?',
        'cons', 'car', 'cdr', 'apply',
        'string-length', 'string-ref', 'string-append', 'symbol->string', 'string->symbol',
        'integer->float', 'float->integer',
        'make-error', 'wrap-error', 'throw',
        'error-tag', 'error-message', 'error-payload', 'error-cause', 'stack-trace-for'
    ];

    for (const name of opNames) {
        assert(CORE.has(name), `core operation ${name} not found in CORE map`);
    }

    // Check arity matches CORE_ARITY
    assert.equal(CORE.size, CORE_ARITY.size);

    for (const [name, expectedArity] of CORE_ARITY) {
        const op = CORE.get(name);
        assert(op, `operation ${name} not in CORE`);
        assert.equal(op.arity, expectedArity, `operation ${name} has wrong arity`);
    }
});
