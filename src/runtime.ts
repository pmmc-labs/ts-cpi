// The CPI's runtime: process table, mailboxes, the clock, dead
// letters, the TUI, and `Runtime.boot` (SPEC-CPI sections 8, 9, 10, 11, 12).
//
// `Runtime` implements `Handlers` from builtins.ts: each method there is one
// builtin action. All mutable state lives here; builtins.ts only declares
// shape (arities, and which method an action calls).

import type {
    Addr, Env, ErrorContext, ErrorValue, Pair, Scope, State, Sym, Value,
} from './types.ts';
import {
    NIL, TRUE, FALSE, sym, int, str, cons, list, listToArray, newAddr, pid,
} from './values.ts';
import { makeError } from './errors.ts';
import { start, startExpr, step, resumeValue, resumeThrow } from './machine.ts';
import {
    compose, conflicts, lookup, bindingHashOf, define, requiredNames, unfilledNames, missingNamespace,
    history, accept, difference,
} from './env.ts';
import { isReserved } from './names.ts';
import { print, display } from './printer.ts';
import type { ActionResult, Answer, Handlers, RunCtx } from './builtins.ts';
import type { TuiBackend, TuiMode } from './tui/backend.ts';
import { toElement, ViewError } from './tui/views.ts';
import type { HttpBackend, HttpExchange, HttpRequest, HttpResponse } from './http/backend.ts';
import { NAMESPACES } from './builtins.ts';

// ---------------------------------------------------------------------------
// Small ActionResult constructors
// ---------------------------------------------------------------------------

const IDLE = list(sym('idle'));
const MAIL = list(sym('mail'));
const HIBERNATED = sym('hibernated');
const RESUMED = sym('resumed');
const V = (v: Value): ActionResult => ({ kind: 'value', v });
const T = (tag: string, message: string, payload: Value = NIL): ActionResult =>
    ({ kind: 'throw', e: makeError(tag, message, payload) });
const BLOCK = (reason: 'recv' | 'join' | 'host'): ActionResult => ({ kind: 'block', reason });
const TRAP = (effect: string, args: Value): ActionResult => ({ kind: 'trap', effect, args });

const ORDINARY_NAMESPACES = new Set(['actor', 'IO', 'timer']);
const ALL_NAMESPACES = new Set(['process', 'mailbox', 'host', 'environment', 'actor', 'IO', 'timer', 'tui', 'http', 'plan']);
const TRAPPABLE_EFFECTS = new Set(['recv', 'send', 'self', 'join']);

// ---------------------------------------------------------------------------
// Pads (SPEC-CPI 10.4): a local scope shown as `(name value)` pairs,
// innermost first, one entry per visible name (innermost binding wins).
// ---------------------------------------------------------------------------

function padFromScope(scope: Scope): Value {
    const seen = new Set<string>();
    const items: Value[] = [];
    let cur = scope;
    while (cur !== null) {
        if (!seen.has(cur.name.name)) {
            seen.add(cur.name.name);
            items.push(list(cur.name, cur.value));
        }
        cur = cur.next;
    }
    return list(...items);
}

