// examples/gateway/gateway.slight, driven through a burst, a quiet period and
// a second visit by the headless HTTP backend on the virtual clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadFiles } from '../src/loader.ts';
import { Runtime } from '../src/runtime.ts';
import { print } from '../src/printer.ts';
import { HeadlessHttp, type ScriptedRequest } from '../src/http/headless.ts';

const gateway = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'gateway', 'gateway.slight');

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
        { target: '/system/quit' },
    ];
    const http = new HeadlessHttp(script);
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual', http: () => http });
    const result = await rt.boot(loadFiles([gateway]));
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));

    assert.deepEqual(output, [
        '[gateway] hello template warmed up in 31 turns',
        '[gateway] listening on port 8080',
        '[gateway] hello +1 from the template: hello 1 cold 0 counters 0 asleep 0',
        '[gateway] hello +1 from the template: hello 2 cold 0 counters 0 asleep 0',
        '[gateway] hello +1 from the template: hello 3 cold 0 counters 0 asleep 0',
        '[gateway] counter ada made',
        '[gateway] counter bob made',
        '[gateway] hello -1 to cold storage: hello 2 cold 1 counters 2 asleep 0',
        '[gateway] hello -1 to cold storage: hello 1 cold 2 counters 2 asleep 0',
        '[gateway] counter ada asleep',
        '[gateway] counter bob asleep',
        '[gateway] counter ada awake',
        '[gateway] stopped: hello 1 cold 2 counters 1 asleep 1',
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
        '200 hello 3 cold 0 counters 0 asleep 0',
        '200 ada 1',
        '200 ada 2',
        '200 bob 1',
        '200 ada bob',
        '200 hello 1 cold 2 counters 0 asleep 2',
        '200 ada 3',
        '404 no such endpoint',
        '200 hello 1 cold 2 counters 1 asleep 1',
        '200 bye',
    ]);
    assert.equal(rt.deadLetters.length, 0);
});
