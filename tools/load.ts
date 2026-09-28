// A closed-loop HTTP load generator: `concurrency` clients on keep-alive
// connections, each sending its next request as soon as the last is answered,
// for `seconds` seconds. Prints throughput, status counts and latency.
//
//   node tools/load.ts URL [concurrency] [seconds]
//
// "{i}" in the URL becomes a running request number, so each request can use
// a new name. curl starts a process per request and tops out at a few hundred
// requests a second; this finds where the gateway itself stops keeping up.

import http from 'node:http';

const [url = 'http://127.0.0.1:8080/hello/x', concurrencyArg = '32', secondsArg = '10'] = process.argv.slice(2);
const concurrency = Number(concurrencyArg);
const seconds = Number(secondsArg);
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });

const latencies: number[] = [];
const statuses = new Map<string, number>();
let next = 0;
const end = performance.now() + seconds * 1000;

function once(): Promise<void> {
    const target = url.replaceAll('{i}', String(next++));
    const t0 = performance.now();
    return new Promise((resolve) => {
        const req = http.get(target, { agent }, (res) => {
            res.resume();
            res.on('end', () => {
                latencies.push(performance.now() - t0);
                const s = String(res.statusCode);
                statuses.set(s, (statuses.get(s) ?? 0) + 1);
                resolve();
            });
        });
        req.on('error', () => {
            statuses.set('error', (statuses.get('error') ?? 0) + 1);
            resolve();
        });
    });
}

async function client(): Promise<void> {
    while (performance.now() < end) await once();
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, client));
const elapsed = (performance.now() - started) / 1000;
agent.destroy();

latencies.sort((a, b) => a - b);
const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil(latencies.length * q) - 1))] ?? 0;
const n = [...statuses.values()].reduce((a, b) => a + b, 0);
console.log(
    `${concurrency} clients, ${elapsed.toFixed(1)} s: ${n} requests, ${Math.round(n / elapsed)}/s;`,
    [...statuses].map(([s, c]) => `${s} x${c}`).join(' '),
    `| latency ms p50 ${at(0.5).toFixed(1)} p95 ${at(0.95).toFixed(1)} p99 ${at(0.99).toFixed(1)} max ${at(1).toFixed(1)}`,
);
