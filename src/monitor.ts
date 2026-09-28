// The plan's monitor node (DESIGN-PLAN.md, step 3; DECISIONS.md): a faux
// actor that aggregates the served log, queue lengths and ticks in the host
// and sends a summary each second. It must be indistinguishable from the
// actor in tests/programs/monitor-reference.slight given the same messages,
// which is where the meaning of every number is written down.

import type { Value } from './types.ts';
import { FALSE, int, list, listToArray, str, sym, vec } from './values.ts';

// A running summary: count, sum, min, max.
type Acc = [number, number, number, number];

type Endpoint = {
    total: number;
    n: number;
    wait: number[];
    work: number[];
    whole: number[];
    ticks: number;
    // One summary per closed second, newest first: requests, p50 and p95
    // wait bins, p50 and p95 work bins, p95 total bin, ticks.
    history: number[][];
    waitAcc: Acc;
    workAcc: Acc;
    queueAcc: Acc;
    rateAcc: Acc;
};

export type MonitorConfig = {
    readonly rows: readonly string[];
    readonly routes: ReadonlySet<string>;
    readonly bins: readonly number[];
    readonly history: number;
};

const newAcc = (): Acc => [0, 0, 0, 0];

function bump(counts: number[], i: number): void {
    counts[i] = (counts[i] ?? 0) + 1;
}

function accAdd(a: Acc, x: number): Acc {
    return a[0] === 0 ? [1, x, x, x] : [a[0] + 1, a[1] + x, Math.min(x, a[2]), Math.max(x, a[3])];
}

export class Monitor {
    private second = 0;
    private readonly status = [0, 0, 0, 0, 0, 0, 0];
    private readonly endpoints = new Map<string, Endpoint>();
    private readonly config: MonitorConfig;

    constructor(config: MonitorConfig) {
        this.config = config;
        for (const row of [...config.rows, 'total']) this.endpoints.set(row, this.newEndpoint());
    }

    get currentSecond(): number {
        return this.second;
    }

    // Handles one message; returns the summary to send, if it produces one.
    handle(msg: Value): Value | null {
        const parts = listToArray(msg);
        const head = parts?.[0];
        if (parts === null || head === undefined || head.t !== 'sym') return null;
        switch (head.name) {
            case 'served':
                this.served(parts);
                return null;
            case 'sample': {
                const pairs: [string, number][] = [];
                for (const p of parts.slice(1)) {
                    const [row, n] = listToArray(p) ?? [];
                    if (row?.t === 'str' && n?.t === 'int') pairs.push([row.v, Number(n.v)]);
                }
                this.sample(pairs);
                return null;
            }
            case 'ticks': {
                const [, row, n] = parts;
                if (row?.t === 'str' && n?.t === 'int') this.ticks(row.v, Number(n.v));
                return null;
            }
            case 'second': {
                const s = parts[1];
                return s?.t === 'int' ? this.nextSecond(Number(s.v)) : null;
            }
            default:
                return null;
        }
    }

    sample(pairs: readonly (readonly [string, number])[]): void {
        let sum = 0;
        for (const [, n] of pairs) sum += n;
        for (const [row, ep] of this.endpoints) {
            const size = row === 'total' ? sum : pairs.find(([r]) => r === row)?.[1] ?? 0;
            ep.queueAcc = accAdd(ep.queueAcc, size);
        }
    }

    ticks(row: string, n: number): void {
        if (n === 0) return;
        const ep = this.endpoints.get(row);
        if (ep !== undefined) ep.ticks += n;
        this.endpoints.get('total')!.ticks += n;
    }

    // A new second: closes the seconds before it, at most `history` of them,
    // and returns the summary, or null if `s` is not a new second.
    nextSecond(s: number): Value | null {
        const gap = Math.min(this.config.history, s - this.second);
        if (gap <= 0) return null;
        for (const ep of this.endpoints.values()) for (let i = 0; i < gap; i += 1) this.closeSecond(ep);
        this.second = s;
        return this.summary();
    }

