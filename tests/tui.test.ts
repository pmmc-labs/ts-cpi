// SPEC-TUI: the real clock, host::wait, and the tui:: namespace (through the
// headless backend, and the terminal backend on a fake terminal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import type { Key } from 'ink';

import type { ErrorValue, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { fromBindings } from '../src/env.ts';
import { listToArray, sym } from '../src/values.ts';
import { print } from '../src/printer.ts';
import { Runtime } from '../src/runtime.ts';
import { HeadlessTui } from '../src/tui/headless.ts';
import { TerminalTui } from '../src/tui/terminal.ts';
import { keyEvent } from '../src/tui/events.ts';

function envOf(src: string) {
    const bindings: Array<[string, Value]> = [];
    for (const form of expand(read(src, 'test'), 'file')) {
        const [, name, params, ...body] = listToArray(form)!;
        const n = name as { t: 'sym'; name: string };
        bindings.push([n.name, { t: 'closure', name: n, params: listToArray(params!) as never, body, scope: null, group: null }]);
    }
    return fromBindings(bindings);
}

type Booted = { result: { ok: true; v: Value } | { ok: false; e: ErrorValue }; output: string[]; tui: HeadlessTui };

async function boot(src: string, opts: { clock?: 'real' | 'virtual'; input?: string[] } = {}): Promise<Booted> {
    const output: string[] = [];
    const tui = new HeadlessTui({ columns: 30, rows: 10, input: (opts.input ?? []).map((s) => read(s, 'input')[0]!) });
    const rt = new Runtime({ out: (line) => output.push(line), clock: opts.clock ?? 'virtual', tui: () => tui });
    return { result: await rt.boot(envOf(src)), output, tui };
}

async function value(src: string, opts: { clock?: 'real' | 'virtual'; input?: string[] } = {}): Promise<string> {
    const { result } = await boot(src, opts);
    return result.ok ? print(result.v) : `failed: ${print(result.e)} ${print(result.e.payload)}`;
}

// ---------------------------------------------------------------------------
// The real clock (SPEC-TUI sections 8 and 9)
// ---------------------------------------------------------------------------

test('real clock: host::now counts milliseconds from the start of the image', async () => {
    const v = await value(`
        (defun main ()
            (let t0 (host::now))
            (timer::sleep 25)
            (cons t0 (host::now)))`, { clock: 'real' });
    const [t0, t1] = v.slice(1, -1).split(' . ').map(Number);
    assert.ok(t0! >= 0 && t0! < 1000, `t0 = ${t0}`);
    assert.ok(t1! - t0! >= 25, `slept ${t1! - t0!} ms`);
});

test('real clock: host::wait returns a sleeper once its deadline has really passed', async () => {
    const v = await value(`
        (defun napper () (timer::sleep 30))
        (defun main ()
            (let p (process::spawn napper () (environment::self) '(timer) #false))
            (let t0 (host::now))
            (process::run p 100)
            (let woken (host::wait #false))
            \`(,(eq? (car woken) p) ,(>= (- (host::now) t0) 30) ,(process::state p)))`, { clock: 'real' });
    assert.equal(v, '(#true #true (ready))');
});

test('real clock: a timeout passes in real time; with nothing pending and no timeout, () at once', async () => {
    const v = await value(`
        (defun main ()
            (let t0 (host::now))
            (let a (host::wait 20))
            (let t1 (host::now))
            (let b (host::wait #false))
            \`(,a ,(>= (- t1 t0) 20) (,b ,(< (- (host::now) t1) 20))))`, { clock: 'real' });
    assert.equal(v, '(() #true (() #true))');
});

// ---------------------------------------------------------------------------
// tui:: with the headless backend
// ---------------------------------------------------------------------------

test('open, render, size and close: each view is drawn before render returns', async () => {
    const { result, tui } = await boot(`
        (defun main ()
            (tui::open 'inline)
            (tui::render '(Box (@ (borderStyle single) (width 12)) (Text "one")))
            (tui::render \`(Text "size " ,(car (tui::size)) " by " ,(car (cdr (tui::size)))))
            (tui::close))`);
    assert.ok(result.ok);
    assert.deepEqual(tui.frames, ['┌──────────┐\n│one       │\n└──────────┘', 'size 30 by 10']);
    assert.equal(tui.mode, 'inline');
    assert.ok(tui.closed);
});

test('a malformed view is a type-error naming the bad part, and nothing is drawn', async () => {
    const { result, tui } = await boot(`
        (defun main ()
            (tui::open 'inline)
            (catch (tui::render '(Box (Marquee "hi"))) e \`(,(error-tag e) ,(error-payload e) drawn)))`);
    assert.ok(result.ok);
    assert.equal(print(result.v), '(type-error (Marquee "hi") drawn)');
    assert.deepEqual(tui.frames, []);
});

test('props are checked against the table: a typo is a type-error', async () => {
    const v = await value(`
        (defun main ()
            (tui::open 'inline)
            (catch (tui::render '(Box (@ (borderstyle round)) (Text "x"))) e (error-message e)))`);
    assert.match(v, /Box has no prop borderstyle/);
});

test('bad-state: render before open, open twice, close when closed', async () => {
    assert.match(await value(`(defun main () (tui::render '(Text "x")))`), /failed: #<error bad-state "the TUI is not open">/);
    assert.match(await value(`(defun main () (tui::open 'inline) (tui::open 'inline))`), /already open/);
    assert.match(await value(`(defun main () (tui::close))`), /not open/);
    assert.match(await value(`(defun main () (tui::open 'sideways))`), /type-error/);
});

test('tui:: is the CPI\'s alone: a process may not be granted it', async () => {
    const v = await value(`
        (defun worker () 1)
        (defun main ()
            (catch (process::spawn worker () (environment::self) '(tui) #false)
                e (error-tag e)))`);
    assert.equal(v, 'not-granted');
});

test('input: events arrive in the subscribed mailbox only across host::wait, in order', async () => {
    const v = await value(`
        (defun main ()
            (tui::open 'inline)
            (let inbox (mailbox::create #true 10))
            (tui::subscribe inbox)
            (let before (mailbox::size inbox))
            (host::wait #false)
            (let first (mailbox::take inbox))
            (host::wait #false)
            (host::wait #false)
            (let later (cons (mailbox::take inbox) (cons (mailbox::take inbox) ())))
            (host::wait #false)
            \`(,before ,first (,later ,(mailbox::size inbox))))`,
        { input: ['(key "q" ())', '(key up ())', '(resize 100 40)'] });
    assert.equal(v, '(0 (key "q" ()) (((key up ()) (resize 100 40)) 0))');
});

test('input: after unsubscribe, nothing more is delivered', async () => {
    const v = await value(`
        (defun main ()
            (tui::open 'inline)
            (let inbox (mailbox::create #true 10))
            (tui::subscribe inbox)
            (tui::unsubscribe)
            (host::wait #false)
            (mailbox::size inbox))`, { input: ['(key "q" ())'] });
    assert.equal(v, '0');
});

test('IO::print: inline mode shows lines above the view; fullscreen holds them until close', async () => {
    const inline = await boot(`
        (defun main () (tui::open 'inline) (IO::print "hello" 1) (tui::close) (IO::print "after"))`);
    assert.deepEqual(inline.tui.lines, ['hello 1']);
    assert.deepEqual(inline.output, ['after']);

    const full = await boot(`
        (defun main () (tui::open 'fullscreen) (IO::print "held") (tui::render '(Text "x")) (tui::close))`);
    assert.deepEqual(full.tui.lines, []);
    assert.deepEqual(full.output, ['held']);
});

test('the TUI is closed before boot returns: when main fails, and when main forgets to', async () => {
    const failed = await boot(`(defun main () (tui::open 'fullscreen) (IO::print "held") (throw (make-error :oops "x" ())))`);
    assert.ok(!failed.result.ok);
    assert.ok(failed.tui.closed);
    assert.deepEqual(failed.output, ['held']);

    const forgot = await boot(`(defun main () (tui::open 'inline) 42)`);
    assert.ok(forgot.result.ok && forgot.tui.closed);
});

// ---------------------------------------------------------------------------
// Events and the terminal backend
// ---------------------------------------------------------------------------

const noKey: Key = {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
    home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
};

test('key events: printable keys are strings, special keys are symbols, modifiers are listed', () => {
    const show = (v: Value | null) => (v === null ? 'null' : print(v));
    assert.equal(show(keyEvent('q', noKey)), '(key "q" ())');
    assert.equal(show(keyEvent('', { ...noKey, upArrow: true })), '(key up ())');
    assert.equal(show(keyEvent('c', { ...noKey, ctrl: true })), '(key "c" (ctrl))');
    assert.equal(show(keyEvent('', { ...noKey, return: true, shift: true, meta: true })), '(key return (shift meta))');
    assert.equal(show(keyEvent('q', { ...noKey, eventType: 'release' })), 'null');
    assert.equal(show(keyEvent('', noKey)), 'null');
    assert.equal(sym('up'), sym('up'));
});

test('terminal backend: a render is written to the terminal before it returns', async () => {
    const writes: string[] = [];
    const stdout = new Writable({ write(chunk, _enc, done) { writes.push(String(chunk)); done(); } }) as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 40, rows: 10 });
    const stdin = process.stdin;
    const tui = new TerminalTui({ stdout, stdin: Object.assign(Object.create(stdin), { isTTY: false }) });
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual', tui: () => tui });
    let seen = -1;
    const result = await rt.boot(envOf(`
        (defun main ()
            (tui::open 'inline)
            (tui::render '(Text "frame one"))
            (tui::render '(Text "frame two"))
            (tui::render '(Text "frame three")))`));
    seen = writes.filter((w) => w.includes('frame three')).length;
    assert.ok(result.ok);
    assert.ok(seen >= 1, 'the last frame was written');
    assert.ok(writes.some((w) => w.includes('frame two')), 'every render was flushed, none coalesced away');
});
