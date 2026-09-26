// Views as data (SPEC-TUI section 3): converts a view, built by CPI code as
// `(Tag (@ (prop value) ...) child ...)`, into a React element for Ink.
//
// Every component and prop must be on the allowlists below; anything else
// is a ViewError, which the runtime throws into the CPI as a `type-error`
// with the offending part of the view as the payload.

import React from 'react';
import { Box, Newline, Spacer, Text } from 'ink';
import type { Value } from '../types.ts';
import { listToArray } from '../values.ts';
import { print } from '../printer.ts';

const BOX_PROPS = [
    'flexDirection', 'flexGrow', 'flexShrink', 'flexBasis', 'flexWrap', 'alignItems', 'alignSelf',
    'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight',
    'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'borderStyle', 'borderColor', 'overflow', 'display',
];
const TEXT_PROPS = ['color', 'backgroundColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'dimColor', 'wrap'];

type Component = { readonly type: React.ElementType; readonly props: ReadonlySet<string>; readonly children: boolean };

// The allowlist (section 3.2): the capability surface of the namespace.
const COMPONENTS: ReadonlyMap<string, Component> = new Map<string, Component>([
    ['Box', { type: Box, props: new Set([...BOX_PROPS, 'key']), children: true }],
    ['Text', { type: Text, props: new Set([...TEXT_PROPS, 'key']), children: true }],
    ['Newline', { type: Newline, props: new Set(['key']), children: false }],
    ['Spacer', { type: Spacer, props: new Set(['key']), children: false }],
]);

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

// `inText` is true inside a Text, the only place text may appear.
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
        props = convertProps(first, tag, component);
        rest = rest.slice(1);
    }
    const children: Node[] = [];
    for (const child of rest) splice(child, tag === 'Text' || inText, children);
    if (!component.children && children.length > 0) throw new ViewError(`${tag} takes no children`, v);
    return React.createElement(component.type, props, ...children);
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

function convertProps(at: Value, tag: string, component: Component): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const entry of listToArray(at)!.slice(1)) {
        const pair = listToArray(entry);
        if (pair === null || pair.length !== 2 || pair[0]!.t !== 'sym') {
            throw new ViewError('a prop must be (name value)', entry);
        }
        const name = pair[0]!.name;
        if (!component.props.has(name)) throw new ViewError(`${tag} has no prop ${name}`, entry);
        props[name] = propValue(pair[1]!);
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
