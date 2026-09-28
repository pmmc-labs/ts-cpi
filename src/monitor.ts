// The plan's monitor node (DESIGN-PLAN.md, step 3; DECISIONS.md): a faux
// actor that aggregates the served log, queue lengths and ticks in the host
// and sends a summary each second. It must be indistinguishable from the
// actor in tests/programs/monitor-reference.slight given the same messages,
// which is where the meaning of every number is written down.
//
// It can also draw: `fill` puts its numbers, and the facts the CPI has set,
// into a view template in place of placeholder elements (SPEC-TUI).

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

// What the host knows that the aggregate doesn't, for filling a view: each
// row's queue length now, its processes ready, waiting and parked, and how
// long the image has run.
export type ViewContext = {
    readonly queue: (row: string) => number;
    readonly workers: (row: string) => readonly [number, number, number];
    readonly uptime: number;
};

// A placeholder that names no row, field or status the monitor has.
export class TemplateError extends Error {
    readonly at: Value;
    constructor(message: string, at: Value) {
        super(message);
        this.at = at;
    }
}

const LAST_FIELDS = ['requests', 'wait-p50', 'wait-p95', 'work-p50', 'work-p95', 'total-p95', 'ticks'];
const BIN_FIELDS = new Set(['wait-p50', 'wait-p95', 'work-p50', 'work-p95', 'total-p95']);
const STATUS_NAMES = ['requests', '2xx', '4xx', '503', '504', '5xx', 'gone'];

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
    // Values the CPI has set with (set name value), for (Fact name).
    private readonly facts = new Map<string, Value>();
    // Whether there is something new to draw: a summary or a fact.
    dirty = true;

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
            case 'set': {
                const [, name, value] = parts;
                if (name?.t === 'str' && value !== undefined) {
                    this.facts.set(name.v, value);
                    this.dirty = true;
                }
                return null;
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
        this.dirty = true;
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

    // The view template with each placeholder replaced by its value:
    //   (Metric row field)   a number, a bin label or "-"
    //   (Series row field)   a list of numbers, one per second of history, oldest first
    //   (Status name)        a count of requests by status
    //   (Fact name)          what the CPI set with (set name value), or "-"
    //   (Uptime)             how long the image has run, as m:ss
    // Throws TemplateError for a placeholder it cannot fill.
    fill(v: Value, ctx: ViewContext): Value {
        if (v.t !== 'pair') return v;
        const items = listToArray(v);
        if (items === null) return v;
        const head = items[0];
        if (head?.t === 'sym') {
            switch (head.name) {
                case 'Metric': return this.metric(v, items, ctx);
                case 'Series': return this.series(v, items);
                case 'Status': {
                    const i = items[1]?.t === 'str' ? STATUS_NAMES.indexOf(items[1].v) : -1;
                    if (items.length !== 2 || i < 0) throw new TemplateError(`(Status name), name one of ${STATUS_NAMES.join(' ')}`, v);
                    return int(this.status[i]!);
                }
                case 'Fact': {
                    const name = items[1];
                    if (items.length !== 2 || name?.t !== 'str') throw new TemplateError('(Fact name), name a string', v);
                    return this.facts.get(name.v) ?? str('-');
                }
                case 'Uptime': {
                    const s = Math.floor(ctx.uptime / 1000);
                    return str(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
                }
            }
        }
        return list(...items.map((x) => this.fill(x, ctx)));
    }

    private row(v: Value, items: readonly Value[]): [string, string, Endpoint] {
        const [, rowV, fieldV] = items;
        if (items.length !== 3 || rowV?.t !== 'str' || fieldV?.t !== 'sym') throw new TemplateError('(Metric row field) or (Series row field)', v);
        const ep = this.endpoints.get(rowV.v);
        if (ep === undefined) throw new TemplateError(`no row ${rowV.v}`, v);
        return [rowV.v, fieldV.name, ep];
    }

    // The last full second, since the start, or now.
    private metric(v: Value, items: readonly Value[], ctx: ViewContext): Value {
        const [row, field, ep] = this.row(v, items);
        const last = ep.history[0] ?? [0, -1, -1, -1, -1, -1, 0];
        const i = LAST_FIELDS.indexOf(field);
        if (i >= 0) return BIN_FIELDS.has(field) ? str(this.binLabel(last[i]!)) : int(last[i]!);
        switch (field) {
            case 'total': return int(ep.total);
            case 'queue': return int(ctx.queue(row));
            case 'ready': return int(ctx.workers(row)[0]);
            case 'waiting': return int(ctx.workers(row)[1]);
            case 'parked': return int(ctx.workers(row)[2]);
        }
        const [what, stat] = field.split('-');
        const acc = { queue: ep.queueAcc, rate: ep.rateAcc, wait: ep.waitAcc, work: ep.workAcc }[what ?? ''];
        if (acc === undefined || (stat !== 'min' && stat !== 'avg' && stat !== 'max')) throw new TemplateError(`no field ${field}`, v);
        if (acc[0] === 0) return str('-');
        if (stat === 'min') return int(acc[2]);
        if (stat === 'max') return int(acc[3]);
        const tenths = Math.floor((acc[1] * 10) / acc[0]);
        return str(`${Math.floor(tenths / 10)}.${tenths % 10}`);
    }

    // Requests or ticks per second, or a percentile as its bin counted from
    // 1, with 0 for a second without requests.
    private series(v: Value, items: readonly Value[]): Value {
        const [, field, ep] = this.row(v, items);
        const i = LAST_FIELDS.indexOf(field);
        if (i < 0 || field === 'wait-p50' || field === 'work-p50') throw new TemplateError(`no series ${field}`, v);
        const values = [...ep.history].reverse().map((h) => (BIN_FIELDS.has(field) ? h[i]! + 1 : h[i]!));
        return list(...values.map((x) => int(x)));
    }

    // "<1ms" ... "<1s", ">=1s": the bin's bound, or "-" for no requests.
    private binLabel(i: number): string {
        const bins = this.config.bins;
        const unit = (ms: number) => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
        if (i < 0) return '-';
        return i < bins.length ? `<${unit(bins[i]!)}` : `>=${unit(bins[bins.length - 1]!)}`;
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
