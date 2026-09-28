// Views as data (SPEC-TUI section 3): SXML-style views, built as slight values, rendered through
// Ink to a string with no terminal (renderToString).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';

import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { loadFiles } from '../src/loader.ts';
import { startExpr, run } from '../src/machine.ts';
import type { State, Value } from '../src/types.ts';
import { toElement, ViewError } from '../src/tui/views.ts';

const view = (source: string): Value => read(source, 'view')[0]!;
const show = (source: string, columns = 30): string => renderToString(toElement(view(source)), { columns });

test('a bordered column of text', () => {
    assert.equal(show(`
        (Box (@ (flexDirection column) (borderStyle single) (width 12))
            (Text "one")
            (Text "two"))`), [
        '┌──────────┐',
        '│one       │',
        '│two       │',
        '└──────────┘',
    ].join('\n'));
});

test('props: symbols become strings, integers become numbers', () => {
    assert.equal(show('(Box (@ (flexDirection row) (gap 3)) (Text "a") (Text "b"))'), 'a   b');
});

test('numbers are text inside Text, and nested Text runs together', () => {
    assert.equal(show('(Text (Text "generation ") 4 " / " 2.5)'), 'generation 4 / 2.5');
});

test('a list of views is spliced in; () and #false render nothing', () => {
    assert.equal(show(`
        (Box (@ (flexDirection column))
            ((Text "a") (Text "b"))
            ()
            #false
            (Text "c"))`), 'a\nb\nc');
});