    summary(): Value {
        const ints = (xs: readonly number[]) => vec(xs.map((x) => int(x)));
        const eps: Value[] = [];
        for (const [row, ep] of this.endpoints) {
            eps.push(list(str(row), vec([
                int(ep.total), int(ep.n), ints(ep.wait), ints(ep.work), ints(ep.whole), int(ep.ticks),
                list(...ep.history.map(ints)),
                ints(ep.waitAcc), ints(ep.workAcc), ints(ep.queueAcc), ints(ep.rateAcc),
            ])));
        }
        return list(sym('metrics'), int(this.second), ints(this.status), list(...eps));
    }

    // (served port method path status arrived delivered answered)
    private served(parts: readonly Value[]): void {
        const [, , , pathV, statusV, arrivedV, deliveredV, answeredV] = parts;
        if (arrivedV?.t !== 'int' || answeredV?.t !== 'int') return;
        const arrived = Number(arrivedV.v);
        const answered = Number(answeredV.v);
        const reached = deliveredV !== undefined && deliveredV !== FALSE && deliveredV.t === 'int' ? Number(deliveredV.v) : answered;
        this.countStatus(statusV);
        const first = pathV === undefined ? undefined : listToArray(pathV)?.[0];
        const key = first?.t === 'str' && this.config.routes.has(first.v) ? first.v : 'other';
        for (const row of [key, 'total']) {
            const ep = this.endpoints.get(row);
            if (ep !== undefined) this.addRequest(ep, reached - arrived, answered - reached, answered - arrived);
        }
    }

    private countStatus(statusV: Value | undefined): void {
        bump(this.status, 0);
        if (statusV?.t !== 'int') { bump(this.status, 6); return; }
        const status = Number(statusV.v);
        if (status < 400) bump(this.status, 1);
        else if (status < 500) bump(this.status, 2);
        else if (status === 503) bump(this.status, 3);
        else if (status === 504) bump(this.status, 4);
        else bump(this.status, 5);
    }

    private addRequest(ep: Endpoint, wait: number, work: number, whole: number): void {
        ep.total += 1;
        ep.n += 1;
        bump(ep.wait, this.binOf(wait));
        bump(ep.work, this.binOf(work));
        bump(ep.whole, this.binOf(whole));
        ep.waitAcc = accAdd(ep.waitAcc, wait);
        ep.workAcc = accAdd(ep.workAcc, work);
    }

    private binOf(ms: number): number {
        const i = this.config.bins.findIndex((bound) => ms < bound);
        return i < 0 ? this.config.bins.length : i;
    }

    // The bin holding the q-th percentile of the n times in h; -1 if n is 0.
    private quantile(h: readonly number[], n: number, q: number): number {
        if (n === 0) return -1;
        const target = Math.floor((n * q + 99) / 100);
        let seen = 0;
        for (let i = 0; ; i += 1) {
            seen += h[i]!;
            if (seen >= target || i === h.length - 1) return i;
        }
    }

    private closeSecond(ep: Endpoint): void {
        const n = ep.n;
        const summary = [
            n, this.quantile(ep.wait, n, 50), this.quantile(ep.wait, n, 95),
            this.quantile(ep.work, n, 50), this.quantile(ep.work, n, 95), this.quantile(ep.whole, n, 95), ep.ticks,
        ];
        ep.history = [summary, ...ep.history].slice(0, this.config.history);
        ep.rateAcc = accAdd(ep.rateAcc, n);
        ep.n = 0;
        ep.wait = this.newHist();
        ep.work = this.newHist();
        ep.whole = this.newHist();
        ep.ticks = 0;
    }

    private newHist(): number[] {
        return new Array<number>(this.config.bins.length + 1).fill(0);
    }

    private newEndpoint(): Endpoint {
        return {
            total: 0, n: 0, wait: this.newHist(), work: this.newHist(), whole: this.newHist(), ticks: 0, history: [],
            waitAcc: newAcc(), workAcc: newAcc(), queueAcc: newAcc(), rateAcc: newAcc(),
        };
    }
}
