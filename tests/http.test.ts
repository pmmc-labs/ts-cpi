// SPEC-HTTP: requests as messages, reply addresses, delivery in host::wait,
// through the headless backend, and once end to end on a real socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ErrorValue, Value } from '../src/types.ts';
import { read } from '../src/reader.ts';
import { expand } from '../src/expander.ts';
import { fromBindings } from '../src/env.ts';
import { listToArray } from '../src/values.ts';
import { print } from '../src/printer.ts';
import { Runtime } from '../src/runtime.ts';
import { HeadlessHttp, type ScriptedRequest } from '../src/http/headless.ts';

function envOf(src: string) {
    const bindings: Array<[string, Value]> = [];
    for (const form of expand(read(src, 'test'), 'file')) {
        const [, name, params, ...body] = listToArray(form)!;
        const n = name as { t: 'sym'; name: string };
        bindings.push([n.name, { t: 'closure', name: n, params: listToArray(params!) as never, body, scope: null, group: null }]);
    }
    return fromBindings(bindings);
}

type Booted = {
    result: { ok: true; v: Value } | { ok: false; e: ErrorValue };
    output: string[];
    http: HeadlessHttp;
    rt: Runtime;
};

async function boot(src: string, script: ScriptedRequest[] = []): Promise<Booted> {
    const output: string[] = [];
    const http = new HeadlessHttp(script);
    const rt = new Runtime({ out: (line) => output.push(line), clock: 'virtual', http: () => http });
    return { result: await rt.boot(envOf(src)), output, http, rt };
}

function value(b: Booted): string {
    return b.result.ok ? print(b.result.v) : `failed: ${print(b.result.e)} ${print(b.result.e.payload)}`;
}

// The fields of a request message after its reply address.
const FIELDS = `
    (defun fields (req)
        (cdr (cdr req)))
`;

// ---------------------------------------------------------------------------
// Requests and responses (sections 2 to 4)
// ---------------------------------------------------------------------------

test('http: a request arrives as a message in host::wait, and a response to its reply address is written', async () => {
    const b = await boot(`
        ${FIELDS}
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (let before (mailbox::size inbox))
            (host::wait #false)
            (let req (mailbox::take inbox))
            (mailbox::send (car (cdr req)) (list 'response 200 (list (list "content-type" "text/plain")) "hi"))
            (list before (car req) (fields req)))
    `, [{ method: 'GET', target: '/users/42?x=1&y=two', headers: [['Accept', 'text/plain']] }]);
    assert.equal(value(b), '(0 request (get ("users" "42") (("x" "1") ("y" "two")) (("accept" "text/plain")) ""))');
    assert.deepEqual(b.http.responses, [{ request: 0, at: 0, status: 200, headers: [['content-type', 'text/plain']], body: 'hi' }]);
});

test('http: the root path is the empty list, and the body is a string', async () => {
    const b = await boot(`
        ${FIELDS}
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (fields (mailbox::take inbox)))
    `, [{ method: 'POST', target: '/', body: '(add 1 2)' }]);
    assert.equal(value(b), '(post () () () "(add 1 2)")');
});

test('http: a worker answers through the reply address with actor::send alone', async () => {
    const b = await boot(`
        (defun worker ()
            (let req (actor::recv))
            (actor::send (car (cdr req)) (list 'response 200 () (string-append "hello " (car (car (cdr (cdr (cdr req)))))))))
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (let w (process::spawn worker () (environment::self) '(actor) inbox))
            (process::run w 50)
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (process::run w 200))
    `, [{ target: '/ada' }]);
    assert.equal(value(b), '(exited #true)');
    assert.deepEqual(b.http.responses, [{ request: 0, at: 0, status: 200, headers: [], body: 'hello ada' }]);
});

