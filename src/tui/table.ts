// Tables (SPEC-TUI section 16): rows of cells laid out in columns by the
// host. views.ts checks the view and hands over plain descriptions; this file
// measures `auto` columns and makes a Box per row and a fixed-width Box per
// cell, which is what the CPI's own code did before.

import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { Sparkline, sparklineText } from './charts.ts';

export type Align = 'left' | 'right' | 'center';

export type Column = { readonly title: string; readonly width: number | 'auto'; readonly align: Align };

export type TableCell = {
    readonly span: number;
    readonly align: Align | undefined;
    // Text styles for the cell: the row's, overridden by the cell's own.
    readonly style: Readonly<Record<string, unknown>>;
    // A chart, drawn as it is, or the children of a Text.
    readonly chart: React.ReactElement | null;
    readonly nodes: readonly (React.ReactElement | string)[];
    // The cell's text, for measuring `auto` columns ('' for a chart).
    readonly text: string;
};

export type TableSpec = {
    readonly columns: readonly Column[];
    readonly header: boolean;
    readonly gap: number;
    readonly rows: readonly (readonly TableCell[])[];
};

const JUSTIFY: Record<Align, 'flex-start' | 'flex-end' | 'center'> = { left: 'flex-start', right: 'flex-end', center: 'center' };

// An `auto` column is as wide as its widest single-column cell, title included.
function widths(spec: TableSpec): number[] {
    return spec.columns.map((c, i) => {
        if (c.width !== 'auto') return c.width;
        let widest = spec.header ? stringWidth(c.title) : 0;
        for (const row of spec.rows) {
            let at = 0;
            for (const cell of row) {
                if (at === i && cell.span === 1) widest = Math.max(widest, stringWidth(cell.text));
                at += cell.span;
            }
        }
        return widest;
    });
}

export function renderTable(spec: TableSpec): React.ReactElement {
    const w = widths(spec);
    const rows: React.ReactElement[] = [];
    const header: TableCell[] = spec.columns.map((c) => ({
        span: 1, align: undefined, style: { dimColor: true }, chart: null, nodes: [c.title], text: c.title,
    }));
    const all = spec.header ? [header, ...spec.rows] : spec.rows;
    all.forEach((cells, r) => {
        const line = rowAsLine(spec, w, cells, r);
        if (line !== null) {
            rows.push(line);
            return;
        }
        const boxes: React.ReactElement[] = [];
        let at = 0;
        cells.forEach((cell, c) => {
            const span = w.slice(at, at + cell.span);
            const width = span.reduce((a, b) => a + b, 0) + spec.gap * (cell.span - 1);
            const align = cell.align ?? spec.columns[at]!.align;
            const last = at + cell.span === spec.columns.length;
            at += cell.span;
            const content = cell.chart !== null
                ? (cell.chart.props as { width?: number }).width === undefined
                    ? React.cloneElement(cell.chart as React.ReactElement<{ width?: number }>, { width })
                    : cell.chart
                : React.createElement(Text, { wrap: 'truncate-end', ...cell.style }, ...cell.nodes);
            boxes.push(React.createElement(Box, {
                key: c, width, flexShrink: 0, justifyContent: JUSTIFY[align], marginRight: last ? 0 : spec.gap,
            }, content));
        });
        rows.push(React.createElement(Box, { key: r, flexDirection: 'row' }, ...boxes));
    });
    return React.createElement(Box, { flexDirection: 'column' }, ...rows);
}

// ---------------------------------------------------------------------------
// A row as one line of text. Ink lays out every Box with Yoga, and a Box per
// cell made a table cost as much to paint as it had cost the CPI to build.
// When every cell is text or a Sparkline, the row is padded and aligned here
// and drawn as a single Text. A row holding another chart returns null and is
// laid out with boxes.

function rowAsLine(spec: TableSpec, w: readonly number[], cells: readonly TableCell[], key: number): React.ReactElement | null {
    const pieces: (React.ReactElement | string)[] = [];
    let at = 0;
    for (const cell of cells) {
        const width = w.slice(at, at + cell.span).reduce((a, b) => a + b, 0) + spec.gap * (cell.span - 1);
        const align = cell.align ?? spec.columns[at]!.align;
        at += cell.span;
        const inline = inlineCell(cell, width);
        if (inline === null) return null;
        const pad = Math.max(0, width - inline.width);
        const left = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0;
        if (left > 0) pieces.push(' '.repeat(left));
        pieces.push(inline.node);
        if (at < spec.columns.length) pieces.push(' '.repeat(pad - left + spec.gap));
    }
    return React.createElement(Text, { key, wrap: 'truncate-end' }, ...pieces);
}

function inlineCell(cell: TableCell, width: number): { node: React.ReactElement; width: number } | null {
    if (cell.chart !== null) {
        if (cell.chart.type !== Sparkline) return null;
        const props = cell.chart.props as Parameters<typeof sparklineText>[0] & { color?: string; underline?: boolean };
        const text = sparklineText({ ...props, width: props.width ?? width });
        const style: Record<string, unknown> = {};
        if (props.color !== undefined) style['color'] = props.color;
        if (props.underline !== undefined) style['underline'] = props.underline;
        return { node: React.createElement(Text, style, text), width: stringWidth(text) };
    }
    const textWidth = stringWidth(cell.text);
    if (textWidth <= width) {
        return { node: React.createElement(Text, cell.style, ...cell.nodes), width: textWidth };
    }
    // Too wide: the plain text, cut to fit with an ellipsis, in the cell's style.
    return { node: React.createElement(Text, cell.style, truncate(cell.text, width)), width };
}

function truncate(text: string, width: number): string {
    if (width <= 0) return '';
    let out = '';
    let used = 0;
    for (const ch of text) {
        const cw = stringWidth(ch);
        if (used + cw > width - 1) break;
        out += ch;
        used += cw;
    }
    return out + '…';
}