test('errors name the offending part of the view', () => {
    const fails = (source: string, message: RegExp) =>
        assert.throws(() => toElement(view(source)), (e: unknown) => e instanceof ViewError && message.test(e.message));
    fails('(Marquee "hi")', /unknown component Marquee/);
    fails('(Box "bare text")', /text must be inside a Text: "bare text"/);
    fails('(Box (@ (gap)) (Text "x"))', /a prop must be \(name value\): \(gap\)/);
    fails('(Box (@ (gap (1 2))) (Text "x"))', /a prop value must be/);
    fails('"just a string"', /text must be inside a Text/);
    fails('(1 2 3)', /expected \(Tag/);
    fails('(Box (Newline))', /Newline must be inside a Text/);
    fails('(Box (@ (colour red)))', /Box has no prop colour/);
});

test('a view built by CPI code renders', () => {
    const [x] = expand(read('(lv-view 0 (seed-board))', 'test'), 'expr');
    let s: State = startExpr(x!, loadFiles([
        'examples/life/lib/lists.slight',
        'examples/life/lib/life.slight',
        'spike/tui/life-view.slight',
    ]));
    while (s.mode.m === 'eval' || s.mode.m === 'ret' || s.mode.m === 'throw') s = run(s, 1_000_000);
    assert.equal(s.mode.m, 'done');
    assert.equal(renderToString(toElement((s.mode as { v: Value }).v), { columns: 50 }), [
        '╭──────────────────╮',
        '│ ··██············ │  Game of Life',
        '│ ····██·········· │  generation 0',
        '│ ██████·········· │  live cells 8',
        '│ ················ │',
        '│ ················ │',
        '│ ················ │',
        '│ ········██████·· │',
        '│ ················ │',
        '╰──────────────────╯',
    ].join('\n'));
});

// ---------------------------------------------------------------------------
// Charts (SPEC-TUI sections 3.2 and 3.3)
// ---------------------------------------------------------------------------

test('Sparkline: zero is blank, a fixed max, right-aligned in its width', () => {
    // 1 of 8 is one step, 4 of 8 half height, 8 full.
    assert.equal(show('(Sparkline (@ (data (0 1 4 8)) (width 6) (max 8)))'), '   ▁▄█');
});

test('Sparkline: scales to the largest value by default, and drops the oldest values that do not fit', () => {
    assert.equal(show('(Sparkline (@ (data (1 2 3 4)) (width 2)))'), '▆█');
});

test('Sparkline: braille puts two values in a column, the newest at the right', () => {
    // (4 4) fills both columns of the first cell; (2 0) half the left one.
    assert.equal(show('(Sparkline (@ (data (4 4 2 0)) (max 4) (mode braille)))'), '⣿⡄');
});

test('BarChart: one row per labelled value, with a suffix', () => {
    const out = show('(BarChart (@ (data (("fast" 2) ("slow" 8 red))) (width 24) (suffix " ms")))', 40).split('\n');
    assert.equal(out.length, 2);
    assert.ok(out[0]!.startsWith('fast') && out[0]!.endsWith('2 ms'), out[0]);
    assert.ok(out[1]!.startsWith('slow') && out[1]!.endsWith('8 ms'), out[1]);
});

test('StackedBarChart: segments with their labels', () => {
    const out = show('(StackedBarChart (@ (data (("run" 1 blue) ("wait" 3 gray))) (width 20) (showValues #false)))', 40);
    assert.ok(out.includes('run') && out.includes('wait'), out);
});

test('LineGraph: series drawn over several rows', () => {
    const out = show('(LineGraph (@ (data ((1 2 3 4) (4 3 2 1))) (colors (cyan magenta)) (width 20) (height 3)))', 40);
    assert.equal(out.split('\n').length, 3, out);
});

test('chart errors name the offending part', () => {
    const fails = (source: string, message: RegExp) =>
        assert.throws(() => toElement(view(source)), (e: unknown) => e instanceof ViewError && message.test(e.message));
    fails('(Sparkline (@ (width 4)))', /Sparkline requires data/);
    fails('(Sparkline (@ (data (1 "two" 3))))', /Sparkline data must be numbers: "two"/);
    fails('(Sparkline (@ (data 3)))', /Sparkline data must be a list/);
    fails('(Sparkline (@ (data (1)) (color mauve)))', /Sparkline color must be a color: mauve/);
    fails('(Sparkline (@ (data (1)) (mode dots)))', /Sparkline mode must be one of block, braille/);
    fails('(BarChart (@ (data ((1 2)))))', /BarChart data must be \(label value\) or \(label value color\): \(1 2\)/);
    fails('(LineGraph (@ (data ((1 2) 3))))', /LineGraph data must be lists of numbers: 3/);
    fails('(Text (Sparkline (@ (data (1)))))', /Sparkline cannot be inside a Text/);
    fails('(Sparkline (@ (data (1))) (Text "x"))', /Sparkline takes no children/);
});

// ---------------------------------------------------------------------------
// Tables (SPEC-TUI section 16)
// ---------------------------------------------------------------------------

const showLines = (source: string, columns = 40): string[] => show(source, columns).split('\n').map((l) => l.trimEnd());

test('Table: fixed and auto widths, right alignment, truncation, a dimmed header', () => {
    assert.deepEqual(showLines(`
        (Table (@ (columns (("name" 6) ("n" 4 right) ("note" auto))))
            (Row "ab" 1 "x")
            (Row "abcdefgh" 123 "longer"))`), [
        'name      n note',
        'ab        1 x',
        'abcde…  123 longer',
    ]);
});

test('Table: a Cell spans columns and sets its own alignment; no header', () => {
    assert.deepEqual(showLines(`
        (Table (@ (header #false) (columns (("a" 3) ("b" 3) ("c" 3))))
            (Row (Cell (@ (span 2) (align right)) "xy") "z")
            (Row "1" "2" "3"))`), [
        '     xy z',
        '1   2   3',
    ]);
});

test('Table: a chart in a cell gets the column width; Text elements and lists of pieces are cells', () => {
    assert.deepEqual(showLines(`
        (Table (@ (columns (("s" 4) ("t" 5 right) ("u" 6))))
            (Row (Sparkline (@ (data (1 2)))) (Text (@ (color green)) "ok") ("a" (Text "b") 3)))`), [
        's        t u',
        '  ▄█    ok ab3',
    ]);
});

test('Table: rows may be spliced in as a list; a short row leaves the rest empty', () => {
    assert.deepEqual(showLines(`
        (Table (@ (header #false) (gap 2) (columns (("a" 2) ("b" 2))))
            ((Row "1" "2") (Row "3"))
            ()
            (Row "5" "6"))`), [
        '1   2',
        '3',
        '5   6',
    ]);
});

test('Table: a row holding a box-drawn chart is laid out with boxes, beside rows drawn as lines', () => {
    const lines = showLines(`
        (Table (@ (header #false) (columns (("a" 3) ("b" 20))))
            (Row "x" (BarChart (@ (data (("k" 4))) (width 12))))
            (Row "y" "text"))`);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.ok(lines[0]!.startsWith('x   k') && lines[0]!.endsWith('4'), lines[0]);
    assert.equal(lines[1], 'y   text');
});

test('table errors name the offending part', () => {
    const fails = (source: string, message: RegExp) =>
        assert.throws(() => toElement(view(source)), (e: unknown) => e instanceof ViewError && message.test(e.message));
    fails('(Box (Row "x"))', /Row must be inside a Table/);
    fails('(Row "x")', /Row must be inside a Table/);
    fails('(Box (Cell "x"))', /Cell must be inside a Row/);
    fails('(Table (Row "x"))', /Table requires columns/);
    fails('(Table (@ (columns (("a" 3)))) (Text "x"))', /a Table holds only Row elements: \(Text "x"\)/);
    fails('(Table (@ (columns (("a" 3)))) (Row "x" "y"))', /the row has more cells than the table has columns/);
    fails('(Table (@ (columns (("a" 3) ("b" 3)))) (Row "x" (Cell (@ (span 2)) "y")))', /the row has more cells than the table has columns/);
    fails('(Table (@ (columns (("a" wide)))))', /Table columns must be \(title width\) or \(title width align\)/);
    fails('(Table (@ (columns (("a" 3 middle)))))', /Table columns must be/);
    fails('(Table (@ (columns (("a" 3)))) (Row (Cell (@ (span 0)) "x")))', /Cell span must be at least 1/);
});