test('http: a reply address takes one message; the next is a dead letter', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (let reply (car (cdr (mailbox::take inbox))))
            (mailbox::send reply (list 'response 200 () "first"))
            (mailbox::send reply (list 'response 200 () "second")))
    `, [{ target: '/' }]);
    assert.equal(value(b), '#true');
    assert.equal(b.http.responses.length, 1);
    assert.equal((b.http.responses[0] as { body: string }).body, 'first');
    assert.equal(b.rt.deadLetters.length, 1);
    assert.equal(print(b.rt.deadLetters[0]!.msg), '(response 200 () "second")');
});

test('http: a message that is not a response is answered 500 and kept as a dead letter', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (mailbox::send (car (cdr (mailbox::take inbox))) (list 'response "200" () "oops")))
    `, [{ target: '/' }]);
    assert.equal(value(b), '#true');
    assert.equal((b.http.responses[0] as { status: number }).status, 500);
    assert.equal(b.rt.deadLetters.length, 1);
    assert.equal(print(b.rt.deadLetters[0]!.msg), '(response "200" () "oops")');
});

test('http: a reply address cannot be received on', async () => {
    const b = await boot(`
        (defun taker () (actor::recv))
        (defun tag-of (thunk) (catch (thunk) e (error-tag e)))
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (let reply (car (cdr (mailbox::take inbox))))
            (list
                (tag-of (lambda () (mailbox::size reply)))
                (tag-of (lambda () (mailbox::take reply)))
                (tag-of (lambda () (process::spawn taker () (environment::self) '(actor) reply)))
                (tag-of (lambda () (http::listen 8081 reply 1000)))))
    `, [{ target: '/' }]);
    assert.equal(value(b), '(bad-state bad-state bad-state bad-state)');
});

// ---------------------------------------------------------------------------
// Delivery, backpressure and timeouts (sections 5 and 7)
// ---------------------------------------------------------------------------

test('http: a request to a full mailbox is answered 503 at once and kept as a dead letter', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 1))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (host::wait #false)
            (mailbox::size inbox))
    `, [{ target: '/one' }, { target: '/two' }]);
    assert.equal(value(b), '1');
    // Request 1 is refused at once; request 0 was delivered but never answered,
    // so it is answered 503 when the image exits.
    assert.deepEqual(b.http.responses.map((r) => [r.request, (r as { status: number }).status]), [[1, 503], [0, 503]]);
    assert.equal(b.rt.deadLetters.length, 1);
});

test('http: a request not answered within the timeout is answered 504, and a late reply is a dead letter', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 50)
            (host::wait #false)
            (let reply (car (cdr (mailbox::take inbox))))
            (host::wait 100)
            (mailbox::send reply (list 'response 200 () "late")))
    `, [{ target: '/' }]);
    assert.equal(value(b), '#true');
    assert.deepEqual(b.http.responses.map((r) => (r as { status: number }).status), [504]);
    assert.equal(b.rt.deadLetters.length, 1);
});

test('http: a reply to a client that disconnected is a dead letter', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (mailbox::send (car (cdr (mailbox::take inbox))) (list 'response 200 () "gone")))
    `, [{ target: '/', disconnects: true }]);
    assert.equal(value(b), '#true');
    assert.deepEqual(b.http.responses, [{ request: 0, at: 0, aborted: true }]);
    assert.equal(b.rt.deadLetters.length, 1);
});

test('http: requests still unanswered when the image exits are answered 503', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            :done)
    `, [{ target: '/' }]);
    assert.equal(value(b), 'done');
    assert.deepEqual(b.http.responses.map((r) => (r as { status: number }).status), [503]);
    assert.equal(b.http.listening.size, 0);
});

test('http: requests wake the longest waiting worker on a shared mailbox', async () => {
    const b = await boot(`
        (defun worker (name)
            (let req (actor::recv))
            (actor::send (car (cdr req)) (list 'response 200 () name))
            (worker name))
        (defun main ()
            (let queue (mailbox::create #true 10))
            (let a (process::spawn worker (list "a") (environment::self) '(actor) queue))
            (let b (process::spawn worker (list "b") (environment::self) '(actor) queue))
            (process::run b 50)
            (process::run a 50)
            (http::listen 8080 queue 1000)
            (let woken (host::wait #false))
            (let states (list (process::state a) (process::state b)))
            (process::run b 200)
            (list woken states))
    `, [{ target: '/' }]);
    assert.equal(value(b), '((#<pid 2>) ((blocked recv) (ready)))');
    assert.deepEqual(b.http.responses.map((r) => (r as { body: string }).body), ['b']);
});

