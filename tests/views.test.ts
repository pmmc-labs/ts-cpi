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
