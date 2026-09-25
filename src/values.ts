// Value constructors and list helpers. Owned by the manager, like types.ts.

import type { Addr, Bool, Float, Int, Nil, Pair, Pid, Pos, Str, Sym, Value } from './types.ts';

export const NIL: Nil = { t: 'nil' };
export const TRUE: Bool = { t: 'bool', v: true };
export const FALSE: Bool = { t: 'bool', v: false };

const symbols = new Map<string, Sym>();

// Interned: sym('x') === sym('x').
export function sym(name: string): Sym {
    let s = symbols.get(name);
    if (s === undefined) {
        s = { t: 'sym', name };
        symbols.set(name, s);
    }
    return s;
}

let gensymCounter = 0;

// A fresh symbol no source text can spell: the reader never produces a token starting with '#:'.
export function gensym(hint = 'g'): Sym {
    gensymCounter += 1;
    return sym(`#:${hint}${gensymCounter}`);
}

export const bool = (b: boolean): Bool => (b ? TRUE : FALSE);

export const INT_MIN = -(2n ** 63n);
export const INT_MAX = 2n ** 63n - 1n;

export function fitsInt(n: bigint): boolean {
    return n >= INT_MIN && n <= INT_MAX;
}

// Callers must check fitsInt first where overflow is possible.
export function int(n: bigint | number): Int {
    const v = typeof n === 'bigint' ? n : BigInt(n);
    if (!fitsInt(v)) throw new RangeError(`integer out of 64-bit range: ${v}`);
    return { t: 'int', v };
}

export const float = (v: number): Float => ({ t: 'float', v });
export const str = (v: string): Str => ({ t: 'str', v });
export const cons = (car: Value, cdr: Value, pos: Pos | null = null): Pair => ({ t: 'pair', car, cdr, pos });

let addrCounter = 0;
export function newAddr(): Addr {
    addrCounter += 1;
    // Prototype: unique, not unguessable. Real addresses need at least 128 random bits.
    return { t: 'addr', id: `a${addrCounter}` };
}

const pids = new Map<number, Pid>();

// Interned, like symbols: every PID value for process n is the same object,
// so `eq?` (identity for PIDs) holds however the runtime produced it.
export function pid(id: number): Pid {
    let p = pids.get(id);
    if (p === undefined) {
        p = { t: 'pid', id };
        pids.set(id, p);
    }
    return p;
}

export function list(...items: Value[]): Value {
    let out: Value = NIL;
    for (let i = items.length - 1; i >= 0; i--) out = cons(items[i]!, out);
    return out;
}

// Returns null if v is not a proper list.
export function listToArray(v: Value): Value[] | null {
    const out: Value[] = [];
    let cur = v;
    while (cur.t === 'pair') {
        out.push(cur.car);
        cur = cur.cdr;
    }
    return cur.t === 'nil' ? out : null;
}

export const isFalse = (v: Value): boolean => v === FALSE;
