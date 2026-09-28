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
import { renderTable, type Align, type Column, type TableCell } from './table.ts';

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
    | 'numbers' | 'rows' | 'series' | 'colors' | 'strings' | 'columns'
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
    // Tables (section 16): converted by convertTable, not by React directly.
    ['Table', {
        type: Box, props: new Set(['columns', 'header', 'gap', 'key']), children: true,
        kinds: new Map<string, Kind>([['columns', 'columns'], ['header', 'bool'], ['gap', 'int']]), required: ['columns'],
    }],
    ['Row', { type: Box, props: new Set([...TEXT_PROPS, 'key']), children: true }],
    ['Cell', {
        type: Box, props: new Set([...TEXT_PROPS, 'span', 'align', 'key']), children: true,
        kinds: new Map<string, Kind>([['span', 'int'], ['align', ['left', 'right', 'center']]]),
    }],
]);

const CHARTS = new Set(['Sparkline', 'BarChart', 'StackedBarChart', 'LineGraph']);

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
    if (tag === 'Row') throw new ViewError('Row must be inside a Table', v);
    if (tag === 'Cell') throw new ViewError('Cell must be inside a Row', v);
    if (component.kinds !== undefined && inText) throw new ViewError(`${tag} cannot be inside a Text`, v);
    if (tag === 'Table') return convertTable(items, component, v);

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
        case 'columns': return list().map((c): Column => {
            const col = listToArray(c);
            const shape = '(title width) or (title width align)';
            if (col === null || col.length < 2 || col.length > 3 || col[0]!.t !== 'str') return fail(shape, c);
            const w = col[1]!;
            const width = w.t === 'int' && w.v >= 0n ? Number(w.v) : w.t === 'sym' && w.name === 'auto' ? 'auto' : fail(shape, c);
            const a = col[2];
            const align = a === undefined ? 'left' : a.t === 'sym' && ['left', 'right', 'center'].includes(a.name) ? a.name as Align : fail(shape, c);
            return { title: col[0]!.v, width, align };
        });
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

// ---------------------------------------------------------------------------
// Tables (section 16)

function tableProps(items: Value[], tag: string, component: Component): { props: Record<string, unknown>; rest: Value[] } {
    const first = items[1];
    if (first !== undefined && first.t === 'pair' && first.car.t === 'sym' && first.car.name === '@') {
        return { props: convertProps(first, tag, component), rest: items.slice(2) };
    }
    for (const name of component.required ?? []) throw new ViewError(`${tag} requires ${name}`, listFrom(items));
    return { props: {}, rest: items.slice(1) };
}

function listFrom(items: Value[]): Value {
    return items.reduceRight<Value>((tail, head) => ({ t: 'pair', car: head, cdr: tail, pos: null }) as Value, { t: 'nil' } as Value);
}

// Text styles given as props, without `key`.
function styleOf(props: Record<string, unknown>): Record<string, unknown> {
    const style: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) if (TEXT_PROPS.includes(k)) style[k] = v;
    return style;
}

function convertTable(items: Value[], component: Component, v: Value): React.ReactElement {
    const { props, rest } = tableProps(items, 'Table', component);
    const columns = props['columns'] as Column[];
    const rows: TableCell[][] = [];
    const add = (child: Value): void => {
        if (child.t === 'nil' || (child.t === 'bool' && !child.v)) return;
        if (child.t === 'pair' && child.car.t !== 'sym') {
            for (const c of listToArray(child) ?? [child]) add(c);
            return;
        }
        const parts = listToArray(child);
        if (parts === null || parts[0]?.t !== 'sym' || parts[0].name !== 'Row') {
            throw new ViewError('a Table holds only Row elements', child);
        }
        rows.push(convertRow(parts, child, columns.length));
    };
    for (const child of rest) add(child);
    return renderTable({
        columns,
        header: (props['header'] as boolean | undefined) ?? true,
        gap: (props['gap'] as number | undefined) ?? 1,
        rows,
    });
}

function convertRow(items: Value[], v: Value, columns: number): TableCell[] {
    const { props, rest } = tableProps(items, 'Row', COMPONENTS.get('Row')!);
    const rowStyle = styleOf(props);
    const cells = rest.map((child) => convertCell(child, rowStyle));
    if (cells.reduce((n, c) => n + c.span, 0) > columns) {
        throw new ViewError('the row has more cells than the table has columns', v);
    }
    return cells;
}

function convertCell(child: Value, rowStyle: Record<string, unknown>): TableCell {
    const parts = listToArray(child);
    let span = 1;
    let align: Align | undefined;
    let style = rowStyle;
    let content: Value[] = [child];
    if (parts !== null && parts[0]?.t === 'sym' && parts[0].name === 'Cell') {
        const { props, rest } = tableProps(parts, 'Cell', COMPONENTS.get('Cell')!);
        span = (props['span'] as number | undefined) ?? 1;
        if (span < 1) throw new ViewError('Cell span must be at least 1', child);
        align = props['align'] as Align | undefined;
        style = { ...rowStyle, ...styleOf(props) };
        content = rest;
    }
    const only = content.length === 1 ? listToArray(content[0]!) : null;
    if (only !== null && only[0]?.t === 'sym' && CHARTS.has(only[0].name)) {
        const chart = convert(content[0]!, false) as React.ReactElement;
        return { span, align, style, chart, nodes: [], text: '' };
    }
    const nodes: Node[] = [];
    for (const c of content) splice(c, true, nodes);
    return {
        span, align, style, chart: null,
        nodes: nodes.filter((n): n is React.ReactElement | string => n !== null),
        text: content.map(plainText).join(''),
    };
}

// The text a cell shows, for measuring `auto` columns.
function plainText(v: Value): string {
    if (v.t === 'str') return v.v;
    if (v.t === 'int' || v.t === 'float') return String(v.v);
    const items = listToArray(v);
    if (items === null) return '';
    const body = items[0]?.t === 'sym' ? items.slice(1) : items;
    return body
        .filter((x) => !(x.t === 'pair' && x.car.t === 'sym' && x.car.name === '@'))
        .map(plainText)
        .join('');
}
