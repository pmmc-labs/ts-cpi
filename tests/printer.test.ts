import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { display, print } from '../src/printer.ts';
import { sym, NIL, TRUE, FALSE, int, float, str, cons, list, newAddr, newPid } from '../src/values.ts';
import { makeError } from '../src/errors.ts';

describe('printer', () => {
    // Booleans
    it('prints #true', () => {
        assert.equal(print(TRUE), '#true');
        assert.equal(display(TRUE), '#true');
    });

    it('prints #false', () => {
        assert.equal(print(FALSE), '#false');
        assert.equal(display(FALSE), '#false');
    });

    // Nil
    it('prints ()', () => {
        assert.equal(print(NIL), '()');
        assert.equal(display(NIL), '()');
    });

    // Integers
    it('prints integers', () => {
        assert.equal(print(int(0)), '0');
        assert.equal(print(int(42)), '42');
        assert.equal(print(int(-7)), '-7');
        assert.equal(print(int(9007199254740991n)), '9007199254740991');
    });

    // Floats
    it('prints regular floats with decimal point', () => {
        assert.equal(print(float(1.0)), '1.0');
        assert.equal(print(float(0.5)), '0.5');
        assert.equal(print(float(-3.14)), '-3.14');
    });

    it('prints floats with exponent notation', () => {
        assert.equal(print(float(1e21)), '1e+21');
        assert.equal(print(float(1e-10)), '1e-10');
    });

    it('prints special float values', () => {
        assert.equal(print(float(NaN)), '+nan.0');
        assert.equal(print(float(Infinity)), '+inf.0');
        assert.equal(print(float(-Infinity)), '-inf.0');
    });

    // Symbols
    it('prints symbols', () => {
        assert.equal(print(sym('name')), 'name');
        assert.equal(print(sym('list')), 'list');
        assert.equal(print(sym('x')), 'x');
    });

    // Strings with print (quoted with escapes)
    it('prints strings with print (quoted)', () => {
        assert.equal(print(str('hello')), '"hello"');
        assert.equal(print(str('')), '""');
    });

    it('prints strings with escapes in print mode', () => {
        assert.equal(print(str('hello"world')), '"hello\\"world"');
        assert.equal(print(str('back\\slash')), '"back\\\\slash"');
        assert.equal(print(str('new\nline')), '"new\\nline"');
        assert.equal(print(str('tab\there')), '"tab\\there"');
    });

    // Strings with display (raw)
    it('displays strings without quotes', () => {
        assert.equal(display(str('hello')), 'hello');
        assert.equal(display(str('')), '');
    });

    it('displays strings with special chars in raw form', () => {
        assert.equal(display(str('hello"world')), 'hello"world');
        assert.equal(display(str('back\\slash')), 'back\\slash');
        assert.equal(display(str('new\nline')), 'new\nline');
    });

    // Proper lists
    it('prints proper lists', () => {
        assert.equal(print(NIL), '()');
        assert.equal(print(list(int(1))), '(1)');
        assert.equal(print(list(int(1), int(2), int(3))), '(1 2 3)');
    });

    it('prints lists with various value types', () => {
        assert.equal(print(list(sym('a'), sym('b'))), '(a b)');
        assert.equal(print(list(TRUE, FALSE)), '(#true #false)');
        assert.equal(print(list(str('x'))), '("x")');
    });

    // Improper lists (dotted pairs)
    it('prints improper lists with dotted tail', () => {
        assert.equal(print(cons(int(1), int(2))), '(1 . 2)');
        assert.equal(print(cons(int(1), cons(int(2), int(3)))), '(1 2 . 3)');
    });

    it('prints improper lists with symbol tail', () => {
        assert.equal(print(cons(sym('a'), sym('b'))), '(a . b)');
    });

    // Quote form
    it('prints quote form without abbreviation', () => {
        const quoted = cons(sym('quote'), cons(sym('x'), NIL));
        assert.equal(print(quoted), '(quote x)');
    });

    it('prints nested quote without abbreviation', () => {
        const inner = cons(sym('quote'), cons(int(42), NIL));
        const outer = cons(sym('quote'), cons(inner, NIL));
        assert.equal(print(outer), '(quote (quote 42))');
    });

    // Procedures
    it('prints named procedures', () => {
        const proc = {
            t: 'closure' as const,
            name: sym('foo'),
            params: [],
            body: [],
            scope: null,
            group: null,
        };
        assert.equal(print(proc), '#<procedure foo>');
    });

    it('prints anonymous procedures', () => {
        const proc = {
            t: 'closure' as const,
            name: null,
            params: [],
            body: [],
            scope: null,
            group: null,
        };
        assert.equal(print(proc), '#<procedure>');
    });

    // Errors
    it('prints errors with tag and message', () => {
        const err = makeError('type-error', 'expected number');
        assert.equal(print(err), '#<error type-error "expected number">');
    });

    it('prints errors with different tags', () => {
        const err = makeError('unbound', 'undefined variable');
        assert.equal(print(err), '#<error unbound "undefined variable">');
    });

    // Addresses
    it('prints addresses', () => {
        const addr = newAddr();
        assert.equal(print(addr), '#<address a1>');
    });

    // PIDs
    it('prints pids', () => {
        const p = newPid(42);
        assert.equal(print(p), '#<pid 42>');
    });

    // Env refs
    it('prints env refs', () => {
        const envRef = {
            t: 'env' as const,
            env: { slots: new Map() },
        };
        assert.equal(print(envRef), '#<env>');
    });

    // Complex nested structures
    it('prints nested lists', () => {
        const nested = list(int(1), list(int(2), int(3)), int(4));
        assert.equal(print(nested), '(1 (2 3) 4)');
    });

    it('prints lists with strings using print', () => {
        const withStrings = list(str('hello'), str('world'));
        assert.equal(print(withStrings), '("hello" "world")');
    });

    it('displays lists with strings using display', () => {
        const withStrings = list(str('hello'), str('world'));
        assert.equal(display(withStrings), '(hello world)');
    });

    // Edge cases
    it('prints zero float', () => {
        assert.equal(print(float(0.0)), '0.0');
        assert.equal(print(float(-0.0)), '-0.0');
    });

    it('prints very large and very small floats', () => {
        const result = print(float(1e100));
        assert(result.includes('e'));
        const result2 = print(float(1e-100));
        assert(result2.includes('e'));
    });

    it('handles list with improper tail correctly', () => {
        // (1 2 . 3)
        const improper = cons(int(1), cons(int(2), int(3)));
        assert.equal(print(improper), '(1 2 . 3)');
    });

    it('handles deeply nested structures', () => {
        const deep = list(
            list(list(int(1))),
            list(int(2), list(int(3), int(4)))
        );
        assert.equal(print(deep), '(((1)) (2 (3 4)))');
    });

    it('prints empty list in both modes', () => {
        assert.equal(print(list()), '()');
        assert.equal(display(list()), '()');
    });
});