// Mirrors traceEntries' walk (core.ts) but returns the frame's scope at
// `level` instead of a position tuple. 'missing' means no such trace entry.
function scopeAtLevel(ctx: ErrorContext, level: number): Scope | 'missing' {
    if (level === 0) return ctx.scope;
    let count = 0;
    let K = ctx.K;
    while (K !== null) {
        const frame = K.top;
        if (frame.k !== 'val' && frame.k !== 'throw') {
            count += 1;
            if (count === level) return frame.scope;
        }
        K = K.next;
    }
    return 'missing';
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

type ProcStatus = 'ready' | 'blocked-recv' | 'blocked-join' | 'blocked-host' | 'trapped' | 'parked' | 'ended';

type EndedDetail = { readonly kind: 'exited' | 'failed' | 'killed'; readonly v: Value };

type ProcEntry = {
    readonly pid: number;
    addr: Addr;
    envRef: { readonly t: 'env'; readonly env: Env };
    grants: ReadonlySet<string>;
    state: State;
    status: ProcStatus;
    endedDetail?: EndedDetail;
    // Ticks used by every batch this PID has run (process::ticks).
    ticks: number;
    // Set the first time a sleep blocks; cleared once it resolves (see
    // `timerSleep`). Not recomputed on retry, so the deadline never moves.
    sleepDeadline?: number | undefined;
    // The PID a process blocked in join waits for (indexed by setStatus).
    joinTarget?: number | undefined;
    // Woken from recv by a message it has not yet had a turn to take. If it
    // ends first, the wake-up passes to the next waiter (see `endProcess`).
    wokenForMessage?: boolean;
    // When it last blocked in recv, and whether process::run-ready has
    // reported it idle since (set by setStatus).
    recvSince?: number;
    idleReported?: boolean;
    watchers: Array<{ t: 'pid'; pid: number } | { t: 'addr'; addr: Addr }>;
};

// `receivers` are the processes spawned or unparked onto the mailbox that are
// neither parked nor ended (kept by setStatus). A non-durable mailbox that has
// had a receiver and has none left is closed: sends to it are dead letters.
//
// A reply address (SPEC-HTTP section 4) is a mailbox whose receiver is the
// host: `reply` is set, and it is closed once it has answered its request.
type MailboxEntry = {
    durable: boolean;
    capacity: number;
    queue: Value[];
    receivers: Set<ProcEntry>;
    hadReceiver: boolean;
    reply?: ReplyState;
};

type ReplyState = {
    readonly addr: Addr;
    readonly exchange: HttpExchange;
    // On host::now: the host answers 504 once it passes.
    readonly deadline: number;
    done: boolean;
    timer?: ReturnType<typeof setTimeout>;
    // For the served log (SPEC-HTTP section 6), times on host::now.
    readonly port: number;
    readonly req: HttpRequest;
    readonly arrived: number;
    delivered: number | false;
};

function newMailbox(durable: boolean, capacity: number): MailboxEntry {
    return { durable, capacity, queue: [], receivers: new Set(), hadReceiver: false };
}

function isClosed(mbox: MailboxEntry): boolean {
    if (mbox.reply !== undefined) return mbox.reply.done;
    return !mbox.durable && mbox.hadReceiver && mbox.receivers.size === 0;
}

// A request as the message SPEC-HTTP section 3 describes.
function requestMessage(replyTo: Addr, req: HttpRequest): Value {
    const pairs = (xs: readonly (readonly [string, string])[]) => list(...xs.map(([n, v]) => list(str(n), str(v))));
    return list(
        sym('request'), replyTo, sym(req.method), list(...req.path.map((s) => str(s))),
        pairs(req.query), pairs(req.headers), str(req.body),
    );
}

// `(response status headers body)`, or null if `msg` is not one.
function toResponse(msg: Value): HttpResponse | null {
    const parts = listToArray(msg);
    if (parts === null || parts.length !== 4) return null;
    const [tag, status, headersV, body] = parts as [Value, Value, Value, Value];
    if (tag.t !== 'sym' || tag.name !== 'response') return null;
    if (status.t !== 'int' || status.v < 100n || status.v > 599n || body.t !== 'str') return null;
    const headerList = listToArray(headersV);
    if (headerList === null) return null;
    const headers: [string, string][] = [];
    for (const h of headerList) {
        const pair = listToArray(h);
        if (pair === null || pair.length !== 2 || pair[0]!.t !== 'str' || pair[1]!.t !== 'str') return null;
        headers.push([pair[0]!.v, pair[1]!.v]);
    }
    return { status: Number(status.v), headers, body: body.v };
}

// DECISION: a mailbox's `grants` are not part of the parked *value* (SPEC-CPI
// 10.1 lists only continuation, checkpoint, binding hash and address as the
// parked state's visible fields), but the runtime still needs them to grant
// the unparked process the same namespaces. They ride along in the internal
// park table, invisible to the language-level data.
type ParkedRecord = { readonly state: State; readonly addr: Addr; readonly grants: ReadonlySet<string> };

type DeadLetter = { readonly from: Addr | null; readonly to: Addr; readonly msg: Value };

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

// A plan (DESIGN-PLAN.md) as the host keeps it: the round's quota and idle
// threshold, if it has a round; the CPI's mailboxes whose mail wakes it; and
// the hibernate nodes, each an env ref and an idle threshold.
type Hibernate = { readonly envV: Value; readonly idle: number };
type Plan = {
    readonly round: { readonly n: number; readonly idle: number | null } | null;
    readonly inboxes: readonly Addr[];
    readonly hibernate: readonly Hibernate[];
};

export type RuntimeOptions = {
    // Where `IO::print` lines go while no TUI is open.
    readonly out: (line: string) => void;
    // SPEC-TUI section 8. 'real' (the default) is milliseconds since the
    // image started. 'virtual' is for tests only: time starts at 0 and moves
    // only when `host::wait` jumps it to the next deadline.
    readonly clock?: 'real' | 'virtual';
    // Makes the backend `tui::open` draws with. Defaults to the terminal;
    // tests pass a HeadlessTui.
    readonly tui?: () => TuiBackend | Promise<TuiBackend>;
    // Makes the backend `http::listen` serves with. Defaults to node:http;
    // tests pass a HeadlessHttp.
    readonly http?: () => HttpBackend | Promise<HttpBackend>;
};

export class Runtime implements Handlers {
    private readonly out: (line: string) => void;
    private readonly virtualClock: boolean;
    private readonly started = performance.now();
    private virtualNow = 0;
    private readonly makeTui: () => TuiBackend | Promise<TuiBackend>;

    // The TUI, while open (SPEC-TUI).
    private tui: TuiBackend | null = null;
    private tuiMode: TuiMode = 'inline';
    private inputAddr: Addr | null = null;
    private inputQueue: Value[] = [];
    private heldLines: string[] = [];
    private wakeWaiter: (() => void) | null = null;

    // HTTP (SPEC-HTTP): the listeners by port, the requests the host holds
    // until `host::wait`, and the reply addresses not yet answered.
    private readonly makeHttp: () => HttpBackend | Promise<HttpBackend>;
    private http: HttpBackend | null = null;
    private readonly listeners = new Map<number, { readonly addr: Addr; readonly timeout: number }>();
    private heldRequests: { port: number; req: HttpRequest; exchange: HttpExchange; arrived: number }[] = [];
    private readonly openReplies = new Set<MailboxEntry>();
    // The served log's address, and the entries held until host::wait.
    private servedLogAddr: Addr | null = null;
    private servedLog: Value[] = [];
    private nextPid = 1;
    private nextParkKey = 1;
    private cpiEnv: Env | null = null;

    private readonly procs = new Map<number, ProcEntry>();
    // Indexes over `procs`, kept by setStatus, so delivering a message, ending
    // a process and waiting touch only the processes concerned: the table
    // itself keeps every process ever spawned (ended ones stay readable).
    private readonly live = new Set<ProcEntry>();
    private readonly recvWaiters = new Map<string, Set<ProcEntry>>();
    private readonly joinWaiters = new Map<number, Set<ProcEntry>>();
    private readonly sleepers = new Set<ProcEntry>();
    private readonly mailboxes = new Map<string, MailboxEntry>();
    private readonly parkTable = new Map<number, ParkedRecord>();
    private readonly deadLettersList: DeadLetter[] = [];
    private traps = new Set<string>();
    // The last plan plan::run was given, and what it says: a plan is only
    // read again when the CPI passes a different value.
    private planValue: Value | null = null;
    private plan: Plan = { round: null, inboxes: [], hibernate: [] };
    // Processes a hibernate node has parked, by address, in the order they
    // were parked, and the addresses of those with mail waiting.
    private readonly hibernated = new Map<string, { readonly data: Value; readonly envV: Value; readonly addr: Addr }>();
    private readonly hibernatedMail = new Set<string>();
    // While `settle` delivers held input, the receivers a delivery wakes.
    private wokenBySettle: ProcEntry[] | null = null;

    constructor(opts: RuntimeOptions) {
        this.out = opts.out;
        this.virtualClock = opts.clock === 'virtual';
        this.makeTui = opts.tui ?? (async () => new (await import('./tui/terminal.ts')).TerminalTui());
        this.makeHttp = opts.http ?? (async () => new (await import('./http/node.ts')).NodeHttp());
    }

    private now(): number {
        return this.virtualClock ? this.virtualNow : Math.floor(performance.now() - this.started);
    }

    // For tests: nothing in the language reads dead letters (SPEC-CPI's
    // builtins have no accessor for them either).
    get deadLetters(): readonly DeadLetter[] {
        return this.deadLettersList;
    }

    // -------------------------------------------------------------------------
    // Boot (SPEC-CPI sections 9, 12)
    // -------------------------------------------------------------------------

    // Runs (main) as the CPI. Asynchronous because `host::wait`, `timer::sleep`
    // and drawing take real time; every other request is answered at once. A
    // TUI left open is closed, and the terminal restored, before this returns
    // (SPEC-TUI section 10).
    async boot(env: Env): Promise<{ ok: true; v: Value } | { ok: false; e: ErrorValue }> {
        try {
            return await this.runCpi(env);
        } finally {
            await this.closeTui();
            await this.closeHttp();
        }
    }

    private async runCpi(env: Env): Promise<{ ok: true; v: Value } | { ok: false; e: ErrorValue }> {
        this.cpiEnv = env;
        const mainCall = cons(sym('main'), NIL, null);
        let state = startExpr(mainCall, env);
        for (;;) {
            if (state.mode.m === 'done') return { ok: true, v: state.mode.v };
            if (state.mode.m === 'failed') {
                // Section 12: the host stops every process when the CPI fails.
                // DECISION: the spec does not say what stop detail those processes
                // get; `killed` with a nil reason is the simplest choice.
                for (const entry of [...this.live]) this.endProcess(entry, { kind: 'killed', v: NIL });
                return { ok: false, e: state.mode.e };
            }
            if (state.mode.m === 'host') {
                const answer = this.dispatchHost(
                    state.mode.ns, state.mode.action, state.mode.args, ALL_NAMESPACES, { pid: null, outbox: null }
                );
                const result = answer instanceof Promise ? await answer : answer;
                if (result.kind === 'value') { state = resumeValue(state, result.v); continue; }
                if (result.kind === 'throw') { state = resumeThrow(state, result.e); continue; }
                // actor:: from the CPI always throws bad-state, and host::wait always
                // resolves to a value, so block/trap cannot occur here; guarded
                // defensively in case that ever changes.
                state = resumeThrow(state, makeError('bad-state', 'unexpected block or trap at CPI level'));
                continue;
            }
            state = step(state);
        }
    }

    // -------------------------------------------------------------------------
    // Host dispatch (SPEC-CPI section 8, in the order the task brief gives)
    // -------------------------------------------------------------------------

    private dispatchHost(
        nsName: string, action: string, args: readonly Value[], granted: ReadonlySet<string>, ctx: RunCtx
    ): Answer {
        if (!granted.has(nsName)) return T('not-granted', `not granted: ${nsName}`, sym(nsName));
        const table = NAMESPACES.get(nsName);
        if (table === undefined) return T('unknown-action', `unknown namespace: ${nsName}`, sym(nsName));
        const spec = table.get(action);
        if (spec === undefined) return T('unknown-action', `unknown action: ${nsName}::${action}`, sym(action));
        if (spec.arity !== 'any' && args.length !== spec.arity) {
            return T('arity-error', `${nsName}::${action} requires ${spec.arity} argument(s)`);
        }
        return spec.run(this, ctx, args);
    }

    // -------------------------------------------------------------------------
    // Running a process (SPEC-CPI section 11)
    // -------------------------------------------------------------------------

    private runBatch(entry: ProcEntry, n: number): Value {
        const outbox: { addr: Addr; msg: Value }[] = [];
        let used = 0;
        // Its first step retries the recv it was woken for, so the wake-up is used.
        entry.wokenForMessage = false;
        for (;;) {
            const mode = entry.state.mode;
            if (mode.m === 'host') {
                const result = this.dispatchHost(mode.ns, mode.action, mode.args, entry.grants, { pid: entry.pid, outbox });
                // A process can't reach the requests that take real time: they are
                // the CPI's (host::, tui::) or answered at once for a process.
                if (result instanceof Promise) throw new Error(`internal: ${mode.ns}::${mode.action} answered a process asynchronously`);
                if (result.kind === 'value') { entry.state = resumeValue(entry.state, result.v); continue; }
                if (result.kind === 'throw') { entry.state = resumeThrow(entry.state, result.e); continue; }
                if (result.kind === 'trap') {
                    this.setStatus(entry, 'trapped');
                    this.flushOutbox(outbox);
                    return list(sym('trap'), sym(result.effect), result.args);
                }
                if (result.reason === 'recv') {
                    this.setStatus(entry, 'blocked-recv');
                    this.flushOutbox(outbox);
                    return list(sym('blocked'), sym('recv'));
                }
                if (result.reason === 'join') {
                    this.setStatus(entry, 'blocked-join');
                    this.flushOutbox(outbox);
                    return list(sym('blocked'), sym('join'), mode.args[0]!);
                }
                this.setStatus(entry, 'blocked-host');
                this.flushOutbox(outbox);
                return list(sym('blocked'), sym('host'));
            }
            if (mode.m === 'done') {
                this.flushOutbox(outbox);
                this.endProcess(entry, { kind: 'exited', v: mode.v });
                return list(sym('exited'), mode.v);
            }
            if (mode.m === 'failed') {
                this.flushOutbox(outbox);
                this.endProcess(entry, { kind: 'failed', v: mode.e });
                return list(sym('failed'), mode.e);
            }
            if (used >= n) {
                this.setStatus(entry, 'ready');
                this.flushOutbox(outbox);
                return list(sym('quota'));
            }
            entry.state = step(entry.state);
            used += 1;
            entry.ticks += 1;
        }
    }

    // The one place a process's status changes, so the indexes stay right.
    private setStatus(entry: ProcEntry, status: ProcStatus): void {
        const before = entry.status;
        if (before === 'blocked-recv') this.recvWaiters.get(entry.addr.id)?.delete(entry);
        if (before === 'blocked-join' && entry.joinTarget !== undefined) this.joinWaiters.get(entry.joinTarget)?.delete(entry);
        if (before === 'blocked-host') this.sleepers.delete(entry);
        entry.status = status;
        if (status === 'ended' || status === 'parked') {
            this.live.delete(entry);
            this.mailboxes.get(entry.addr.id)?.receivers.delete(entry);
        } else {
            this.live.add(entry);
        }
        if (status === 'blocked-recv') {
            indexed(this.recvWaiters, entry.addr.id).add(entry);
            entry.recvSince = this.now();
            entry.idleReported = false;
        }
        if (status === 'blocked-join') {
            const mode = entry.state.mode;
            const target = mode.m === 'host' ? mode.args[0] : undefined;
            entry.joinTarget = target !== undefined && target.t === 'pid' ? target.id : undefined;
            if (entry.joinTarget !== undefined) indexed(this.joinWaiters, entry.joinTarget).add(entry);
        }
        if (status === 'blocked-host' && entry.sleepDeadline !== undefined) this.sleepers.add(entry);
    }

    private bindingHashOf(env: Env): string {
        return bindingHashOf(env);
    }

    private endProcess(entry: ProcEntry, detail: EndedDetail): void {
        this.setStatus(entry, 'ended');
        entry.endedDetail = detail;
        if (entry.wokenForMessage === true) {
            entry.wokenForMessage = false;
            this.wakeRecv(entry.addr);
        }
        const sig = list(sym('signal'), sym('terminated'), pid(entry.pid), list(sym(detail.kind), detail.v));
        for (const w of entry.watchers) {
            const addr = w.t === 'addr' ? w.addr : this.procs.get(w.pid)?.addr;
            if (addr !== undefined) this.deliverNow(null, addr, sig);
        }
        this.wakeJoiners(entry.pid);
    }

    private wakeJoiners(targetPidNum: number): void {
        for (const e of [...(this.joinWaiters.get(targetPidNum) ?? [])]) this.setStatus(e, 'ready');
    }

    // One message wakes one receiver: the one that has waited longest in
    // recv. `recvWaiters` is a Set, so its iteration order is wait order.
    private wakeRecv(addr: Addr): void {
        const mbox = this.mailboxes.get(addr.id);
        if (mbox === undefined || mbox.queue.length === 0) return;
        const waiters = this.recvWaiters.get(addr.id);
        if (waiters === undefined) return;
        for (const e of waiters) {
            this.setStatus(e, 'ready');
            e.wokenForMessage = true;
            this.wokenBySettle?.push(e);
            return;
        }
    }

    private addReceiver(entry: ProcEntry): void {
        const mbox = this.mailboxes.get(entry.addr.id);
        if (mbox === undefined) return;
        mbox.receivers.add(entry);
        mbox.hadReceiver = true;
    }

    // Immediate delivery (mailbox::send, and watcher signals): SPEC-CPI 10.2.
    private deliverNow(fromAddr: Addr | null, addr: Addr, msg: Value): ActionResult {
        const mbox = this.mailboxes.get(addr.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addr);
        if (mbox.reply !== undefined) {
            this.deliverReply(fromAddr, mbox, msg);
            return V(TRUE);
        }
        if (isClosed(mbox)) {
            this.deadLettersList.push({ from: fromAddr, to: addr, msg });
            return V(TRUE);
        }
        if (mbox.queue.length >= mbox.capacity) return T('full', 'mailbox is at capacity', addr);
        mbox.queue.push(msg);
        if (this.hibernated.has(addr.id)) this.hibernatedMail.add(addr.id);
        this.wakeRecv(addr);
        return V(TRUE);
    }

    // Sends buffered during a process's batch (SPEC-CPI 11, task brief): pushed
    // into their mailboxes, without re-checking capacity (already reserved at
    // send time; see `actorSend`), when the batch ends.
    private flushOutbox(outbox: readonly { addr: Addr; msg: Value }[]): void {
        for (const { addr, msg } of outbox) {
            const mbox = this.mailboxes.get(addr.id);
            if (mbox === undefined) continue;
            if (mbox.reply !== undefined) {
                this.deliverReply(null, mbox, msg);
                continue;
            }
            if (isClosed(mbox)) {
                this.deadLettersList.push({ from: null, to: addr, msg });
                continue;
            }
            mbox.queue.push(msg);
            if (this.hibernated.has(addr.id)) this.hibernatedMail.add(addr.id);
        }
        for (const { addr } of outbox) this.wakeRecv(addr);
    }

    // ===========================================================================
    // 10.1 process::
    // ===========================================================================

    spawn(fV: Value, argsV: Value, envV: Value, grantsV: Value, mailboxV: Value): ActionResult {
        if (fV.t !== 'closure') return T('type-error', 'process::spawn requires a procedure', fV);
        const argsArr = listToArray(argsV);
        if (argsArr === null) return T('type-error', 'process::spawn requires a proper list of arguments', argsV);
        if (envV.t !== 'env') return T('type-error', 'process::spawn requires an env ref', envV);
        const grantNames = listToArray(grantsV);
        if (grantNames === null) return T('type-error', 'process::spawn requires a list of namespace symbols', grantsV);
        const grants = new Set<string>();
        for (const g of grantNames) {
            if (g.t !== 'sym') return T('type-error', 'process::spawn grants must be symbols', g);
            if (!ORDINARY_NAMESPACES.has(g.name)) return T('not-granted', `the CPI may not grant ${g.name}`, g);
            grants.add(g.name);
        }
        const missing = missingNamespace(envV.env, grants);
        if (missing !== null) return T('not-granted', `the environment needs ${missing}, which is not granted`, sym(missing));
        let addr: Addr;
        if (mailboxV.t === 'bool' && mailboxV.v === false) {
            addr = newAddr();
            this.mailboxes.set(addr.id, newMailbox(false, 1000));
        } else if (mailboxV.t === 'addr') {
            const mbox = this.mailboxes.get(mailboxV.id);
            if (mbox === undefined) return T('type-error', 'unknown mailbox address', mailboxV);
            if (mbox.reply !== undefined) return T('bad-state', 'a reply address cannot be received on', mailboxV);
            addr = mailboxV;
        } else {
            return T('type-error', 'process::spawn requires an address or #false for mailbox', mailboxV);
        }
        const pidNum = this.nextPid++;
        const state = start(fV, argsArr, envV.env);
        const entry: ProcEntry = { pid: pidNum, addr, envRef: envV, grants, state, status: 'ready', watchers: [], ticks: 0 };
        this.procs.set(pidNum, entry);
        this.live.add(entry);
        this.addReceiver(entry);
        return V(pid(pidNum));
    }

    processRun(pidV: Value, nV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::run requires a pid', pidV);
        if (nV.t !== 'int') return T('type-error', 'process::run requires an integer', nV);
        const n = Number(nV.v);
        if (n < 1) return T('type-error', 'process::run requires n >= 1', nV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status !== 'ready') {
            return T('bad-state', 'process::run requires a ready process', pidV);
        }
        return V(this.runBatch(entry, n));
    }

    // (process::run-ready n idle): the same as the CPI calling process::run
    // on each process that is ready when its turn comes, in PID order, and
    // keeping the stop reasons it must act on. `live` holds processes in the
    // order they were made, which is PID order, and a round adds none.
    processRunReady(nV: Value, idleV: Value): ActionResult {
        if (nV.t !== 'int' || nV.v < 1n) return T('type-error', 'process::run-ready requires an integer n >= 1', nV);
        let idle: number | null;
        if (idleV.t === 'bool' && idleV.v === false) idle = null;
        else if (idleV.t === 'int' && idleV.v >= 0n) idle = Number(idleV.v);
        else return T('type-error', 'process::run-ready requires a non-negative integer idle or #false', idleV);
        const round = this.runRound(Number(nV.v), idle);
        return V(list(list(...round.events), int(round.ready)));
    }

    // One round. A member of a hibernate node is never reported idle: once
    // it has waited `idle` ms it is parked at the end of the round, if it is
    // still waiting then, since a message sent later in the round may have
    // woken it.
    private runRound(n: number, idle: number | null, hibernate: readonly Hibernate[] = []): { events: Value[]; ready: number } {
        const now = this.now();
        const events: Value[] = [];
        const sleepy: { entry: ProcEntry; node: Hibernate }[] = [];
        for (const entry of this.live) {
            if (entry.status === 'ready') {
                const stop = this.runBatch(entry, n);
                const why = (stop as Pair).car as Sym;
                if (why.name === 'exited' || why.name === 'failed' || why.name === 'trap') {
                    events.push(list(pid(entry.pid), stop));
                }
            } else if (entry.status === 'blocked-recv') {
                const node = hibernate.length === 0 ? undefined : this.hibernateNodeOf(entry, hibernate);
                if (node !== undefined) {
                    if (now - entry.recvSince! >= node.idle) sleepy.push({ entry, node });
                } else if (idle !== null && !entry.idleReported && now - entry.recvSince! >= idle) {
                    entry.idleReported = true;
                    events.push(list(pid(entry.pid), IDLE));
                }
            }
        }
        for (const { entry, node } of sleepy) {
            if (entry.status !== 'blocked-recv') continue;
            const parked = this.processPark(pid(entry.pid));
            if (parked.kind !== 'value') continue;
            this.hibernated.set(entry.addr.id, { data: parked.v, envV: node.envV, addr: entry.addr });
            events.push(list(pid(entry.pid), list(HIBERNATED, entry.addr)));
        }
        let ready = 0;
        for (const entry of this.live) if (entry.status === 'ready') ready += 1;
        return { events, ready };
    }

    // The hibernate node a process belongs to: the one for its env ref, if
    // it receives on a durable mailbox (a parked receiver does not keep a
    // non-durable one open, so its messages would be lost).
    private hibernateNodeOf(entry: ProcEntry, hibernate: readonly Hibernate[]): Hibernate | undefined {
        const node = hibernate.find((h) => h.envV === entry.envRef);
        return node !== undefined && this.mailboxes.get(entry.addr.id)?.durable === true ? node : undefined;
    }

    // Unparks each hibernated process with mail, in the order they were
    // parked, while the plan has a hibernate node for its env ref.
    private resumeHibernated(hibernate: readonly Hibernate[]): Value[] {
        if (this.hibernatedMail.size === 0) return [];
        const events: Value[] = [];
        for (const [id, h] of this.hibernated) {
            if (!this.hibernatedMail.has(id) || !hibernate.some((node) => node.envV === h.envV)) continue;
            const unparked = this.processUnpark(h.data, h.envV);
            if (unparked.kind !== 'value') continue;
            this.hibernated.delete(id);
            this.hibernatedMail.delete(id);
            events.push(list(unparked.v, list(RESUMED, h.addr)));
        }
        return events;
    }

    processResume(pidV: Value, v: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::resume requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status !== 'trapped') {
            return T('bad-state', 'process::resume requires a trapped process', pidV);
        }
        entry.state = resumeValue(entry.state, v);
        this.setStatus(entry, 'ready');
        return V(TRUE);
    }

    processResumeThrow(pidV: Value, eV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::resume-throw requires a pid', pidV);
        if (eV.t !== 'error') return T('type-error', 'process::resume-throw requires an error', eV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status !== 'trapped') {
            return T('bad-state', 'process::resume-throw requires a trapped process', pidV);
        }
        entry.state = resumeThrow(entry.state, eV);
        this.setStatus(entry, 'ready');
        return V(TRUE);
    }

    processKill(pidV: Value, reason: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::kill requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status === 'ended' || entry.status === 'parked') {
            return T('bad-state', 'process::kill requires a live process', pidV);
        }
        this.endProcess(entry, { kind: 'killed', v: reason });
        return V(TRUE);
    }

    processState(pidV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::state requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined) return T('type-error', 'unknown pid', pidV);
        switch (entry.status) {
            case 'ready': return V(list(sym('ready')));
            case 'blocked-recv': return V(list(sym('blocked'), sym('recv')));
            case 'blocked-join': {
                const mode = entry.state.mode;
                const target = mode.m === 'host' ? mode.args[0]! : NIL;
                return V(list(sym('blocked'), sym('join'), target));
            }
            case 'blocked-host': return V(list(sym('blocked'), sym('host')));
            case 'trapped': return V(list(sym('trapped')));
            case 'parked': return V(list(sym('parked')));
            case 'ended': {
                const d = entry.endedDetail!;
                return V(list(sym('ended'), sym(d.kind), d.v));
            }
        }
    }

    processAddress(pidV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::address requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status === 'ended' || entry.status === 'parked') {
            return T('bad-state', 'process has ended or is parked', pidV);
        }
        return V(entry.addr);
    }

    processEnv(pidV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::env requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status === 'ended' || entry.status === 'parked') {
            return T('bad-state', 'process has ended or is parked', pidV);
        }
        return V(entry.envRef);
    }

    processSetEnv(pidV: Value, envV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::set-env requires a pid', pidV);
        if (envV.t !== 'env') return T('type-error', 'process::set-env requires an env ref', envV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status === 'ended' || entry.status === 'parked') {
            return T('bad-state', 'process has ended or is parked', pidV);
        }
        const missing = missingNamespace(envV.env, entry.grants);
        if (missing !== null) return T('not-granted', `the environment needs ${missing}, which is not granted`, sym(missing));
        entry.state = { ...entry.state, R: envV.env };
        entry.envRef = envV;
        return V(TRUE);
    }

    processPark(pidV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::park requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || (entry.status !== 'blocked-recv' && entry.status !== 'blocked-join')) {
            return T('bad-state', 'process::park requires a process blocked in recv or join', pidV);
        }
        const key = this.nextParkKey++;
        this.parkTable.set(key, { state: entry.state, addr: entry.addr, grants: new Set(entry.grants) });
        const checkpointArgs = list(...entry.state.A.args);
        const hash = this.bindingHashOf(entry.state.R);
        const addr = entry.addr;
        this.setStatus(entry, 'parked');
        this.wakeJoiners(entry.pid);
        return V(list(sym('parked'), int(key), checkpointArgs, str(hash), addr));
    }

    processUnpark(dataV: Value, envV: Value): ActionResult {
        const arr = listToArray(dataV);
        if (arr === null || arr.length !== 5 || arr[0]!.t !== 'sym' || arr[0]!.name !== 'parked' || arr[1]!.t !== 'int') {
            return T('type-error', 'process::unpark requires parked state', dataV);
        }
        const key = Number(arr[1]!.v);
        const rec = this.parkTable.get(key);
        if (rec === undefined) return T('type-error', 'process::unpark requires parked state', dataV);
        if (envV.t !== 'env') return T('type-error', 'process::unpark requires an env ref', envV);
        const missing = missingNamespace(envV.env, rec.grants);
        if (missing !== null) return T('not-granted', `the environment needs ${missing}, which is not granted`, sym(missing));
        const pidNum = this.nextPid++;
        const state: State = { ...rec.state, R: envV.env };
        const entry: ProcEntry = {
            pid: pidNum, addr: rec.addr, envRef: envV, grants: new Set(rec.grants),
            state, status: 'ready', watchers: [], ticks: 0,
        };
        this.procs.set(pidNum, entry);
        this.live.add(entry);
        this.addReceiver(entry);
        return V(pid(pidNum));
    }

    processWatch(pidV: Value, watcherV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::watch requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined || entry.status === 'ended') return T('bad-state', 'process::watch requires a live process', pidV);
        if (watcherV.t === 'pid') entry.watchers.push({ t: 'pid', pid: watcherV.id });
        else if (watcherV.t === 'addr') entry.watchers.push({ t: 'addr', addr: watcherV });
        else return T('type-error', 'process::watch requires a pid or address', watcherV);
        return V(TRUE);
    }

    processCheckpoint(pidV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::checkpoint requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined) return T('type-error', 'unknown pid', pidV);
        if (entry.status === 'parked') return T('bad-state', 'process was parked', pidV);
        return V(list(...entry.state.A.args));
    }

    processTicks(pidV: Value): ActionResult {
        if (pidV.t !== 'pid') return T('type-error', 'process::ticks requires a pid', pidV);
        const entry = this.procs.get(pidV.id);
        if (entry === undefined) return T('type-error', 'unknown pid', pidV);
        return V(int(entry.ticks));
    }

    // ===========================================================================
    // 10.2 mailbox::
    // ===========================================================================

    mailboxCreate(durableV: Value, capacityV: Value): ActionResult {
        if (durableV.t !== 'bool') return T('type-error', 'mailbox::create requires a boolean', durableV);
        if (capacityV.t !== 'int' || capacityV.v <= 0n) {
            return T('type-error', 'mailbox::create requires a positive integer capacity', capacityV);
        }
        const addr = newAddr();
        this.mailboxes.set(addr.id, newMailbox(durableV.v, Number(capacityV.v)));
        return V(addr);
    }

    mailboxSend(addrV: Value, msgV: Value): ActionResult {
        if (addrV.t !== 'addr') return T('type-error', 'mailbox::send requires an address', addrV);
        return this.deliverNow(null, addrV, msgV);
    }

    mailboxSize(addrV: Value): ActionResult {
        if (addrV.t !== 'addr') return T('type-error', 'mailbox::size requires an address', addrV);
        const mbox = this.mailboxes.get(addrV.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addrV);
        if (mbox.reply !== undefined) return T('bad-state', 'a reply address cannot be received on', addrV);
        return V(int(mbox.queue.length));
    }

    mailboxTake(addrV: Value): ActionResult {
        if (addrV.t !== 'addr') return T('type-error', 'mailbox::take requires an address', addrV);
        const mbox = this.mailboxes.get(addrV.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addrV);
        if (mbox.reply !== undefined) return T('bad-state', 'a reply address cannot be received on', addrV);
        if (mbox.queue.length === 0) return V(FALSE);
        return V(mbox.queue.shift()!);
    }

    // ===========================================================================
    // 10.3 host::
    // ===========================================================================

    // SPEC-TUI section 9: suspends the image until a sleeper's deadline
    // passes, an input event is waiting, or `timeout` ms pass. Then wakes
    // every due sleeper, delivers every held input event, and returns the
    // PIDs that became ready. If nothing can happen, returns () at once.
    hostWait(timeoutV: Value): Answer {
        let timeoutMs: number | null;
        if (timeoutV.t === 'bool' && timeoutV.v === false) timeoutMs = null;
        else if (timeoutV.t === 'int' && timeoutV.v >= 0n) timeoutMs = Number(timeoutV.v);
        else return T('type-error', 'host::wait requires a non-negative integer timeout or #false', timeoutV);
        if (this.virtualClock) {
            const result = this.waitVirtual(timeoutMs);
            this.expireReplies();
            this.flushServedLog();
            return result;
        }
        return this.waitReal(timeoutMs).then((result) => {
            this.expireReplies();
            this.flushServedLog();
            return result;
        });
    }

    private async waitReal(timeoutMs: number | null): Promise<ActionResult> {
        const until = timeoutMs === null ? null : this.now() + timeoutMs;
        // One turn of the event loop first, so input the host has not read yet
        // (a request on a socket, a key) is taken in even by (host::wait 0).
        // Without it a CPI that is never idle never sees new input.
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (;;) {
            const earliest = this.earliestDeadline();
            if (this.inputQueue.length > 0 || this.heldRequests.length > 0) break;
            if (earliest !== null && earliest <= this.now()) break;
            if (until !== null && this.now() >= until) break;
            if (earliest === null && until === null && this.inputAddr === null && this.listeners.size === 0) break;
            const limits = [earliest, until].filter((t): t is number => t !== null).map((t) => t - this.now());
            await this.sleepUntilWoken(limits.length > 0 ? Math.max(1, Math.min(...limits)) : null);
        }
        return V(this.settle());
    }

    // Resolves after `ms` (or never, if null), or as soon as input arrives.
    private sleepUntilWoken(ms: number | null): Promise<void> {
        return new Promise((resolve) => {
            const timer = ms === null ? null : setTimeout(done, ms);
            const self = this;
            function done(): void {
                if (timer !== null) clearTimeout(timer);
                self.wakeWaiter = null;
                resolve();
            }
            this.wakeWaiter = done;
        });
    }

    private waitVirtual(timeoutMs: number | null): ActionResult {
        // Scripted input arrives when the image would otherwise idle.
        if (this.inputQueue.length === 0 && this.inputAddr !== null) {
            const next = this.tui?.nextScripted?.() ?? null;
            if (next !== null) this.inputQueue.push(next);
        }
        if (this.inputQueue.length === 0) this.takeScriptedRequests();
        if (this.inputQueue.length > 0 || this.heldRequests.length > 0) return V(this.settle());
        // Nothing yet: move the clock to the next sleeper's deadline or the
        // next scripted request, whichever is first, unless the timeout is.
        const due = this.listeners.size > 0 ? this.http?.nextDue?.() ?? null : null;
        const times = [this.earliestDeadline(), due].filter((t): t is number => t !== null);
        const earliest = times.length > 0 ? Math.min(...times) : null;
        if (earliest === null || (timeoutMs !== null && this.virtualNow + timeoutMs < earliest)) {
            if (timeoutMs !== null) this.virtualNow += timeoutMs;
            return V(NIL);
        }
        this.virtualNow = Math.max(this.virtualNow, earliest); // never move time backward
        this.takeScriptedRequests();
        return V(this.settle());
    }

    // Holds every scripted request due by now (a burst arrives together).
    private takeScriptedRequests(): void {
        if (this.listeners.size === 0) return;
        for (;;) {
            const next = this.http?.nextScripted?.(this.now()) ?? null;
            if (next === null) return;
            this.heldRequests.push({ ...next, arrived: this.now() });
        }
    }

    private earliestDeadline(): number | null {
        let earliest: number | null = null;
        for (const e of this.sleepers) {
            if (earliest === null || e.sleepDeadline! < earliest) earliest = e.sleepDeadline!;
        }
        return earliest;
    }

    // Delivers held input events and requests, and wakes due sleepers. Returns
    // the PIDs that became ready: the sleepers, and the receivers a delivery
    // woke.
    private settle(): Value {
        const woken: ProcEntry[] = [];
        this.wokenBySettle = woken;
        const events = this.inputQueue;
        this.inputQueue = [];
        for (const event of events) {
            if (this.inputAddr === null) break;
            const r = this.deliverNow(null, this.inputAddr, event);
            if (r.kind === 'throw') this.deadLettersList.push({ from: null, to: this.inputAddr, msg: event });
        }
        const requests = this.heldRequests;
        this.heldRequests = [];
        for (const r of requests) this.deliverRequest(r.port, r.req, r.exchange, r.arrived);
        this.flushServedLog();
        this.wokenBySettle = null;
        const now = this.now();
        const due = [...this.sleepers].filter((e) => e.sleepDeadline! <= now);
        for (const e of due) this.setStatus(e, 'ready');
        return list(...[...due, ...woken.filter((e) => e.status === 'ready')].sort((a, b) => a.pid - b.pid).map((e) => pid(e.pid)));
    }

    hostSetTraps(effectsV: Value): ActionResult {
        const arr = listToArray(effectsV);
        if (arr === null) return T('type-error', 'host::set-traps requires a list', effectsV);
        const names = new Set<string>();
        for (const e of arr) {
            if (e.t !== 'sym') return T('type-error', 'host::set-traps requires symbols', e);
            if (!TRAPPABLE_EFFECTS.has(e.name)) return T('unknown-action', `${e.name} is not a trappable effect`, e);
            names.add(e.name);
        }
        this.traps = names;
        return V(TRUE);
    }

    // ===========================================================================
    // plan:: (DESIGN-PLAN.md)
    // ===========================================================================

    // (plan::run plan timeout): runs the plan until the CPI is needed. It is
    // the same as the reference program in DECISIONS.md, step for step:
    // round; its events, else mail in an inbox, else the deadline; else wait,
    // for 0 ms while processes are ready, otherwise up to the round's idle
    // threshold or the deadline; and go round again unless the wait ended
    // early having woken nobody.
    async planRun(planV: Value, timeoutV: Value): Promise<ActionResult> {
        if (planV !== this.planValue) {
            const parsed = this.readPlan(planV);
            if ('e' in parsed) return parsed.e;
            this.plan = parsed;
            this.planValue = planV;
        }
        let timeout: number | null;
        if (timeoutV.t === 'bool' && timeoutV.v === false) timeout = null;
        else if (timeoutV.t === 'int' && timeoutV.v >= 0n) timeout = Number(timeoutV.v);
        else return T('type-error', 'plan::run requires a non-negative integer timeout or #false', timeoutV);
        const { round, inboxes, hibernate } = this.plan;
        const deadline = timeout === null ? null : this.now() + timeout;
        for (;;) {
            const r = round === null ? { events: [], ready: 0 } : this.runRound(round.n, round.idle, hibernate);
            if (r.events.length > 0) return V(list(...r.events));
            const mail = [...this.mailEvents(inboxes), ...this.resumeHibernated(hibernate)];
            if (mail.length > 0) return V(list(...mail));
            if (deadline !== null && this.now() >= deadline) return V(NIL);
            if (r.ready > 0) {
                await this.hostWait(int(0));
                continue;
            }
            const idles = [round?.idle ?? null, ...hibernate.map((h) => h.idle)];
            const limits = [...idles, deadline === null ? null : deadline - this.now()].filter((t): t is number => t !== null);
            const limit = limits.length === 0 ? null : Math.min(...limits);
            const before = this.now();
            const answer = await this.hostWait(limit === null ? FALSE : int(limit));
            const woken = answer.kind === 'value' ? answer.v : NIL;
            if (woken !== NIL || this.mailEvents(inboxes).length > 0 || this.hibernatedMail.size > 0) continue;
            if (limit !== null && this.now() - before >= limit) continue;
            return V(NIL);
        }
    }

    private readPlan(planV: Value): Plan | { e: ActionResult } {
        const bad = (message: string, v: Value) => ({ e: T('type-error', message, v) });
        const nodes = listToArray(planV);
        if (nodes === null) return bad('a plan is a list of nodes', planV);
        let round: Plan['round'] = null;
        const inboxes: Addr[] = [];
        const hibernate: Hibernate[] = [];
        for (const node of nodes) {
            const parts = listToArray(node);
            const kind = parts?.[0];
            if (parts === null || kind === undefined || kind.t !== 'sym') return bad('a plan node is a list starting with its kind', node);
            if (kind.name === 'round') {
                if (round !== null) return bad('a plan has at most one round', node);
                const [, nV, idleV] = parts;
                if (parts.length !== 3 || nV!.t !== 'int' || nV!.v < 1n) return bad('a round is (round n idle), with n >= 1', node);
                let idle: number | null;
                if (idleV!.t === 'bool' && idleV!.v === false) idle = null;
                else if (idleV!.t === 'int' && idleV!.v >= 0n) idle = Number(idleV!.v);
                else return bad('a round\'s idle is a non-negative integer or #false', node);
                round = { n: Number(nV!.v), idle };
            } else if (kind.name === 'hibernate') {
                const [, envV, idleV] = parts;
                if (parts.length !== 3 || envV!.t !== 'env' || idleV!.t !== 'int' || idleV!.v < 0n) {
                    return bad('a hibernate node is (hibernate env idle), with idle >= 0', node);
                }
                if (hibernate.some((h) => h.envV === envV)) return bad('a plan has one hibernate node per env', node);
                hibernate.push({ envV: envV!, idle: Number(idleV!.v) });
            } else if (kind.name === 'inbox') {
                for (const a of parts.slice(1)) {
                    if (a.t !== 'addr' || !this.mailboxes.has(a.id)) return bad('an inbox is (inbox address ...)', node);
                    inboxes.push(a);
                }
            } else {
                return bad(`unknown plan node: ${kind.name}`, node);
            }
        }
        return { round, inboxes, hibernate };
    }

    private mailEvents(inboxes: readonly Addr[]): Value[] {
        const events: Value[] = [];
        for (const a of inboxes) if (this.mailboxes.get(a.id)!.queue.length > 0) events.push(list(a, MAIL));
        return events;
    }

    hostNow(): ActionResult {
        return V(int(this.now()));
    }

    // ===========================================================================
    // 10.4 environment::
    // ===========================================================================

    envSelf(): ActionResult {
        return V({ t: 'env', env: this.cpiEnv! });
    }

    envCompose(aV: Value, bV: Value): ActionResult {
        if (aV.t !== 'env') return T('type-error', 'environment::compose requires env refs', aV);
        if (bV.t !== 'env') return T('type-error', 'environment::compose requires env refs', bV);
        return V({ t: 'env', env: compose(aV.env, bV.env) });
    }

    envConflicts(eV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::conflicts requires an env ref', eV);
        return V(list(...conflicts(eV.env).map((n) => sym(n))));
    }

    envLookup(eV: Value, nameV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::lookup requires an env ref', eV);
        if (nameV.t !== 'sym') return T('type-error', 'environment::lookup requires a symbol', nameV);
        const v = lookup(eV.env, nameV.name);
        if (v === null) return T('unbound', `unbound name: ${nameV.name}`, nameV);
        return V(v);
    }

    envBindingHash(eV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::binding-hash requires an env ref', eV);
        return V(str(this.bindingHashOf(eV.env)));
    }

    envErrorEnv(eV: Value): ActionResult {
        if (eV.t !== 'error') return T('type-error', 'environment::error-env requires an error', eV);
        const ctx = eV.box.ctx;
        if (ctx === null) return T('bad-state', 'error has never been thrown', eV);
        return V({ t: 'env', env: ctx.R });
    }

    envErrorPad(eV: Value, levelV: Value): ActionResult {
        if (eV.t !== 'error') return T('type-error', 'environment::error-pad requires an error', eV);
        if (levelV.t !== 'int') return T('type-error', 'environment::error-pad requires an integer level', levelV);
        const ctx = eV.box.ctx;
        if (ctx === null) return T('range-error', 'error has never been thrown', eV);
        const level = Number(levelV.v);
        if (level < 0) return T('range-error', 'level has no trace entry', levelV);
        const scope = scopeAtLevel(ctx, level);
        if (scope === 'missing') return T('range-error', 'level has no trace entry', levelV);
        return V(padFromScope(scope));
    }

    envClosurePad(fV: Value): ActionResult {
        if (fV.t !== 'closure') return T('type-error', 'environment::closure-pad requires a procedure', fV);
        return V(padFromScope(fV.scope));
    }

    envDefine(eV: Value, nameV: Value, value: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::define requires an env ref', eV);
        if (nameV.t !== 'sym') return T('type-error', 'environment::define requires a symbol', nameV);
        if (isReserved(nameV.name)) return T('type-error', `'${nameV.name}' is reserved and cannot be defined`, nameV);
        return V({ t: 'env', env: define(eV.env, nameV.name, value) });
    }

    envRequired(eV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::required requires an env ref', eV);
        return V(list(...requiredNames(eV.env).map((n) => sym(n))));
    }

    envResolve(eV: Value, grantsV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::resolve requires an env ref', eV);
        const grantNames = listToArray(grantsV);
        if (grantNames === null) return T('type-error', 'environment::resolve requires a list of namespace symbols', grantsV);
        const grants = new Set<string>();
        for (const g of grantNames) {
            if (g.t !== 'sym') return T('type-error', 'environment::resolve grants must be symbols', g);
            grants.add(g.name);
        }
        const unfilled = unfilledNames(eV.env);
        if (unfilled.length > 0) {
            return T('unbound', `unfilled names: ${unfilled.join(' ')}`, list(...unfilled.map((n) => sym(n))));
        }
        const missing = missingNamespace(eV.env, grants);
        if (missing !== null) return T('not-granted', `the environment needs ${missing}, which is not granted`, sym(missing));
        // The environment is immutable, so its binding hash is already fixed;
        // it is computed when first asked for (park, binding-hash) and cached.
        return V(eV);
    }

    envHistory(eV: Value, nameV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::history requires an env ref', eV);
        if (nameV.t !== 'sym') return T('type-error', 'environment::history requires a symbol', nameV);
        return V(list(...history(eV.env, nameV.name)));
    }

    envAccept(eV: Value, namesV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::accept requires an env ref', eV);
        const names = listToArray(namesV);
        if (names === null) return T('type-error', 'environment::accept requires a list of symbols', namesV);
        const strs: string[] = [];
        for (const n of names) {
            if (n.t !== 'sym') return T('type-error', 'environment::accept requires a list of symbols', n);
            strs.push(n.name);
        }
        return V({ t: 'env', env: accept(eV.env, strs) });
    }

    envDifference(aV: Value, bV: Value): ActionResult {
        if (aV.t !== 'env') return T('type-error', 'environment::difference requires env refs', aV);
        if (bV.t !== 'env') return T('type-error', 'environment::difference requires env refs', bV);
        return V({ t: 'env', env: difference(aV.env, bV.env) });
    }

    // ===========================================================================
    // 10.5 actor::
    // ===========================================================================

    actorRecv(ctx: RunCtx): ActionResult {
        if (ctx.pid === null) return T('bad-state', 'actor:: has no meaning for the CPI');
        if (this.traps.has('recv')) return TRAP('recv', NIL);
        const entry = this.procs.get(ctx.pid)!;
        const mbox = this.mailboxes.get(entry.addr.id)!;
        if (mbox.queue.length === 0) return BLOCK('recv');
        return V(mbox.queue.shift()!);
    }

    actorSend(ctx: RunCtx, addrV: Value, msgV: Value): ActionResult {
        if (ctx.pid === null) return T('bad-state', 'actor:: has no meaning for the CPI');
        if (addrV.t !== 'addr') return T('type-error', 'actor::send requires an address', addrV);
        if (this.traps.has('send')) return TRAP('send', list(addrV, msgV));
        const mbox = this.mailboxes.get(addrV.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addrV);
        const pending = ctx.outbox === null ? 0 : ctx.outbox.filter((o) => o.addr.id === addrV.id).length;
        if (mbox.reply === undefined && !isClosed(mbox) && mbox.queue.length + pending >= mbox.capacity) {
            return T('full', 'mailbox is at capacity', addrV);
        }
        ctx.outbox?.push({ addr: addrV, msg: msgV });
        return V(TRUE);
    }

    actorSelf(ctx: RunCtx): ActionResult {
        if (ctx.pid === null) return T('bad-state', 'actor:: has no meaning for the CPI');
        if (this.traps.has('self')) return TRAP('self', NIL);
        return V(this.procs.get(ctx.pid)!.addr);
    }

    actorJoin(ctx: RunCtx, pidV: Value): ActionResult {
        if (ctx.pid === null) return T('bad-state', 'actor:: has no meaning for the CPI');
        if (pidV.t !== 'pid') return T('type-error', 'actor::join requires a pid', pidV);
        if (this.traps.has('join')) return TRAP('join', list(pidV));
        const target = this.procs.get(pidV.id);
        if (target === undefined || target.status === 'parked') return V(sym('ended'));
        if (target.status === 'ended') return V(list(sym(target.endedDetail!.kind), target.endedDetail!.v));
        return BLOCK('join');
    }

    // ===========================================================================
    // IO:: and timer::
    // ===========================================================================

    // While a TUI is open, output must not corrupt the screen (SPEC-TUI
    // section 7): inline mode shows it above the view, fullscreen mode holds
    // it until the TUI closes.
    ioPrint(args: readonly Value[]): ActionResult {
        const line = args.map((a) => display(a)).join(' ');
        if (this.tui === null) this.out(line);
        else if (this.tuiMode === 'inline') this.tui.print(line);
        else this.heldLines.push(line);
        return V(NIL);
    }

    timerSleep(ctx: RunCtx, msV: Value): Answer {
        if (msV.t !== 'int' || msV.v < 0n) return T('type-error', 'timer::sleep requires a non-negative integer', msV);
        const ms = Number(msV.v);
        if (ctx.pid === null) {
            if (this.virtualClock) {
                this.virtualNow += ms;
                return V(NIL);
            }
            return new Promise((resolve) => setTimeout(() => resolve(V(NIL)), ms));
        }
        const entry = this.procs.get(ctx.pid)!;
        if (entry.sleepDeadline === undefined) entry.sleepDeadline = this.now() + ms;
        if (this.now() >= entry.sleepDeadline) {
            entry.sleepDeadline = undefined;
            return V(NIL);
        }
        return BLOCK('host');
    }

    // ===========================================================================
    // tui:: (SPEC-TUI section 4)
    // ===========================================================================

    async tuiOpen(modeV: Value): Promise<ActionResult> {
        if (this.tui !== null) return T('bad-state', 'the TUI is already open');
        if (modeV.t !== 'sym' || (modeV.name !== 'inline' && modeV.name !== 'fullscreen')) {
            return T('type-error', 'tui::open requires the mode inline or fullscreen', modeV);
        }
        const backend = await this.makeTui();
        await backend.open(modeV.name, (event) => {
            this.inputQueue.push(event);
            this.wakeWaiter?.();
        });
        this.tui = backend;
        this.tuiMode = modeV.name;
        return V(TRUE);
    }

    tuiRender(viewV: Value): Answer {
        if (this.tui === null) return T('bad-state', 'the TUI is not open');
        let element;
        try {
            element = toElement(viewV);
        } catch (e) {
            if (e instanceof ViewError) return T('type-error', e.message, e.at);
            throw e;
        }
        return this.tui.render(element).then(() => V(TRUE));
    }

    tuiSize(): ActionResult {
        if (this.tui === null) return T('bad-state', 'the TUI is not open');
        const [columns, rows] = this.tui.size();
        return V(list(int(columns), int(rows)));
    }

    tuiSubscribe(addrV: Value): ActionResult {
        if (this.tui === null) return T('bad-state', 'the TUI is not open');
        if (addrV.t !== 'addr' || !this.mailboxes.has(addrV.id)) return T('type-error', 'tui::subscribe requires a mailbox address', addrV);
        if (this.mailboxes.get(addrV.id)!.reply !== undefined) return T('bad-state', 'a reply address cannot be received on', addrV);
        if (!this.tui.canSubscribe()) return T('bad-state', 'input is not a terminal');
        this.inputAddr = addrV;
        this.tui.setSubscribed(true);
        return V(TRUE);
    }

    tuiUnsubscribe(): ActionResult {
        if (this.tui === null) return T('bad-state', 'the TUI is not open');
        this.inputAddr = null;
        this.inputQueue = [];
        this.tui.setSubscribed(false);
        return V(TRUE);
    }

    async tuiClose(): Promise<ActionResult> {
        if (this.tui === null) return T('bad-state', 'the TUI is not open');
        await this.closeTui();
        return V(TRUE);
    }

    private async closeTui(): Promise<void> {
        if (this.tui === null) return;
        const tui = this.tui;
        this.tui = null;
        this.inputAddr = null;
        this.inputQueue = [];
        await tui.close();
        for (const line of this.heldLines) this.out(line);
        this.heldLines = [];
    }

    // ===========================================================================
    // http:: (SPEC-HTTP)
    // ===========================================================================

    async httpListen(portV: Value, addrV: Value, timeoutV: Value): Promise<ActionResult> {
        if (portV.t !== 'int' || portV.v < 1n || portV.v > 65535n) return T('type-error', 'http::listen requires a port from 1 to 65535', portV);
        if (addrV.t !== 'addr') return T('type-error', 'http::listen requires a mailbox address', addrV);
        const mbox = this.mailboxes.get(addrV.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addrV);
        if (mbox.reply !== undefined) return T('bad-state', 'a reply address cannot be received on', addrV);
        if (timeoutV.t !== 'int' || timeoutV.v < 0n) return T('type-error', 'http::listen requires a non-negative timeout in milliseconds', timeoutV);
        const port = Number(portV.v);
        if (this.listeners.has(port)) return T('bad-state', `already listening on port ${port}`, portV);
        if (this.http === null) {
            this.http = await this.makeHttp();
            this.http.setClock?.(() => this.now());
        }
        try {
            await this.http.listen(port, (req, exchange) => {
                this.heldRequests.push({ port, req, exchange, arrived: this.now() });
                this.wakeWaiter?.();
            });
        } catch (e) {
            return T('bad-state', `cannot listen on port ${port}: ${e instanceof Error ? e.message : String(e)}`, portV);
        }
        this.listeners.set(port, { addr: addrV, timeout: Number(timeoutV.v) });
        return V(TRUE);
    }

    async httpClose(portV: Value): Promise<ActionResult> {
        if (portV.t !== 'int') return T('type-error', 'http::close requires a port', portV);
        const port = Number(portV.v);
        if (!this.listeners.has(port)) return T('bad-state', `not listening on port ${port}`, portV);
        this.listeners.delete(port);
        await this.http!.close(port);
        return V(TRUE);
    }

    // Section 5: makes the request's reply address and sends the request to
    // its listener's mailbox, or answers 503 if it cannot be delivered.
    private deliverRequest(port: number, req: HttpRequest, exchange: HttpExchange, arrived: number): void {
        const listener = this.listeners.get(port);
        const replyAddr = newAddr();
        const reply: ReplyState = {
            addr: replyAddr, exchange, deadline: arrived + (listener?.timeout ?? 0), done: false,
            port, req, arrived, delivered: false,
        };
        const replyBox: MailboxEntry = { ...newMailbox(false, 1), reply };
        this.mailboxes.set(replyAddr.id, replyBox);
        this.openReplies.add(replyBox);
        const msg = requestMessage(replyAddr, req);
        const target = listener === undefined ? undefined : this.mailboxes.get(listener.addr.id);
        if (listener === undefined || target === undefined || isClosed(target) || target.queue.length >= target.capacity) {
            this.deadLettersList.push({ from: null, to: listener?.addr ?? replyAddr, msg });
            this.answerReply(replyBox, { status: 503, headers: [], body: '' });
            return;
        }
        if (!this.virtualClock) {
            // The timer is the deadline: re-checking host::now here could see a
            // millisecond short (it is rounded down) and never fire again.
            reply.timer = setTimeout(
                () => this.answerReply(replyBox, { status: 504, headers: [], body: '' }, reply.deadline),
                Math.max(0, reply.deadline - this.now()),
            );
        }
        reply.delivered = this.now();
        this.deliverNow(null, listener.addr, msg);
        // Every request that arrived is delivered, even if its client has
        // already gone: the reply address is then closed, and a reply to it is
        // a dead letter.
        exchange.onAbort(() => {
            if (reply.done) return;
            this.closeReply(replyBox);
            this.logServed(reply, sym('disconnected'), this.now());
        });
    }

    // Section 4: a reply address takes one message, which must be a response.
    private deliverReply(fromAddr: Addr | null, mbox: MailboxEntry, msg: Value): void {
        this.expireReplies();
        const reply = mbox.reply!;
        if (reply.done) {
            this.deadLettersList.push({ from: fromAddr, to: reply.addr, msg });
            return;
        }
        const res = toResponse(msg);
        if (res === null) {
            this.deadLettersList.push({ from: fromAddr, to: reply.addr, msg });
            this.answerReply(mbox, { status: 500, headers: [], body: '' });
            return;
        }
        this.answerReply(mbox, res);
    }

    // `at` is when the answer counts as written: now, or a 504's deadline.
    private answerReply(mbox: MailboxEntry, res: HttpResponse, at: number = this.now()): void {
        const reply = mbox.reply!;
        if (reply.done) return;
        this.closeReply(mbox);
        reply.exchange.respond(res);
        this.logServed(reply, int(res.status), at);
    }

    private closeReply(mbox: MailboxEntry): void {
        const reply = mbox.reply!;
        reply.done = true;
        if (reply.timer !== undefined) clearTimeout(reply.timer);
        this.openReplies.delete(mbox);
    }

    // Answers 504 to every request whose timeout has passed on host::now.
    private expireReplies(): void {
        const now = this.now();
        for (const mbox of [...this.openReplies]) {
            if (mbox.reply!.deadline <= now) this.answerReply(mbox, { status: 504, headers: [], body: '' }, mbox.reply!.deadline);
        }
    }

    httpSubscribeLog(addrV: Value): ActionResult {
        if (addrV.t !== 'addr') return T('type-error', 'http::subscribe-log requires a mailbox address', addrV);
        const mbox = this.mailboxes.get(addrV.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addrV);
        if (mbox.reply !== undefined) return T('bad-state', 'a reply address cannot be received on', addrV);
        this.servedLogAddr = addrV;
        return V(TRUE);
    }

    httpUnsubscribeLog(): ActionResult {
        this.servedLogAddr = null;
        this.servedLog = [];
        return V(TRUE);
    }

    // Section 6: (served port method path status arrived delivered answered),
    // held until host::wait, and only while a log is subscribed.
    private logServed(reply: ReplyState, status: Value, at: number): void {
        if (this.servedLogAddr === null) return;
        this.servedLog.push(list(
            sym('served'), int(reply.port), sym(reply.req.method), list(...reply.req.path.map((s) => str(s))),
            status, int(reply.arrived), reply.delivered === false ? FALSE : int(reply.delivered), int(at),
        ));
    }

    private flushServedLog(): void {
        const entries = this.servedLog;
        this.servedLog = [];
        for (const entry of entries) {
            if (this.servedLogAddr === null) return;
            const r = this.deliverNow(null, this.servedLogAddr, entry);
            if (r.kind === 'throw') this.deadLettersList.push({ from: null, to: this.servedLogAddr, msg: entry });
        }
    }

    // When the image exits: every request still waiting is answered 503, and
    // every listener stops.
    private async closeHttp(): Promise<void> {
        for (const r of this.heldRequests) r.exchange.respond({ status: 503, headers: [], body: '' });
        this.heldRequests = [];
        for (const mbox of [...this.openReplies]) this.answerReply(mbox, { status: 503, headers: [], body: '' });
        const ports = [...this.listeners.keys()];
        this.listeners.clear();
        for (const port of ports) await this.http?.close(port);
    }
}

function indexed<K, V>(index: Map<K, Set<V>>, key: K): Set<V> {
    let set = index.get(key);
    if (set === undefined) {
        set = new Set();
        index.set(key, set);
    }
    return set;
}
