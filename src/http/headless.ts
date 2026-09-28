// An HTTP backend for tests (SPEC-HTTP section 7): requests come from a
// script on the virtual clock, and every response is recorded. Selected only
// through the Runtime constructor.
//
// Each scripted request arrives `after` milliseconds after the one before it
// (0 by default), and the first `after` milliseconds after the image started.
// Requests due at the same moment arrive together, as a burst; host::wait
// moves the virtual clock to the next arrival, as it does to a sleeper's
// deadline.

import { parseTarget, type HttpBackend, type HttpExchange, type HttpRequest, type HttpResponse } from './backend.ts';

export type ScriptedRequest = {
    readonly method?: string;
    // A request target: path and query, e.g. `/users/42?x=1`.
    readonly target: string;
    readonly headers?: readonly (readonly [string, string])[];
    readonly body?: string;
    // Defaults to the first port listened on.
    readonly port?: number;
    // The client disconnects as soon as its request is handed over.
    readonly disconnects?: boolean;
    // Milliseconds after the previous request (or the start of the image).
    readonly after?: number;
};

// What happened to scripted request number `request` (0-based): the response
// written, or `aborted` for a client that disconnected first.
export type Recorded =
    | { readonly request: number; readonly status: number; readonly headers: readonly (readonly [string, string])[]; readonly body: string }
    | { readonly request: number; readonly aborted: true };

export class HeadlessHttp implements HttpBackend {
    readonly responses: Recorded[] = [];
    readonly listening = new Set<number>();
    private readonly script: ScriptedRequest[];
    private firstPort: number | null = null;
    private sent = 0;
    // When the previous request arrived, on the virtual clock.
    private last = 0;

    constructor(script: readonly ScriptedRequest[] = []) {
        this.script = [...script];
    }

    async listen(port: number): Promise<void> {
        if (this.listening.has(port)) throw new Error(`port ${port} is in use`);
        this.listening.add(port);
        if (this.firstPort === null) this.firstPort = port;
    }

    async close(port: number): Promise<void> {
        this.listening.delete(port);
    }

    nextDue(): number | null {
        const next = this.script[0];
        return next === undefined ? null : this.last + (next.after ?? 0);
    }

    nextScripted(now: number): { port: number; req: HttpRequest; exchange: HttpExchange } | null {
        const due = this.nextDue();
        if (due === null || due > now) return null;
        const next = this.script.shift()!;
        this.last = due;
        const port = next.port ?? this.firstPort;
        if (port === null || !this.listening.has(port)) throw new Error(`scripted request for ${next.target}: nothing listening`);
        const { path, query } = parseTarget(next.target);
        const req: HttpRequest = {
            method: (next.method ?? 'GET').toLowerCase(),
            path,
            query,
            headers: (next.headers ?? []).map(([n, v]) => [n.toLowerCase(), v] as const),
            body: next.body ?? '',
        };
        const index = this.sent++;
        let done = false;
        const exchange: HttpExchange = {
            respond: (res: HttpResponse) => {
                if (done) return;
                done = true;
                this.responses.push({ request: index, status: res.status, headers: res.headers, body: res.body });
            },
            onAbort: (cb) => {
                if (next.disconnects !== true || done) return;
                done = true;
                this.responses.push({ request: index, aborted: true });
                cb();
            },
        };
        return { port, req, exchange };
    }
}
