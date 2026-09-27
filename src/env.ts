// Environments: slot composition, resolution and hashing. (DESIGN-001 section 8, SPEC-CPI sections 6 and 10.4)

import { createHash } from 'node:crypto';
import type { Closure, Env, Slot, Value } from './types.ts';
import { isHostName } from './names.ts';
import { print } from './printer.ts';

// ---------------------------------------------------------------
// Construction
// ---------------------------------------------------------------

export function emptyEnv(): Env {
    return { slots: new Map() };
}

export function fromBindings(bindings: ReadonlyArray<readonly [string, Value]>): Env {
    const slots = new Map<string, Slot>();
    for (const [name, value] of bindings) {
        slots.set(name, { s: 'defined', name, value });
    }
    return { slots };
}

export function required(name: string): Env {
    return { slots: new Map([[name, { s: 'required', name }]]) };
}

// ---------------------------------------------------------------
// Comparison of values for composition
// ---------------------------------------------------------------

// Identical for composition (DECISIONS.md, "Building environments from
// roles"): atoms of the same type and value; pairs and vectors whose elements
// are identical; closures with an empty local scope and no group whose names,
// parameters and expanded bodies are identical (the same core hash); env refs
// whose environments have identical slots. Anything else only if it is the
// same value.
export function identical(a: Value, b: Value): boolean {
    for (;;) {
        if (a === b) return true;
        if (a.t !== b.t) return false;
        switch (a.t) {
            case 'bool':
            case 'int':
            case 'float':
            case 'str':
                return a.v === (b as typeof a).v;
            case 'nil':
                return true;
            case 'sym':
                return false; // interned: equal symbols are ===
            case 'vec': {
                const bs = (b as typeof a).items;
                return a.items.length === bs.length && a.items.every((x, i) => identical(x, bs[i]!));
            }
            case 'closure':
                return closuresIdentical(a, b as Closure);
            case 'env':
                return envsIdentical(a.env, (b as typeof a).env);
            case 'pair': {
                const bp = b as typeof a;
                if (!identical(a.car, bp.car)) return false;
                a = a.cdr;   // walk the list's spine without recursion
                b = bp.cdr;
                continue;
            }
            default:
                return false;
        }
    }
}

function closuresIdentical(a: Closure, b: Closure): boolean {
    if (a.scope !== null || b.scope !== null || a.group !== null || b.group !== null) return false;
    if (a.name !== b.name) return false;
    if (a.params.length !== b.params.length || a.params.some((p, i) => p !== b.params[i])) return false;
    return a.body.length === b.body.length && a.body.every((x, i) => identical(x, b.body[i]!));
}

function slotsIdentical(a: Slot, b: Slot): boolean {
    if (a === b) return true;
    if (a.s === 'required' || b.s === 'required') return a.s === b.s;
    if (a.s === 'defined' && b.s === 'defined') return identical(a.value, b.value);
    if (a.s === 'conflicted' && b.s === 'conflicted') {
        return slotsIdentical(a.left, b.left) && slotsIdentical(a.right, b.right);
    }
    return false;
}

function envsIdentical(a: Env, b: Env): boolean {
    if (a === b) return true;
    if (a.slots.size !== b.slots.size) return false;
    for (const [name, slot] of a.slots) {
        const other = b.slots.get(name);
        if (other === undefined || !slotsIdentical(slot, other)) return false;
    }
    return true;
}

// ---------------------------------------------------------------
// Composition
// ---------------------------------------------------------------

// Compose two slots.
// - Required is the identity
// - Identical defined slots stay defined
// - Different defined slots become conflicted
// - Composition recurses into the right side of existing conflicted slots
function composeSlots(left: Slot, right: Slot): Slot {
    // Required is identity
    if (left.s === 'required') return right;
    if (right.s === 'required') return left;

    // Both are defined
    if (left.s === 'defined' && right.s === 'defined') {
        if (identical(left.value, right.value)) {
            return left; // or right, they're identical
        }
        return { s: 'conflicted', name: left.name, left, right };
    }

    // Left is conflicted, recurse on right
    if (left.s === 'conflicted') {
        const newRight = composeSlots(left.right, right);
        if (newRight === left.right) return left;
        return { s: 'conflicted', name: left.name, left: left.left, right: newRight };
    }

    // Right is conflicted, compose associatively: compose(left, conflicted(a, b)) = compose(compose(left, a), b)
    if (right.s === 'conflicted') {
        const composed = composeSlots(left, right.left);
        return composeSlots(composed, right.right);
    }

    // This should never happen
    return left;
}

export function compose(left: Env, right: Env): Env {
    const slots = new Map<string, Slot>();

    // Start with all slots from left
    for (const [name, slot] of left.slots) {
        slots.set(name, slot);
    }

    // Compose with all slots from right
    for (const [name, rightSlot] of right.slots) {
        const leftSlot = slots.get(name);
        if (leftSlot === undefined) {
            slots.set(name, rightSlot);
        } else {
            slots.set(name, composeSlots(leftSlot, rightSlot));
        }
    }

    return { slots };
}

// ---------------------------------------------------------------
// Module rule composition
// ---------------------------------------------------------------

export function composeModule(
    left: Env,
    right: Env
): { ok: true; env: Env } | { ok: false; conflicts: string[] } {
    const composed = compose(left, right);
    const newConflicts: string[] = [];

    // Check for NEW conflicted slots
    for (const [name, slot] of composed.slots) {
        if (slot.s === 'conflicted') {
            // A new conflict is any conflicted slot the composition created or changed.
            if (slot !== left.slots.get(name)) {
                newConflicts.push(name);
            }
        }
    }

    if (newConflicts.length > 0) {
        return { ok: false, conflicts: newConflicts };
    }

    return { ok: true, env: composed };
}

