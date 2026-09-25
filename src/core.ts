// Core operations (SPEC-CPI section 5). Owned by Task C.

import type { Value, ErrorValue, Result } from './types.ts';
import type { CoreOp } from './types.ts';
import {
  NIL, TRUE, FALSE, bool, sym, int, float, str, cons, list, listToArray,
  INT_MIN, INT_MAX, fitsInt, isFalse
} from './values.ts';
import { ok, fail, makeError } from './errors.ts';
import { CORE_ARITY } from './names.ts';

// Helper: check if two values are equal according to eq? rules
export function eq(a: Value, b: Value): boolean {
  // Booleans, nil, integers, floats and symbols compare by value
  if (a.t === 'bool' && b.t === 'bool') return a.v === b.v;
  if (a.t === 'nil' && b.t === 'nil') return true;
  if (a.t === 'int' && b.t === 'int') return a.v === b.v;
  if (a.t === 'float' && b.t === 'float') return a.v === b.v;
  if (a.t === 'sym' && b.t === 'sym') return a === b; // interned
  // Strings compare by content
  if (a.t === 'str' && b.t === 'str') return a.v === b.v;
  // Pairs, procedures, errors, addresses, PIDs and env refs compare by identity
  // For pairs, this means reference equality since they're immutable
  // All others use reference equality
  return a === b;
}

// Helper: check if value is a number (for arithmetic/comparison)
function isNumber(v: Value): boolean {
  return v.t === 'int' || v.t === 'float';
}

// Helper: check if both are integers
function areBothInts(a: Value, b: Value): boolean {
  return a.t === 'int' && b.t === 'int';
}

// Helper: check if both are floats
function areBothFloats(a: Value, b: Value): boolean {
  return a.t === 'float' && b.t === 'float';
}

// Helper: check if both are same numeric type
function isSameNumericType(a: Value, b: Value): boolean {
  return areBothInts(a, b) || areBothFloats(a, b);
}

// Build trace entries from an error's context
export function traceEntries(e: ErrorValue): Value {
  const ctx = e.box.ctx;
  if (ctx === null) return NIL;

  const entries: Value[] = [];

  // Entry 0 from the throwing expression's site
  const site0 = ctx.site;
  entries.push(
    list(
      site0.fn ?? FALSE,
      str(site0.pos?.file ?? ''),
      int(site0.pos?.line ?? 0),
      int(site0.pos?.col ?? 0)
    )
  );

  // One entry per frame in K, from top, skipping 'val' and 'throw' frames
  let K = ctx.K;
  while (K !== null) {
    const frame = K.top;
    if (frame.k !== 'val' && frame.k !== 'throw') {
      const site = frame.site;
      entries.push(
        list(
          site.fn ?? FALSE,
          str(site.pos?.file ?? ''),
          int(site.pos?.line ?? 0),
          int(site.pos?.col ?? 0)
        )
      );
    }
    K = K.next;
  }

  // Convert to list, innermost first (entries are already in that order)
  return list(...entries);
}

// Core operations
const ops = new Map<string, CoreOp>();

// 5.2 Arithmetic

ops.set('+', {
  name: '+',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (areBothInts(a, b)) {
      const sum = (a as any).v + (b as any).v;
      if (fitsInt(sum)) return ok(int(sum));
      return fail('overflow', 'integer arithmetic overflow');
    }
    if (areBothFloats(a, b)) {
      return ok(float((a as any).v + (b as any).v));
    }
    return fail('type-error', 'arithmetic requires both integers or both floats');
  },
});

ops.set('-', {
  name: '-',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (areBothInts(a, b)) {
      const av = (a as any).v as bigint;
      const bv = (b as any).v as bigint;
      const diff = av - bv;
      if (fitsInt(diff)) return ok(int(diff));
      return fail('overflow', 'integer arithmetic overflow');
    }
    if (areBothFloats(a, b)) {
      return ok(float((a as any).v - (b as any).v));
    }
    return fail('type-error', 'arithmetic requires both integers or both floats');
  },
});

ops.set('*', {
  name: '*',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (areBothInts(a, b)) {
      const av = (a as any).v as bigint;
      const bv = (b as any).v as bigint;
      const prod = av * bv;
      if (fitsInt(prod)) return ok(int(prod));
      return fail('overflow', 'integer arithmetic overflow');
    }
    if (areBothFloats(a, b)) {
      return ok(float((a as any).v * (b as any).v));
    }
    return fail('type-error', 'arithmetic requires both integers or both floats');
  },
});

ops.set('/', {
  name: '/',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (areBothInts(a, b)) {
      const av = (a as any).v as bigint;
      const bv = (b as any).v as bigint;
      if (bv === 0n) return fail('divide-by-zero', 'division by zero');
      // Truncate toward zero
      const quotient = av / bv;
      // Check if quotient fits in 64 bits
      if (!fitsInt(quotient)) return fail('overflow', 'integer arithmetic overflow');
      // JavaScript's BigInt division already truncates toward zero
      return ok(int(quotient));
    }
    if (areBothFloats(a, b)) {
      return ok(float((a as any).v / (b as any).v));
    }
    return fail('type-error', 'arithmetic requires both integers or both floats');
  },
});