test('http: scripted requests due together arrive together; a later one arrives when virtual time reaches it', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (let burst (list (host::now) (mailbox::size inbox)))
            (let early (list (host::wait 100) (host::now) (mailbox::size inbox)))
            (host::wait #false)
            (list burst early (list (host::now) (mailbox::size inbox))))
    `, [{ target: '/a' }, { target: '/b' }, { target: '/c', after: 250 }]);
    assert.equal(value(b), '((0 2) (() 100 2) (250 3))');
});

// ---------------------------------------------------------------------------
// The served log (section 6)
// ---------------------------------------------------------------------------

test('http: the served log reports each answered request with when it arrived, was delivered and was answered', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (let log (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (http::subscribe-log log)
            (host::wait #false)
            (let req (mailbox::take inbox))
            (timer::sleep 30)
            (mailbox::send (car (cdr req)) (list 'response 201 () "made"))
            (let before (mailbox::size log))
            (host::wait 0)
            (list before (mailbox::take log)))
    `, [{ method: 'PUT', target: '/a/b', after: 100 }]);
    assert.equal(value(b), '(0 (served 8080 put ("a" "b") 201 100 100 130))');
});

test('http: the served log reports refusals, timeouts and disconnects', async () => {
    const b = await boot(`
        (defun drain (log)
            (let e (mailbox::take log))
            (if e (cons e (drain log)) ()))
        (defun main ()
            (let inbox (mailbox::create #true 1))
            (let log (mailbox::create #true 10))
            (http::listen 8080 inbox 50)
            (http::subscribe-log log)
            (host::wait #false)
            (mailbox::take inbox)
            (host::wait #false)
            (host::wait 100)
            (drain log))
    `, [{ target: '/slow' }, { target: '/full' }, { target: '/gone', after: 10, disconnects: true }]);
    // /slow is delivered at 0 and times out at 50; /full finds the mailbox
    // full at 0; /gone arrives at 10, is delivered, and its client has left.
    assert.equal(value(b), '((served 8080 get ("full") 503 0 #false 0) (served 8080 get ("gone") disconnected 10 10 10) (served 8080 get ("slow") 504 0 0 50))');
});

test('http: nothing is logged without a subscription, and unsubscribe-log stops it', async () => {
    const b = await boot(`
        (defun answer (inbox)
            (host::wait #false)
            (mailbox::send (car (cdr (mailbox::take inbox))) (list 'response 200 () ""))
            (host::wait 0))
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (let log (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (answer inbox)
            (let unsubscribed (mailbox::size log))
            (http::subscribe-log log)
            (answer inbox)
            (let subscribed (mailbox::size log))
            (http::unsubscribe-log)
            (answer inbox)
            (list unsubscribed subscribed (mailbox::size log)))
    `, [{ target: '/1' }, { target: '/2', after: 10 }, { target: '/3', after: 10 }]);
    assert.equal(value(b), '(0 1 1)');
});

