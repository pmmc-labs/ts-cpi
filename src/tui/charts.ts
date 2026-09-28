// Chart components for views (SPEC-TUI sections 3.2 and 3.3). The CPI passes
// numbers; the host draws them. Sparkline is drawn here, because the spec
// needs a fixed scale, right alignment and underline; the other three adapt
// the spec's props to @pppp606/ink-chart.

import React from 'react';
import { Text } from 'ink';
import { BarChart, LineGraph, StackedBarChart } from '@pppp606/ink-chart';

export type Row = { readonly label: string; readonly value: number; readonly color?: string };

// Values shown with a suffix: integers as they are, others to a tenth.
function formatter(suffix: string | undefined): ((v: number) => string) | undefined {
    if (suffix === undefined) return undefined;
    return (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Sparkline

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
// Braille dots from the bottom up, left column then right column.
const LEFT_DOTS = [0x40, 0x04, 0x02, 0x01];
const RIGHT_DOTS = [0x80, 0x20, 0x10, 0x08];

type SparklineProps = {
    readonly data: readonly number[];
    readonly width?: number;
    readonly min?: number;
    readonly max?: number;
    readonly color?: string;
    readonly underline?: boolean;
    readonly mode?: 'block' | 'braille';
};

// How many of `levels` steps `v` fills between `min` (empty) and `top`
// (full). Anything above `min` shows at least one step.
function level(v: number, min: number, top: number, levels: number): number {
    if (v <= min) return 0;
    const f = (v - min) / Math.max(top - min, Number.EPSILON);
    return Math.min(levels, Math.max(1, Math.ceil(f * levels)));
}

export function sparklineText(props: SparklineProps): string {
    const min = props.min ?? 0;
    const perColumn = props.mode === 'braille' ? 2 : 1;
    const columns = props.width ?? Math.ceil(props.data.length / perColumn);
    const values = props.data.slice(Math.max(0, props.data.length - columns * perColumn));
    const top = props.max ?? Math.max(min + 1, ...values);
    let text: string;
    if (perColumn === 1) {
        text = values.map((v) => BLOCKS[level(v, min, top, 8)]).join('');
    } else {
        const chars: string[] = [];
        // Pair values from the right, so the newest sits at the right edge.
        for (let end = values.length; end > 0; end -= 2) {
            const right = level(values[end - 1]!, min, top, 4);
            const left = end >= 2 ? level(values[end - 2]!, min, top, 4) : 0;
            let bits = 0;
            for (let i = 0; i < left; i++) bits |= LEFT_DOTS[i]!;
            for (let i = 0; i < right; i++) bits |= RIGHT_DOTS[i]!;
            chars.unshift(bits === 0 ? ' ' : String.fromCodePoint(0x2800 + bits));
        }
        text = chars.join('');
    }
    return ' '.repeat(Math.max(0, columns - text.length)) + text;
}

export function Sparkline(props: SparklineProps): React.ReactElement {
    const style: { color?: string; underline?: boolean } = {};
    if (props.color !== undefined) style.color = props.color;
    if (props.underline !== undefined) style.underline = props.underline;
    return React.createElement(Text, style, sparklineText(props));
}

// ---------------------------------------------------------------------------
// The library's charts, with the spec's props

type BarChartProps = {
    readonly data: readonly Row[];
    readonly width?: number;
    readonly max?: number;
    readonly showValue?: 'right' | 'inside' | 'none';
    readonly suffix?: string;
    readonly sort?: 'none' | 'asc' | 'desc';
    readonly color?: string;
    readonly barChar?: string;
};

export function BarChartView(props: BarChartProps): React.ReactElement {
    return React.createElement(BarChart as React.ElementType, {
        data: props.data.map((r) => ({ ...r })),
        width: props.width,
        max: props.max,
        // The spec's default; the library's is `none`.
        showValue: props.showValue ?? 'right',
        format: formatter(props.suffix),
        sort: props.sort,
        color: props.color,
        barChar: props.barChar,
    });
}

type StackedBarChartProps = {
    readonly data: readonly Row[];
    readonly mode?: 'percentage' | 'absolute';
    readonly max?: number;
    readonly width?: number;
    readonly showLabels?: boolean;
    readonly showValues?: boolean;
    readonly suffix?: string;
};

export function StackedBarChartView(props: StackedBarChartProps): React.ReactElement {
    return React.createElement(StackedBarChart as React.ElementType, {
        data: props.data.map((r) => ({ ...r })),
        mode: props.mode,
        max: props.max,
        width: props.width,
        showLabels: props.showLabels,
        showValues: props.showValues,
        format: formatter(props.suffix),
    });
}

type LineGraphProps = {
    readonly data: readonly (readonly number[])[];
    readonly colors?: readonly string[];
    readonly width?: number;
    readonly height?: number;
    readonly min?: number;
    readonly max?: number;
    readonly showYAxis?: boolean;
    readonly xLabels?: readonly string[];
    readonly caption?: string;
};

export function LineGraphView(props: LineGraphProps): React.ReactElement {
    const all = props.data.flat();
    const yDomain = props.min === undefined && props.max === undefined
        ? undefined
        : [props.min ?? Math.min(...all), props.max ?? Math.max(...all)];
    return React.createElement(LineGraph as React.ElementType, {
        data: props.data.map((values, i) => ({ values: [...values], color: props.colors?.[i] })),
        width: props.width,
        height: props.height,
        yDomain,
        showYAxis: props.showYAxis,
        xLabels: props.xLabels === undefined ? undefined : [...props.xLabels],
        caption: props.caption,
    });
}
