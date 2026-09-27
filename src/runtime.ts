// The CPI's runtime: process table, mailboxes, the clock, dead
// letters, the TUI, and `Runtime.boot` (SPEC-CPI sections 8, 9, 10, 11, 12).
//
// `Runtime` implements `Handlers` from builtins.ts: each method there is one
// builtin action. All mutable state lives here; builtins.ts only declares
// shape (arities, and which method an action calls).

import type {
    Addr, Env, ErrorContext, ErrorValue, Scope, State, Value,
} from './types.ts';
import {
    NIL, TRUE, FALSE, sym, int, str, cons, list, listToArray, newAddr, pid,
} from './values.ts';
import { makeError } from './errors.ts';
import { start, startExpr, step, resumeValue, resumeThrow } from './machine.ts';
import {
    compose, conflicts, lookup, bindingHashOf, define, requiredNames, unfilledNames, missingNamespace,
    history, accept, difference, select,
} from './env.ts';
import { isReserved } from './names.ts';
import { print, display } from './printer.ts';
import type { ActionResult, Answer, Handlers, RunCtx } from './builtins.ts';
import type { TuiBackend, TuiMode } from './tui/backend.ts';
import { toElement, ViewError } from './tui/views.ts';
import { NAMESPACES } from './builtins.ts';

// ---------------------------------------------------------------------------
// Small ActionResult constructors
// ---------------------------------------------------------------------------

const V = (v: Value): ActionResult => ({ kind: 'value', v });
const T = (tag: string, message: string, payload: Value = NIL): ActionResult =>
    ({ kind: 'throw', e: makeError(tag, message, payload) });
const BLOCK = (reason: 'recv' | 'join' | 'host'): ActionResult => ({ kind: 'block', reason });
const TRAP = (effect: string, args: Value): ActionResult => ({ kind: 'trap', effect, args });

const ORDINARY_NAMESPACES = new Set(['actor', 'IO', 'timer']);
const ALL_NAMESPACES = new Set(['process', 'mailbox', 'host', 'environment', 'actor', 'IO', 'timer', 'tui']);
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
    // Set the first time a sleep blocks; cleared once it resolves (see
    // `timerSleep`). Not recomputed on retry, so the deadline never moves.
    sleepDeadline?: number | undefined;
    // The PID a process blocked in join waits for (indexed by setStatus).
    joinTarget?: number | undefined;
    watchers: Array<{ t: 'pid'; pid: number } | { t: 'addr'; addr: Addr }>;
};