ops.set('%', {
  name: '%',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (!areBothInts(a, b)) {
      return fail('type-error', 'modulo is integers only');
    }
    const bv = (b as any).v;
    if (bv === 0n) return fail('divide-by-zero', 'modulo by zero');
    const av = (a as any).v;
    // In JavaScript BigInt, % takes the sign of the dividend
    const remainder = av % bv;
    return ok(int(remainder));
  },
});

// 5.3 Comparison and equality

ops.set('=', {
  name: '=',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (!isSameNumericType(a, b)) {
      return fail('type-error', 'comparison requires both integers or both floats');
    }
    if (areBothInts(a, b)) {
      return ok(bool((a as any).v === (b as any).v));
    }
    return ok(bool((a as any).v === (b as any).v));
  },
});

ops.set('<', {
  name: '<',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (!isSameNumericType(a, b)) {
      return fail('type-error', 'comparison requires both integers or both floats');
    }
    if (areBothInts(a, b)) {
      return ok(bool((a as any).v < (b as any).v));
    }
    return ok(bool((a as any).v < (b as any).v));
  },
});

ops.set('<=', {
  name: '<=',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (!isSameNumericType(a, b)) {
      return fail('type-error', 'comparison requires both integers or both floats');
    }
    if (areBothInts(a, b)) {
      return ok(bool((a as any).v <= (b as any).v));
    }
    return ok(bool((a as any).v <= (b as any).v));
  },
});

ops.set('>', {
  name: '>',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (!isSameNumericType(a, b)) {
      return fail('type-error', 'comparison requires both integers or both floats');
    }
    if (areBothInts(a, b)) {
      return ok(bool((a as any).v > (b as any).v));
    }
    return ok(bool((a as any).v > (b as any).v));
  },
});

ops.set('>=', {
  name: '>=',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (!isSameNumericType(a, b)) {
      return fail('type-error', 'comparison requires both integers or both floats');
    }
    if (areBothInts(a, b)) {
      return ok(bool((a as any).v >= (b as any).v));
    }
    return ok(bool((a as any).v >= (b as any).v));
  },
});

ops.set('eq?', {
  name: 'eq?',
  arity: 2,
  fn: (args) => ok(bool(eq(args[0]!, args[1]!))),
});

ops.set('not', {
  name: 'not',
  arity: 1,
  fn: (args) => ok(bool(isFalse(args[0]!))),
});

// 5.4 Type predicates

ops.set('nil?', {
  name: 'nil?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'nil')),
});

ops.set('pair?', {
  name: 'pair?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'pair')),
});

ops.set('boolean?', {
  name: 'boolean?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'bool')),
});

ops.set('integer?', {
  name: 'integer?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'int')),
});

ops.set('float?', {
  name: 'float?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'float')),
});

ops.set('string?', {
  name: 'string?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'str')),
});

ops.set('symbol?', {
  name: 'symbol?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'sym')),
});

ops.set('procedure?', {
  name: 'procedure?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'closure')),
});

ops.set('error?', {
  name: 'error?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'error')),
});

ops.set('address?', {
  name: 'address?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'addr')),
});

ops.set('pid?', {
  name: 'pid?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'pid')),
});

ops.set('env?', {
  name: 'env?',
  arity: 1,
  fn: (args) => ok(bool(args[0]!.t === 'env')),
});

// 5.5 Pairs

ops.set('cons', {
  name: 'cons',
  arity: 2,
  fn: (args) => ok(cons(args[0]!, args[1]!)),
});

ops.set('car', {
  name: 'car',
  arity: 1,
  fn: (args) => {
    const a = args[0]!;
    if (a.t !== 'pair') return fail('type-error', 'car requires a pair');
    return ok((a as any).car);
  },
});

ops.set('cdr', {
  name: 'cdr',
  arity: 1,
  fn: (args) => {
    const a = args[0]!;
    if (a.t !== 'pair') return fail('type-error', 'cdr requires a pair');
    return ok((a as any).cdr);
  },
});

ops.set('apply', {
  name: 'apply',
  arity: 2,
  fn: (args) => {
    // apply is never called by the machine; it's handled specially
    // Return a type-error to match spec requirement
    return fail('type-error', 'apply must be handled by the machine');
  },
});

// 5.6 Strings

ops.set('string-length', {
  name: 'string-length',
  arity: 1,
  fn: (args) => {
    const s = args[0]!;
    if (s.t !== 'str') return fail('type-error', 'string-length requires a string');
    // Count Unicode scalar values (use [...s] to iterate properly)
    const strVal = (s as any).v as string;
    const count = [...strVal].length;
    return ok(int(count));
  },
});

ops.set('string-ref', {
  name: 'string-ref',
  arity: 2,
  fn: (args) => {
    const s = args[0]!;
    const i = args[1]!;
    if (s.t !== 'str') return fail('type-error', 'string-ref requires a string as first argument');
    if (i.t !== 'int') return fail('type-error', 'string-ref requires an integer as second argument');
    const strVal = (s as any).v as string;
    const idx = Number((i as any).v);
    const chars = [...strVal];
    if (idx < 0 || idx >= chars.length) {
      return fail('range-error', 'string index out of range');
    }
    // Return the code point as an integer
    const codePoint = chars[idx]!.codePointAt(0)!;
    return ok(int(codePoint));
  },
});

