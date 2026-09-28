// examples/gateway/gateway.slight, driven through a burst, a quiet period and
// a second visit by the headless HTTP backend on the virtual clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readFileSync } from 'node:fs';

import { loadFiles, loadSource } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';
import { read } from '../src/reader.ts';
import { HeadlessHttp, type ScriptedRequest } from '../src/http/headless.ts';
import { HeadlessTui } from '../src/tui/headless.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'gateway');
const gateway = path.join(dir, 'gateway.slight');
const plain = path.join(dir, 'plain.slight');
const monitor = path.join(dir, 'monitor.slight');
const reference = path.join(dir, '..', '..', 'tests', 'programs', 'plan-run-reference.slight');

test('gateway: scales hello workers, makes counters on first use, parks the idle and wakes them', async () => {
    const script: ScriptedRequest[] = [
        // A burst of six at 100 ms.
        { target: '/hello/ada', after: 100 },
        { target: '/hello/bob' },
        { target: '/hello/cy' },
        { target: '/hello/di' },
        { target: '/hello/ed' },
        { target: '/hello/flo' },
        { target: '/system/stats', after: 50 },
        { target: '/counter/ada' },
        { target: '/counter/ada' },
        { target: '/counter/bob' },
        { target: '/counter', after: 50 },
        // Five quiet seconds, then a second visit.
        { target: '/system/stats', after: 5000 },
        { target: '/counter/ada' },
        { target: '/nope' },
        { target: '/system/stats', after: 50 },
        { target: '/system/metrics', after: 1000 },
        { target: '/system/quit' },
    ];
    const http = new HeadlessHttp(script);
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual', http: () => http });
    const result = await rt.boot(loadFiles([gateway, plain]));
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));

    assert.deepEqual(output, [
        '[gateway] hello template warmed up in 31 turns',
        '[gateway] listening on port 8080',
        '[gateway] hello +1 from the template: hello 1 cold 0 counters 0 asleep 0',
        // The CPI adds a worker only when it is woken while requests wait,
        // and nothing wakes it during the burst: the one worker drains it.
        '[gateway] counter ada made',
        '[gateway] counter bob made',
        '[gateway] counter ada asleep',
        '[gateway] counter bob asleep',
        '[gateway] counter ada awake',
        '[gateway] stopped: hello 1 cold 0 counters 1 asleep 1',
    ]);

    // Each request's answer, in request order.
    const answers = [...http.responses]
        .sort((a, b) => a.request - b.request)
        .map((r) => ('aborted' in r ? 'aborted' : `${r.status} ${r.body}`));
    assert.deepEqual(answers, [
        '200 hello, ada',
        '200 hello, bob',
        '200 hello, cy',
        '200 hello, di',
        '200 hello, ed',
        '200 hello, flo',
        '200 hello 1 cold 0 counters 0 asleep 0',
        '200 ada 1',
        '200 ada 2',
        '200 bob 1',
        '200 ada bob',
        '200 hello 1 cold 0 counters 0 asleep 2',
        '200 ada 3',
        '404 no such endpoint',
        '200 hello 1 cold 0 counters 1 asleep 1',
        [
            '200 requests 15 2xx 14 4xx 1 503 0 504 0 5xx 0 gone 0',
            'hello total 6 last-second 0 wait-p95 - work-p95 - total-p95 - ticks 0',
            'counter total 5 last-second 1 wait-p95 <1ms work-p95 <1ms total-p95 <1ms ticks 229',
            'slow total 0 last-second 0 wait-p95 - work-p95 - total-p95 - ticks 0',
            // The monitor counts ticks in the second their batch ran.
            'router total 0 last-second 0 wait-p95 - work-p95 - total-p95 - ticks 736',
            'system total 3 last-second 2 wait-p95 <1ms work-p95 <1ms total-p95 <1ms ticks 0',
            'other total 1 last-second 1 wait-p95 <1ms work-p95 <1ms total-p95 <1ms ticks 0',
            'total total 15 last-second 4 wait-p95 <1ms work-p95 <1ms total-p95 <1ms ticks 965',
        ].join('\n'),
        '200 bye',
    ]);
    assert.equal(rt.deadLetters.length, 0);
});