type MailboxEntry = { durable: boolean; capacity: number; queue: Value[]; ownerPid: number | null };

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

    constructor(opts: RuntimeOptions) {
        this.out = opts.out;
        this.virtualClock = opts.clock === 'virtual';
        this.makeTui = opts.tui ?? (async () => new (await import('./tui/terminal.ts')).TerminalTui());
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
        }
    }

    // The one place a process's status changes, so the indexes stay right.
    private setStatus(entry: ProcEntry, status: ProcStatus): void {
        const before = entry.status;
        if (before === 'blocked-recv') this.recvWaiters.get(entry.addr.id)?.delete(entry);
        if (before === 'blocked-join' && entry.joinTarget !== undefined) this.joinWaiters.get(entry.joinTarget)?.delete(entry);
        if (before === 'blocked-host') this.sleepers.delete(entry);
        entry.status = status;
        if (status === 'ended' || status === 'parked') this.live.delete(entry);
        else this.live.add(entry);
        if (status === 'blocked-recv') indexed(this.recvWaiters, entry.addr.id).add(entry);
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

    private wakeRecv(addr: Addr): void {
        for (const e of [...(this.recvWaiters.get(addr.id) ?? [])]) this.setStatus(e, 'ready');
    }

    // Immediate delivery (mailbox::send, and watcher signals): SPEC-CPI 10.2.
    private deliverNow(fromAddr: Addr | null, addr: Addr, msg: Value): ActionResult {
        const mbox = this.mailboxes.get(addr.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addr);
        const ownerEnded = mbox.ownerPid !== null && this.procs.get(mbox.ownerPid)?.status === 'ended';
        if (!mbox.durable && ownerEnded) {
            this.deadLettersList.push({ from: fromAddr, to: addr, msg });
            return V(TRUE);
        }
        if (mbox.queue.length >= mbox.capacity) return T('full', 'mailbox is at capacity', addr);
        mbox.queue.push(msg);
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
            const ownerEnded = mbox.ownerPid !== null && this.procs.get(mbox.ownerPid)?.status === 'ended';
            if (!mbox.durable && ownerEnded) {
                this.deadLettersList.push({ from: null, to: addr, msg });
                continue;
            }
            mbox.queue.push(msg);
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
            this.mailboxes.set(addr.id, { durable: false, capacity: 1000, queue: [], ownerPid: null });
        } else if (mailboxV.t === 'addr') {
            if (!this.mailboxes.has(mailboxV.id)) return T('type-error', 'unknown mailbox address', mailboxV);
            addr = mailboxV;
        } else {
            return T('type-error', 'process::spawn requires an address or #false for mailbox', mailboxV);
        }
        const pidNum = this.nextPid++;
        const state = start(fV, argsArr, envV.env);
        const entry: ProcEntry = { pid: pidNum, addr, envRef: envV, grants, state, status: 'ready', watchers: [] };
        this.procs.set(pidNum, entry);
        this.live.add(entry);
        this.mailboxes.get(addr.id)!.ownerPid = pidNum;
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
            state, status: 'ready', watchers: [],
        };
        this.procs.set(pidNum, entry);
        this.live.add(entry);
        const mbox = this.mailboxes.get(rec.addr.id);
        if (mbox !== undefined) mbox.ownerPid = pidNum;
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

    // ===========================================================================
    // 10.2 mailbox::
    // ===========================================================================

    mailboxCreate(durableV: Value, capacityV: Value): ActionResult {
        if (durableV.t !== 'bool') return T('type-error', 'mailbox::create requires a boolean', durableV);
        if (capacityV.t !== 'int' || capacityV.v <= 0n) {
            return T('type-error', 'mailbox::create requires a positive integer capacity', capacityV);
        }
        const addr = newAddr();
        this.mailboxes.set(addr.id, { durable: durableV.v, capacity: Number(capacityV.v), queue: [], ownerPid: null });
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
        return V(int(mbox.queue.length));
    }

    mailboxTake(addrV: Value): ActionResult {
        if (addrV.t !== 'addr') return T('type-error', 'mailbox::take requires an address', addrV);
        const mbox = this.mailboxes.get(addrV.id);
        if (mbox === undefined) return T('type-error', 'unknown mailbox address', addrV);
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
        return this.virtualClock ? this.waitVirtual(timeoutMs) : this.waitReal(timeoutMs);
    }

    private async waitReal(timeoutMs: number | null): Promise<ActionResult> {
        const until = timeoutMs === null ? null : this.now() + timeoutMs;
        for (;;) {
            const earliest = this.earliestDeadline();
            if (this.inputQueue.length > 0 || (earliest !== null && earliest <= this.now())) break;
            if (until !== null && this.now() >= until) break;
            if (earliest === null && until === null && this.inputAddr === null) break;
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
        if (this.inputQueue.length > 0) return V(this.settle());
        const earliest = this.earliestDeadline();
        if (earliest === null || (timeoutMs !== null && this.virtualNow + timeoutMs < earliest)) {
            if (timeoutMs !== null) this.virtualNow += timeoutMs;
            return V(NIL);
        }
        this.virtualNow = Math.max(this.virtualNow, earliest); // never move time backward
        return V(this.settle());
    }

    private earliestDeadline(): number | null {
        let earliest: number | null = null;
        for (const e of this.sleepers) {
            if (earliest === null || e.sleepDeadline! < earliest) earliest = e.sleepDeadline!;
        }
        return earliest;
    }

    // Delivers held input events and wakes due sleepers; returns their PIDs.
    private settle(): Value {
        const events = this.inputQueue;
        this.inputQueue = [];
        for (const event of events) {
            if (this.inputAddr === null) break;
            const r = this.deliverNow(null, this.inputAddr, event);
            if (r.kind === 'throw') this.deadLettersList.push({ from: null, to: this.inputAddr, msg: event });
        }
        const now = this.now();
        const due = [...this.sleepers].filter((e) => e.sleepDeadline! <= now).sort((a, b) => a.pid - b.pid);
        for (const e of due) this.setStatus(e, 'ready');
        return list(...due.map((e) => pid(e.pid)));
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

    envSelect(eV: Value, namesV: Value): ActionResult {
        if (eV.t !== 'env') return T('type-error', 'environment::select requires an env ref', eV);
        const names = listToArray(namesV);
        if (names === null) return T('type-error', 'environment::select requires a list of symbols', namesV);
        const strs: string[] = [];
        for (const n of names) {
            if (n.t !== 'sym') return T('type-error', 'environment::select requires a list of symbols', n);
            strs.push(n.name);
        }
        return V({ t: 'env', env: select(eV.env, strs) });
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
        const ownerEnded = mbox.ownerPid !== null && this.procs.get(mbox.ownerPid)?.status === 'ended';
        if (!(!mbox.durable && ownerEnded) && mbox.queue.length + pending >= mbox.capacity) {
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
}

function indexed<K, V>(index: Map<K, Set<V>>, key: K): Set<V> {
    let set = index.get(key);
    if (set === undefined) {
        set = new Set();
        index.set(key, set);
    }
    return set;
}
