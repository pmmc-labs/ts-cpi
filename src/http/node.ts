// The real HTTP backend (SPEC-HTTP): node:http on the loopback interface.
// A request is handed to the runtime once its whole body has arrived.

import http from 'node:http';
import { parseTarget, type HttpBackend, type HttpExchange, type HttpRequest } from './backend.ts';

export class NodeHttp implements HttpBackend {
    private readonly servers = new Map<number, http.Server>();

    async listen(port: number, onRequest: (req: HttpRequest, exchange: HttpExchange) => void): Promise<void> {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                let gone = false;
                let onGone: (() => void) | null = null;
                res.on('close', () => {
                    if (res.writableEnded) return;
                    gone = true;
                    onGone?.();
                });
                const { path, query } = parseTarget(req.url ?? '/');
                const headers: [string, string][] = [];
                for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
                    headers.push([req.rawHeaders[i]!.toLowerCase(), req.rawHeaders[i + 1]!]);
                }
                onRequest(
                    { method: (req.method ?? 'GET').toLowerCase(), path, query, headers, body: Buffer.concat(chunks).toString('utf8') },
                    {
                        respond(r) {
                            if (gone || res.writableEnded) return;
                            res.statusCode = r.status;
                            for (const [name, value] of r.headers) res.appendHeader(name, value);
                            res.end(r.body);
                        },
                        onAbort(cb) {
                            if (gone) cb();
                            else onGone = cb;
                        },
                    },
                );
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
        this.servers.set(port, server);
    }

    async close(port: number): Promise<void> {
        const server = this.servers.get(port);
        if (server === undefined) return;
        this.servers.delete(port);
        server.close();
        server.closeIdleConnections();
    }
}