test('gateway monitor: draws each endpoint and the whole gateway, the last second and since the start, and takes keys', async () => {
    const script: ScriptedRequest[] = [
        { target: '/hello/ada', after: 1100 },
        { target: '/hello/bob' },
        { target: '/hello/cy' },
        { target: '/hello/di' },
        { target: '/hello/ed' },
        { target: '/hello/flo' },
        { target: '/counter/ada' },
        { target: '/counter/bob' },
        { target: '/hello/x', after: 1000 },
        { target: '/system/quit', after: 1500 },
    ];
    const http = new HeadlessHttp(script);
    // The + key arrives at the first host::wait, before any request.
    const tui = new HeadlessTui({ columns: 120, rows: 30, input: [read('(key "+" ())', 'key')[0]!] });
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual', http: () => http, tui: () => tui });
    const result = await rt.boot(loadFiles([gateway, monitor]));
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));

    // A frame only when there is something new: one at the start, one for
    // each of the monitor's summaries at seconds 1, 2 and 3, and one for each
    // event (the + key, two counters made, the last before quitting).
    assert.equal(tui.frames.length, 8);
    const last = tui.frames[tui.frames.length - 1]!.split('\n').map((l) => l.trimEnd());
    const has = (text: string) => assert.ok(last.some((l) => l.includes(text)), `no line with ${JSON.stringify(text)} in\n${last.join('\n')}`);
    has('gateway :8080 · up 0:03 · hello max  5');
    has('requests       9 · 2xx       9 · 4xx     0 · 503     0 · 504     0 · 5xx     0 · gone     0');
    // One mark per hello worker: one idle, two parked; counters as counts.
    // The host draws the sparklines: 1 of 6 requests fills 2 of 8 steps.
    has(' hello     ○◌ 1/5                     0      1      <1ms      <1ms       307                   █▂                   ▁▁');
    has(' counter   ● 0  ○ 0  ◌ 2              0      0         -         -         0                   █                    ▁');
    has(' total     ● 0  ○ 4  ◌ 3              0      1      <1ms      <1ms       427                   █▁                   ▁▁');
    // Since the start: 7 hello requests over 3 seconds, 6 in the busiest.
    // The monitor samples queues after every round.
    has(' hello              7     0     0.5      3     0     2.3      6     0     0.0      0     0     0.0      0');
    has(' total              9     0     1.4      6     0     3.0      8     0     0.0      0     0     0.0      0');
    assert.ok(!last.some((l) => l.includes('asleep')), 'events are not shown');

    // Events go to the dead-letter queue, the key's among them, and only
    // the final line is printed.
    const events = rt.deadLetters.map((d) => print(d.msg));
    assert.equal(events.length, 10);
    assert.ok(events.some((e) => e.includes('"hello max 5"')), events.join('\n'));
    assert.deepEqual(output, ['[gateway] stopped: hello 1 cold 1 counters 0 asleep 2']);
});

// DESIGN-PLAN.md, rule 1: each host node is indistinguishable from its
// reference program. A scenario runs twice, once with the host's node and
// once with the reference in its place, and every line printed, every
// response with the time it was written, the metrics and the dead letters
// must match.

const hibernateReference = path.join(dir, '..', '..', 'tests', 'programs', 'gateway-hibernate-reference.slight');

const traceScript: ScriptedRequest[] = [
    { target: '/hello/ada', after: 100 },
    { target: '/hello/bob' },
    { target: '/hello/cy' },
    { target: '/counter/ada', after: 20 },
    { target: '/counter/bob' },
    { target: '/slow', after: 30 },
    { target: '/hello/di' },
    // Alone, and off the loop's 500 ms timeouts: only mail for the counter,
    // asleep by now, wakes it in time.
    { target: '/counter/ada', after: 3100 },
    { target: '/system/stats', after: 700 },
    { target: '/nope' },
    { target: '/system/metrics', after: 1000 },
    { target: '/system/quit' },
];