test('http: the served log cannot go to a reply address', async () => {
    const b = await boot(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen 8080 inbox 1000)
            (host::wait #false)
            (catch (http::subscribe-log (car (cdr (mailbox::take inbox)))) e (error-tag e)))
    `, [{ target: '/' }]);
    assert.equal(value(b), 'bad-state');
});

// ---------------------------------------------------------------------------
// The namespace (section 2)
// ---------------------------------------------------------------------------

test('http: listen and close check their arguments and state', async () => {
    const b = await boot(`
        (defun tag-of (thunk) (catch (thunk) e (error-tag e)))
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (list
                (http::listen 8080 inbox 1000)
                (tag-of (lambda () (http::listen 8080 inbox 1000)))
                (tag-of (lambda () (http::listen "8081" inbox 1000)))
                (tag-of (lambda () (http::listen 8081 :inbox 1000)))
                (tag-of (lambda () (http::listen 8081 inbox -1)))
                (http::close 8080)
                (tag-of (lambda () (http::close 8080)))))
    `);
    assert.equal(value(b), '(#true bad-state type-error type-error type-error #true bad-state)');
});

test('http: a process cannot be granted http', async () => {
    const b = await boot(`
        (defun w () ())
        (defun main ()
            (catch (process::spawn w () (environment::self) '(http) #false) e (error-tag e)))
    `);
    assert.equal(value(b), 'not-granted');
});

// ---------------------------------------------------------------------------
// End to end on a real socket
// ---------------------------------------------------------------------------

test('http: the node backend serves a real request on the loopback interface', async () => {
    const port = 38000 + Math.floor(Math.random() * 2000);
    const output: string[] = [];
    const rt = new Runtime({ out: (line) => output.push(line) });
    const booted = rt.boot(envOf(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen ${port} inbox 5000)
            (host::wait #false)
            (let req (mailbox::take inbox))
            (mailbox::send (car (cdr req)) (list 'response 201 (list (list "x-path" (car (car (cdr (cdr (cdr req))))))) "made"))
            (http::close ${port}))
    `));
    let res: Response | null = null;
    for (let i = 0; i < 50 && res === null; i++) {
        await new Promise((r) => setTimeout(r, 10));
        res = await fetch(`http://127.0.0.1:${port}/things?a=1`, { method: 'PUT', body: 'x' }).catch(() => null);
    }
    assert.ok(res !== null, 'the server never answered');
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-path'), 'things');
    assert.equal(await res.text(), 'made');
    const result = await booted;
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
});

test('http: on the real clock, the host answers 504 while the CPI is busy past the timeout', async () => {
    const port = 38000 + Math.floor(Math.random() * 2000);
    const rt = new Runtime({ out: () => {} });
    const booted = rt.boot(envOf(`
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen ${port} inbox 50)
            (host::wait #false)
            (let req (mailbox::take inbox))
            (timer::sleep 300)
            (mailbox::send (car (cdr req)) (list 'response 200 () "late"))
            (http::close ${port}))
    `));
    let res: Response | null = null;
    let waited = 0;
    for (let i = 0; i < 50 && res === null; i++) {
        await new Promise((r) => setTimeout(r, 10));
        const sent = performance.now();
        res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
        waited = performance.now() - sent;
    }
    assert.ok(res !== null, 'the server never answered');
    assert.equal(res.status, 504);
    // Answered by the host's timer at about 50 ms, not when the CPI's 300 ms
    // sleep ends and its late reply finds the deadline passed.
    assert.ok(waited < 250, `answered after ${Math.round(waited)} ms`);
    const result = await booted;
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    assert.equal(rt.deadLetters.length, 1);
    assert.equal(print(rt.deadLetters[0]!.msg), '(response 200 () "late")');
});

test('http: (host::wait 0) takes in requests while the CPI stays busy', async () => {
    const port = 38000 + Math.floor(Math.random() * 2000);
    const rt = new Runtime({ out: () => {} });
    // The CPI never waits for longer than 0 ms: it polls up to 20000 times.
    const booted = rt.boot(envOf(`
        (defun poll (inbox n)
            (host::wait 0)
            (cond
                ((> (mailbox::size inbox) 0) :seen)
                ((= n 0) :never)
                (#true (poll inbox (- n 1)))))
        (defun main ()
            (let inbox (mailbox::create #true 10))
            (http::listen ${port} inbox 5000)
            (let seen (poll inbox 20000))
            (let req (mailbox::take inbox))
            (when req (mailbox::send (car (cdr req)) (list 'response 200 () "ok")))
            seen)
    `));
    const answered = (async () => {
        for (let i = 0; i < 50; i++) {
            await new Promise((r) => setTimeout(r, 5));
            const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
            if (res !== null) return res.status;
        }
        return null;
    })();
    const result = await booted;
    assert.equal(result.ok, true, result.ok ? '' : print(result.e));
    assert.equal(print(result.v), 'seen');
    assert.equal(await answered, 200);
});
