// The host side of `http::` (SPEC-HTTP): what the runtime needs from an HTTP
// server. Two backends implement it: node.ts serves on the loopback interface
// with node:http, and headless.ts plays a script for tests.

export type HttpRequest = {
    readonly method: string;
    // Decoded path segments: `/users/42` is ["users", "42"], `/` is [].
    readonly path: readonly string[];
    readonly query: readonly (readonly [string, string])[];
    // Names in lowercase, in the order the client sent them.
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string;
};

export type HttpResponse = {
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string;
};

// One request in flight.
export interface HttpExchange {
    // Writes the response. Called at most once; ignored if the client has gone.
    respond(res: HttpResponse): void;
    // `cb` runs if the client disconnects before a response is written.
    onAbort(cb: () => void): void;
}

export interface HttpBackend {
    // Starts accepting on 127.0.0.1:`port`. `onRequest` receives each request
    // at any time the host has control; the runtime holds it until
    // `host::wait`. Rejects if the port cannot be opened.
    listen(port: number, onRequest: (req: HttpRequest, exchange: HttpExchange) => void): Promise<void>;
    // Stops accepting on `port`. Exchanges already handed over stay usable.
    close(port: number): Promise<void>;
    // Test backends only, for the virtual clock: when the next scripted request
    // arrives on host::now (null when the script is done), and that request
    // once `now` has reached it (null before then).
    nextDue?(): number | null;
    nextScripted?(now: number): { port: number; req: HttpRequest; exchange: HttpExchange } | null;
}

// Splits a request target (`/users/42?x=1`) into decoded path segments and
// query parameters. Empty segments are dropped, so `/a//b/` is ["a", "b"].
export function parseTarget(target: string): { path: string[]; query: [string, string][] } {
    const url = new URL(target, 'http://localhost');
    const path = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
    return { path, query: [...url.searchParams] };
}