// The source without the top-level (defun name ...) forms for `names`, each
// of which must be there exactly once.
function withoutDefuns(source: string, names: readonly string[]): string {
    let out = source;
    for (const name of names) {
        const head = `\n(defun ${name} `;
        const start = out.indexOf(head);
        assert.ok(start >= 0 && out.indexOf(head, start + 1) < 0, `one (defun ${name} ...) in the gateway`);
        let depth = 0;
        let i = start + 1;
        for (; i < out.length; i += 1) {
            const ch = out[i];
            if (ch === ';') { while (i < out.length && out[i] !== '\n') i += 1; continue; }
            if (ch === '"') { i += 1; while (out[i] !== '"') i += out[i] === '\\' ? 2 : 1; continue; }
            if (ch === '(') depth += 1;
            if (ch === ')') { depth -= 1; if (depth === 0) break; }
        }
        out = out.slice(0, start) + out.slice(i + 1);
    }
    return out;
}

// Runs the gateway under `traceScript`: with plan::run or its reference
// program, with the hibernate node or the CPI code it replaces, and with or
// without the monitor node.
async function traceGateway(opts: { planReference: boolean; hibernateReference: boolean; monitor?: boolean }) {
    const http = new HeadlessHttp(traceScript);
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual', http: () => http });
    let source = readFileSync(gateway, 'utf-8');
    let env = loadSource(readFileSync(reference, 'utf-8'), reference);
    if (opts.planReference) {
        assert.equal(source.split('(plan::run ').length, 2, 'the gateway calls plan::run once');
        source = source.replace('(plan::run ', '(plan-run-reference ');
    }
    if (opts.hibernateReference) {
        source = withoutDefuns(source, ['gateway-plan', 'on-mail', 'sleep-idle']);
        env = loadSource(readFileSync(hibernateReference, 'utf-8'), hibernateReference, env);
    }
    if (opts.monitor === false) {
        // An inbox node naming no mailbox: the plan without the monitor.
        source = withoutDefuns(source, ['monitor-node']);
        env = loadSource("(defun monitor-node (w envs) (list 'inbox))", 'test', env);
    }
    env = loadSource(source, gateway, env);
    env = loadSource(readFileSync(plain, 'utf-8'), plain, env);
    const result = await rt.boot(env);
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    const answers = [...http.responses]
        .sort((a, b) => a.request - b.request)
        .map((r) => `at ${r.at}: ${'aborted' in r ? 'aborted' : `${r.status} ${r.body}`}`);
    return { output, answers, deadLetters: rt.deadLetters.map((d) => print(d.msg)) };
}

test('plan::run: the gateway runs exactly as it does under the reference program', async () => {
    // The reference program knows rounds and inboxes, so both runs use the
    // gateway's CPI code for sleeping counters, and neither has the monitor
    // node, which tests/monitor.test.ts checks against its own reference.
    const builtin = await traceGateway({ planReference: false, hibernateReference: true, monitor: false });
    const byReference = await traceGateway({ planReference: true, hibernateReference: true, monitor: false });
    assert.deepEqual(builtin, byReference);
    assert.ok(builtin.output.some((l) => l.includes('counter ada asleep')), builtin.output.join('\n'));
    assert.ok(builtin.answers.some((a) => a.endsWith('200 slow, done')), builtin.answers.join('\n'));
    assert.ok(builtin.answers.includes('at 3250: 200 ada 2'), builtin.answers.join('\n'));
});

test('hibernate: the gateway runs exactly as it does with counters put to sleep by CPI code', async () => {
    const node = await traceGateway({ planReference: false, hibernateReference: false });
    const byReference = await traceGateway({ planReference: false, hibernateReference: true });
    assert.deepEqual(node, byReference);
    assert.ok(node.output.includes('[gateway] counter ada asleep'), node.output.join('\n'));
    assert.ok(node.output.includes('[gateway] counter ada awake'), node.output.join('\n'));
    assert.ok(node.answers.includes('at 3250: 200 ada 2'), node.answers.join('\n'));
});
