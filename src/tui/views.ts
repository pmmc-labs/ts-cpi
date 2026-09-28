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
import { BarChartView, LineGraphView, Sparkline, StackedBarChartView, type Row } from './charts.ts';

const BOX_PROPS = [
    'flexDirection', 'flexGrow', 'flexShrink', 'flexBasis', 'flexWrap', 'alignItems', 'alignSelf',
    'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight',
    'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'borderStyle', 'borderColor', 'overflow', 'display',
];
const TEXT_PROPS = ['color', 'backgroundColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'dimColor', 'wrap'];

// What a chart prop takes (section 3.3). Other components' props take any
// atom, passed to the renderer unchanged.
type Kind =
    | 'number' | 'int' | 'bool' | 'string' | 'color'
    | 'numbers' | 'rows' | 'series' | 'colors' | 'strings'
    | readonly string[];

type Component = {
    readonly type: React.ElementType;
    readonly props: ReadonlySet<string>;
    readonly children: boolean;
    // Chart components: each prop's kind, and the props that must be given.
    readonly kinds?: ReadonlyMap<string, Kind>;
    readonly required?: readonly string[];
};

function chart(type: React.ElementType, kinds: Record<string, Kind>): Component {
    const all = new Map<string, Kind>(Object.entries(kinds));
    return { type, props: new Set([...all.keys(), 'key']), children: false, kinds: all, required: ['data'] };
}

// The allowlist (section 3.2): the capability surface of the namespace.
const COMPONENTS: ReadonlyMap<string, Component> = new Map<string, Component>([
    ['Box', { type: Box, props: new Set([...BOX_PROPS, 'key']), children: true }],
    ['Text', { type: Text, props: new Set([...TEXT_PROPS, 'key']), children: true }],
    ['Newline', { type: Newline, props: new Set(['key']), children: false }],
    ['Spacer', { type: Spacer, props: new Set(['key']), children: false }],
    ['Sparkline', chart(Sparkline, {
        data: 'numbers', width: 'int', min: 'number', max: 'number', color: 'color', underline: 'bool',
        mode: ['block', 'braille'],
    })],
    ['BarChart', chart(BarChartView, {
        data: 'rows', width: 'int', max: 'number', showValue: ['right', 'inside', 'none'], suffix: 'string',
        sort: ['none', 'asc', 'desc'], color: 'color', barChar: ['█', '▆', '▓', '▒', '░'],
    })],
    ['StackedBarChart', chart(StackedBarChartView, {
        data: 'rows', mode: ['percentage', 'absolute'], max: 'number', width: 'int', showLabels: 'bool',
        showValues: 'bool', suffix: 'string',
    })],
    ['LineGraph', chart(LineGraphView, {
        data: 'series', colors: 'colors', width: 'int', height: 'int', min: 'number', max: 'number',
        showYAxis: 'bool', xLabels: 'strings', caption: 'string',
    })],
]);

// Ink's color names, as chalk knows them; anything else must be a hex code.
const COLOR_NAMES = new Set([
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
    'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
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
    if (tag === 'Newline' && !inText) throw new ViewError('Newline must be inside a Text', v);
    if (component.kinds !== undefined && inText) throw new ViewError(`${tag} cannot be inside a Text`, v);

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
        const kind = component.kinds?.get(name);
        props[name] = kind === undefined ? propValue(pair[1]!) : chartValue(kind, pair[1]!, `${tag} ${name}`);
    }
    for (const name of component.required ?? []) {
        if (props[name] === undefined) throw new ViewError(`${tag} requires ${name}`, at);
    }
    return props;
}

// A chart prop's value, checked against its kind. `what` names the prop in
// errors; the payload is the offending part.
function chartValue(kind: Kind, v: Value, what: string): unknown {
    const fail = (expected: string, at: Value = v): never => {
        throw new ViewError(`${what} must be ${expected}`, at);
    };
    const list = (): Value[] => listToArray(v) ?? fail('a list');
    const number = (x: Value): number => (x.t === 'int' ? Number(x.v) : x.t === 'float' ? x.v : fail('numbers', x));
    const color = (x: Value): string => {
        const name = x.t === 'str' ? x.v : x.t === 'sym' ? x.name : fail('a color', x);
        return COLOR_NAMES.has(name) || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(name) ? name : fail('a color', x);
    };
    if (typeof kind !== 'string') {
        const name = v.t === 'sym' ? v.name : v.t === 'str' ? v.v : fail(`one of ${kind.join(', ')}`);
        return kind.includes(name) ? name : fail(`one of ${kind.join(', ')}`);
    }
    switch (kind) {
        case 'number': return number(v);
        case 'int': return v.t === 'int' ? Number(v.v) : fail('an integer');
        case 'bool': return v.t === 'bool' ? v.v : fail('a boolean');
        case 'string': return v.t === 'str' ? v.v : fail('a string');
        case 'color': return color(v);
        case 'numbers': return list().map(number);
        case 'colors': return list().map(color);
        case 'strings': return list().map((x) => (x.t === 'str' ? x.v : fail('strings', x)));
        case 'series': return list().map((s) => (listToArray(s) ?? fail('lists of numbers', s)).map(number));
        case 'rows': return list().map((r): Row => {
            const row = listToArray(r);
            if (row === null || row.length < 2 || row.length > 3 || row[0]!.t !== 'str') {
                return fail('(label value) or (label value color)', r);
            }
            const out: Row = { label: row[0]!.v, value: number(row[1]!) };
            return row.length === 3 ? { ...out, color: color(row[2]!) } : out;
        });
    }
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