// ---------------------------------------------------------------
// Resolution (scope rule)
// ---------------------------------------------------------------

export function lookup(env: Env, name: string): Value | null {
    const slot = env.slots.get(name);
    if (slot === undefined) return null;

    // Required or conflicted (which resolves to right side)
    if (slot.s === 'required') return null;

    if (slot.s === 'defined') {
        return slot.value;
    }

    // Conflicted: recursively resolve the right side
    let current: Slot = slot;
    while (current.s === 'conflicted') {
        current = current.right;
    }

    // Now current is either defined or required
    if (current.s === 'defined') {
        return current.value;
    }

    // It's required
    return null;
}

// ---------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------

export function conflicts(env: Env): string[] {
    const names: string[] = [];
    for (const [name, slot] of env.slots) {
        if (slot.s === 'conflicted') {
            names.push(name);
        }
    }
    return names;
}

// ---------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------

export function bindingHash(env: Env, printValue: (v: Value) => string): string {
    // Resolve all names and get their values, ignoring required and conflicted
    const resolved = new Map<string, string>();

    for (const [name, slot] of env.slots) {
        const value = lookup(env, name);
        if (value !== null) {
            resolved.set(name, printValue(value));
        }
    }

    // Sort by name and create hash
    const sortedNames = Array.from(resolved.keys()).sort();
    const lines: string[] = [];
    for (const name of sortedNames) {
        lines.push(`${name}:${resolved.get(name)}`);
    }

    const input = lines.join('\n');
    return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------
// Building and inspecting environments from the language (DECISIONS.md,
// "Building environments from roles"; SPEC-CPI section 10.4)
// ---------------------------------------------------------------

export function define(env: Env, name: string, value: Value): Env {
    return compose(env, fromBindings([[name, value]]));
}

export function requiredNames(env: Env): string[] {
    const names: string[] = [];
    for (const [name, slot] of env.slots) {
        if (slot.s === 'required') names.push(name);
    }
    return names;
}

// The values `name` has been defined to, oldest first: the Defined leaves of
// its slot in composition order.
export function history(env: Env, name: string): Value[] {
    const out: Value[] = [];
    const walk = (slot: Slot): void => {
        if (slot.s === 'defined') out.push(slot.value);
        else if (slot.s === 'conflicted') {
            walk(slot.left);
            walk(slot.right);
        }
    };
    const slot = env.slots.get(name);
    if (slot !== undefined) walk(slot);
    return out;
}

// Each named Conflicted slot flattened to the Defined slot it resolves to
// under the scope policy; other names are left as they are.
export function accept(env: Env, names: readonly string[]): Env {
    const slots = new Map(env.slots);
    for (const name of names) {
        const slot = slots.get(name);
        if (slot === undefined || slot.s !== 'conflicted') continue;
        let winner: Slot = slot;
        while (winner.s === 'conflicted') winner = winner.right;
        slots.set(name, winner);
    }
    return { slots };
}

// The slots of `a` that `b` does not have with an identical slot under the
// same name: what composing `a` onto `b` would change.
export function difference(a: Env, b: Env): Env {
    const slots = new Map<string, Slot>();
    for (const [name, slot] of a.slots) {
        const other = b.slots.get(name);
        if (other === undefined || !slotsIdentical(slot, other)) slots.set(name, slot);
    }
    return { slots };
}

// The slots of `env` named in `names`, each as it is (a Conflicted slot keeps
// its history). Names `env` does not have are left out.
export function select(env: Env, names: readonly string[]): Env {
    const slots = new Map<string, Slot>();
    for (const name of names) {
        const slot = env.slots.get(name);
        if (slot !== undefined) slots.set(name, slot);
    }
    return { slots };
}

// Required names that are not host request names: what composition must still fill.
export function unfilledNames(env: Env): string[] {
    return requiredNames(env).filter((name) => !isHostName(name));
}

// The first namespace among the environment's Required host request names
// that `grants` does not include, or null.
export function missingNamespace(env: Env, grants: ReadonlySet<string>): string | null {
    for (const name of requiredNames(env)) {
        if (!isHostName(name)) continue;
        const ns = name.slice(0, name.indexOf('::'));
        if (!grants.has(ns)) return ns;
    }
    return null;
}

// ---------------------------------------------------------------
// The binding hash, as the runtime computes it
// ---------------------------------------------------------------

// Text for the binding hash: like `print`, except that a closure shows its
// code as `(name params body)` and an env ref shows its own binding hash, so
// the hash covers code and the roles written inside it.
export function hashText(v: Value): string {
    switch (v.t) {
        case 'closure': {
            const name = v.name === null ? '#false' : v.name.name;
            const params = v.params.map((p) => p.name).join(' ');
            return `(${name} (${params}) (${v.body.map(hashText).join(' ')}))`;
        }
        case 'env':
            return `#<env ${bindingHashOf(v.env)}>`;
        case 'vec':
            return '#(' + v.items.map(hashText).join(' ') + ')';
        case 'pair': {
            const parts: string[] = [];
            let cur: Value = v;
            while (cur.t === 'pair') {
                parts.push(hashText(cur.car));
                cur = cur.cdr;
            }
            return cur.t === 'nil' ? `(${parts.join(' ')})` : `(${parts.join(' ')} . ${hashText(cur)})`;
        }
        default:
            return print(v);
    }
}

const bindingHashes = new WeakMap<Env, string>();

// Environments are immutable, so each one's binding hash is computed once.
export function bindingHashOf(env: Env): string {
    let hash = bindingHashes.get(env);
    if (hash === undefined) {
        hash = bindingHash(env, hashText);
        bindingHashes.set(env, hash);
    }
    return hash;
}