ops.set('string-append', {
  name: 'string-append',
  arity: 2,
  fn: (args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (a.t !== 'str') return fail('type-error', 'string-append requires strings');
    if (b.t !== 'str') return fail('type-error', 'string-append requires strings');
    return ok(str((a as any).v + (b as any).v));
  },
});

ops.set('symbol->string', {
  name: 'symbol->string',
  arity: 1,
  fn: (args) => {
    const s = args[0]!;
    if (s.t !== 'sym') return fail('type-error', 'symbol->string requires a symbol');
    return ok(str((s as any).name));
  },
});

ops.set('string->symbol', {
  name: 'string->symbol',
  arity: 1,
  fn: (args) => {
    const s = args[0]!;
    if (s.t !== 'str') return fail('type-error', 'string->symbol requires a string');
    return ok(sym((s as any).v));
  },
});

// 5.7 Conversions

ops.set('integer->float', {
  name: 'integer->float',
  arity: 1,
  fn: (args) => {
    const i = args[0]!;
    if (i.t !== 'int') return fail('type-error', 'integer->float requires an integer');
    return ok(float(Number((i as any).v)));
  },
});

ops.set('float->integer', {
  name: 'float->integer',
  arity: 1,
  fn: (args) => {
    const f = args[0]!;
    if (f.t !== 'float') return fail('type-error', 'float->integer requires a float');
    const fv = (f as any).v as number;
    // NaN and infinity are type-error (not finite)
    if (!isFinite(fv)) return fail('type-error', 'cannot convert non-finite float to integer');
    // Truncate toward zero
    const truncated = Math.trunc(fv);
    const bi = BigInt(truncated);
    if (!fitsInt(bi)) return fail('overflow', 'float value does not fit in 64-bit integer');
    return ok(int(bi));
  },
});

// 5.8 Errors

ops.set('make-error', {
  name: 'make-error',
  arity: 3,
  fn: (args) => {
    const tag = args[0]!;
    const message = args[1]!;
    const payload = args[2]!;
    if (tag.t !== 'sym') return fail('type-error', 'make-error requires tag to be a symbol');
    if (message.t !== 'str') return fail('type-error', 'make-error requires message to be a string');
    const e = makeError((tag as any).name, (message as any).v, payload);
    return ok(e);
  },
});

ops.set('wrap-error', {
  name: 'wrap-error',
  arity: 4,
  fn: (args) => {
    const cause = args[0]!;
    const tag = args[1]!;
    const message = args[2]!;
    const payload = args[3]!;
    if (cause.t !== 'error') return fail('type-error', 'wrap-error requires cause to be an error');
    if (tag.t !== 'sym') return fail('type-error', 'wrap-error requires tag to be a symbol');
    if (message.t !== 'str') return fail('type-error', 'wrap-error requires message to be a string');
    const e = makeError((tag as any).name, (message as any).v, payload, cause as ErrorValue);
    return ok(e);
  },
});

ops.set('throw', {
  name: 'throw',
  arity: 1,
  fn: (args) => {
    const e = args[0]!;
    if (e.t !== 'error') return fail('type-error', 'throw requires an error');
    // Return a special result that tells the machine to throw this error
    // The machine will handle the throw and apply the already-thrown rule
    return { ok: false, e: e as ErrorValue };
  },
});

ops.set('error-tag', {
  name: 'error-tag',
  arity: 1,
  fn: (args) => {
    const e = args[0]!;
    if (e.t !== 'error') return fail('type-error', 'error-tag requires an error');
    return ok(((e as ErrorValue).tag));
  },
});

ops.set('error-message', {
  name: 'error-message',
  arity: 1,
  fn: (args) => {
    const e = args[0]!;
    if (e.t !== 'error') return fail('type-error', 'error-message requires an error');
    return ok(str((e as ErrorValue).message));
  },
});

ops.set('error-payload', {
  name: 'error-payload',
  arity: 1,
  fn: (args) => {
    const e = args[0]!;
    if (e.t !== 'error') return fail('type-error', 'error-payload requires an error');
    return ok((e as ErrorValue).payload);
  },
});

ops.set('error-cause', {
  name: 'error-cause',
  arity: 1,
  fn: (args) => {
    const e = args[0]!;
    if (e.t !== 'error') return fail('type-error', 'error-cause requires an error');
    const cause = (e as ErrorValue).cause;
    return ok(cause ?? FALSE);
  },
});

ops.set('stack-trace-for', {
  name: 'stack-trace-for',
  arity: 1,
  fn: (args) => {
    const e = args[0]!;
    if (e.t !== 'error') return fail('type-error', 'stack-trace-for requires an error');
    return ok(traceEntries(e as ErrorValue));
  },
});

// Export the CORE map
export const CORE: ReadonlyMap<string, CoreOp> = ops;
