// Environments: slot composition, resolution and hashing. (DESIGN-001 section 8, SPEC-CPI sections 6 and 10.4)

import { createHash } from 'node:crypto';
import type { Env, Slot, Value } from './types.ts';

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

// "Identical" means ===, or two atoms (bool, nil, int, float, str, sym) of the same type and value.
// DECISION: atoms are compared by type and value, not by reference.
function valuesIdentical(a: Value, b: Value): boolean {
    // Same reference
    if (a === b) return true;

    // Both must be the same type
    if (a.t !== b.t) return false;

    // Check type-specific equality for atoms
    switch (a.t) {
        case 'bool':
            return (a as any).v === (b as any).v;
        case 'nil':
            return true; // there's only one nil
        case 'int':
            return (a as any).v === (b as any).v;
        case 'float':
            return (a as any).v === (b as any).v;
        case 'str':
            return (a as any).v === (b as any).v;
        case 'sym':
            // Symbols are interned, so === is sufficient (but we check anyway)
            return (a as any).name === (b as any).name;
        default:
            // Non-atoms are compared by reference only
            return false;
    }
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
        if (valuesIdentical(left.value, right.value)) {
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
