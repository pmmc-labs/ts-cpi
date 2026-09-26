// Spike: views as data. Converts an SXML-style view, built by CPI code, into
// Ink (React) elements.
//
//   (Tag (@ (prop value) ...) child ...)
//
// - Tag is a symbol naming a component on the allowlist below.
// - The optional (@ ...) list holds props. A prop value that is a symbol
//   becomes a string, so (flexDirection column) needs no quotes.
// - A child is a string or number (text, allowed only inside Text), another
//   view, a list of children (spliced in place, so `(map f xs)` works as a
//   child), or () or #false (nothing, so `(and show? view)` works).
//
// Children are passed positionally, so React reconciles them by position and
// needs no keys. A (key ...) prop is passed through for lists whose items
// move between frames.

import React from 'react';
import { Box, Newline, Spacer, Text } from 'ink';
import type { Value } from '../../src/types.ts';
import { listToArray } from '../../src/values.ts';
import { print } from '../../src/printer.ts';

// The allowlist: the only components a view can name. This is the capability
// surface of the binding.
export const COMPONENTS: ReadonlyMap<string, React.ElementType> = new Map<string, React.ElementType>([
    ['Box', Box],
    ['Text', Text],
    ['Newline', Newline],
    ['Spacer', Spacer],
]);

// Thrown for a malformed view. `at` is the offending part of the view. In
// the runtime this becomes a `type-error` thrown into the CPI.
export class ViewError extends Error {
    readonly at: Value;
    constructor(message: string, at: Value) {
        super(`${message}: ${print(at)}`);
        this.at = at;
    }
}

export function toElement(view: Value): React.ReactElement {
    const el = convert(view, false);
    if (el === null || typeof el === 'string') throw new ViewError('a view must be an element', view);
    return el;
}

type Node = React.ReactElement | string | null;

// `inText` is true inside a Text, the only place bare strings may appear.
function convert(v: Value, inText: boolean): Node {
    if (v.t === 'nil' || (v.t === 'bool' && !v.v)) return null;
    if (v.t === 'str' || v.t === 'int' || v.t === 'float') {
        if (!inText) throw new ViewError('text must be inside a Text', v);
        return v.t === 'str' ? v.v : String(v.v);
    }
    const items = listToArray(v);
    if (items === null || items.length === 0 || items[0]!.t !== 'sym') {
        throw new ViewError('expected (Tag (@ ...) child ...)', v);
    }
    const tag = items[0]!.name;
    const component = COMPONENTS.get(tag);
    if (component === undefined) throw new ViewError(`unknown component ${tag}`, v);

    let rest = items.slice(1);
    let props: Record<string, unknown> = {};
    const first = rest[0];
    if (first !== undefined && first.t === 'pair' && first.car.t === 'sym' && first.car.name === '@') {
        props = convertProps(first);
        rest = rest.slice(1);
    }
    const children: Node[] = [];
    for (const child of rest) splice(child, tag === 'Text' || inText, children);
    return React.createElement(component, props, ...children);
}

// A child that is a list of views (not itself a view) is spliced in.
function splice(child: Value, inText: boolean, out: Node[]): void {
    if (child.t === 'pair' && child.car.t !== 'sym') {
        for (const c of listToArray(child) ?? [child]) splice(c, inText, out);
        return;
    }
    const node = convert(child, inText);
    if (node !== null) out.push(node);
}

function convertProps(at: Value): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const entry of listToArray(at)!.slice(1)) {
        const pair = listToArray(entry);
        if (pair === null || pair.length !== 2 || pair[0]!.t !== 'sym') {
            throw new ViewError('a prop must be (name value)', entry);
        }
        props[pair[0]!.name] = propValue(pair[1]!);
    }
    return props;
}

function propValue(v: Value): unknown {
    switch (v.t) {
        case 'str': return v.v;
        case 'sym': return v.name;
        case 'int': return Number(v.v);
        case 'float': return v.v;
        case 'bool': return v.v;
        default: throw new ViewError('a prop value must be a string, symbol, number or boolean', v);
    }
}
