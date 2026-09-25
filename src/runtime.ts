// The CPI's runtime: process table, mailboxes, the virtual clock, dead
// letters, and `Runtime.boot` (SPEC-CPI sections 8, 9, 10, 11, 12).
//
// `Runtime` implements `Handlers` from builtins.ts: each method there is one
// builtin action. All mutable state lives here; builtins.ts only declares
// shape (arities, and which method an action calls).

import type {
    Addr, Closure, Env, ErrorContext, ErrorValue, Scope, State, Value,
} from './types.ts';
import {
    NIL, TRUE, FALSE, sym, int, str, cons, list, listToArray, newAddr, pid,
} from './values.ts';
import { makeError } from './errors.ts';
import { start, startExpr, step, resumeValue, resumeThrow } from './machine.ts';
import { compose, conflicts, lookup, bindingHash } from './env.ts';
import { print, display } from './printer.ts';
import type { ActionResult, Handlers, RunCtx } from './builtins.ts';
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
const ALL_NAMESPACES = new Set(['process', 'mailbox', 'host', 'environment', 'actor', 'IO', 'timer']);
const TRAPPABLE_EFFECTS = new Set(['recv', 'send', 'self', 'join']);

// ---------------------------------------------------------------------------
// Printing for the binding hash (SPEC-CPI 10.4; the task brief's prototype
// choices): like `print`, except a closure prints as `(name params body)` so
// the hash covers code, not an opaque `#<procedure ...>` tag.
// ---------------------------------------------------------------------------

function closureHashForm(c: Closure): Value {
    return list(c.name ?? FALSE, list(...c.params), list(...c.body));
}

function printForHash(v: Value): string {
    return v.t === 'closure' ? print(closureHashForm(v)) : print(v);
}

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

export class Runtime implements Handlers {
    private readonly out: (line: string) => void;

    private clock = 0;
    private nextPid = 1;
    private nextParkKey = 1;
    private cpiEnv: Env | null = null;

    private readonly procs = new Map<number, ProcEntry>();
    private readonly mailboxes = new Map<string, MailboxEntry>();
    private readonly parkTable = new Map<number, ParkedRecord>();
    private readonly deadLettersList: DeadLetter[] = [];
    private traps = new Set<string>();

    constructor(opts: { out: (line: string) => void }) {
        this.out = opts.out;
    }

    // For tests: nothing in the language reads dead letters (SPEC-CPI's
    // builtins have no accessor for them either).
    get deadLetters(): readonly DeadLetter[] {
        return this.deadLettersList;
    }

    // -------------------------------------------------------------------------
    // Boot (SPEC-CPI sections 9, 12)
    // -------------------------------------------------------------------------

    boot(env: Env): { ok: true; v: Value } | { ok: false; e: ErrorValue } {
        this.cpiEnv = env;
        const mainCall = cons(sym('main'), NIL, null);
        let state = startExpr(mainCall, env);
        for (;;) {
            if (state.mode.m === 'done') return { ok: true, v: state.mode.v };
            if (state.mode.m === 'failed') {
                // Section 12: the host stops every process when the CPI fails.
                // DECISION: the spec does not say what stop detail those processes
                // get; `killed` with a nil reason is the simplest choice.
                for (const entry of this.procs.values()) {
                    if (entry.status !== 'ended' && entry.status !== 'parked') {
                        this.endProcess(entry, { kind: 'killed', v: NIL });
                    }
                }
                return { ok: false, e: state.mode.e };
            }
            if (state.mode.m === 'host') {
                const result = this.dispatchHost(
                    state.mode.ns, state.mode.action, state.mode.args, ALL_NAMESPACES, { pid: null, outbox: null }
                );
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
    ): ActionResult {
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
                if (result.kind === 'value') { entry.state = resumeValue(entry.state, result.v); continue; }
                if (result.kind === 'throw') { entry.state = resumeThrow(entry.state, result.e); continue; }
                if (result.kind === 'trap') {
                    entry.status = 'trapped';
                    this.flushOutbox(outbox);
                    return list(sym('trap'), sym(result.effect), result.args);
                }
                if (result.reason === 'recv') {
                    entry.status = 'blocked-recv';
                    this.flushOutbox(outbox);
                    return list(sym('blocked'), sym('recv'));
                }
                if (result.reason === 'join') {
                    entry.status = 'blocked-join';
                    this.flushOutbox(outbox);
                    return list(sym('blocked'), sym('join'), mode.args[0]!);
                }
                entry.status = 'blocked-host';
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
                entry.status = 'ready';
                this.flushOutbox(outbox);
                return list(sym('quota'));
            }
            entry.state = step(entry.state);
            used += 1;
        }
    }

    private endProcess(entry: ProcEntry, detail: EndedDetail): void {
        entry.status = 'ended';
        entry.endedDetail = detail;
        const sig = list(sym('signal'), sym('terminated'), pid(entry.pid), list(sym(detail.kind), detail.v));
        for (const w of entry.watchers) {
            const addr = w.t === 'addr' ? w.addr : this.procs.get(w.pid)?.addr;
            if (addr !== undefined) this.deliverNow(null, addr, sig);
        }
        this.wakeJoiners(entry.pid);
    }

    private wakeJoiners(targetPidNum: number): void {
        for (const e of this.procs.values()) {
            if (e.status !== 'blocked-join') continue;
            const mode = e.state.mode;
            if (mode.m !== 'host') continue;
            const target = mode.args[0];
            if (target !== undefined && target.t === 'pid' && target.id === targetPidNum) e.status = 'ready';
        }
    }

    private wakeRecv(addr: Addr): void {
        for (const e of this.procs.values()) {
            if (e.status === 'blocked-recv' && e.addr.id === addr.id) e.status = 'ready';
        }
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
        entry.status = 'ready';
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
        entry.status = 'ready';
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
        const hash = bindingHash(entry.state.R, printForHash);
        const addr = entry.addr;
        entry.status = 'parked';
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
        const pidNum = this.nextPid++;
        const state: State = { ...rec.state, R: envV.env };
        const entry: ProcEntry = {
            pid: pidNum, addr: rec.addr, envRef: envV, grants: new Set(rec.grants),
            state, status: 'ready', watchers: [],
        };
        this.procs.set(pidNum, entry);
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

    hostWait(timeoutV: Value): ActionResult {
        let timeoutMs: number | null;
        if (timeoutV.t === 'bool' && timeoutV.v === false) timeoutMs = null;
        else if (timeoutV.t === 'int') timeoutMs = Number(timeoutV.v);
        else return T('type-error', 'host::wait requires an integer timeout or #false', timeoutV);

        let earliest: number | null = null;
        for (const e of this.procs.values()) {
            if (e.status === 'blocked-host' && e.sleepDeadline !== undefined) {
                if (earliest === null || e.sleepDeadline < earliest) earliest = e.sleepDeadline;
            }
        }
        if (earliest === null) return V(NIL);

        if (timeoutMs !== null && this.clock + timeoutMs < earliest) {
            this.clock += timeoutMs;
            return V(NIL);
        }
        this.clock = Math.max(this.clock, earliest); // never move time backward
        const ready: Value[] = [];
        for (const [pidNum, e] of this.procs) {
            if (e.status === 'blocked-host' && e.sleepDeadline !== undefined && e.sleepDeadline <= this.clock) {
                e.status = 'ready';
                ready.push(pid(pidNum));
            }
        }
        return V(list(...ready));
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
        return V(int(this.clock));
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
        return V(str(bindingHash(eV.env, printForHash)));
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

    ioPrint(args: readonly Value[]): ActionResult {
        this.out(args.map((a) => display(a)).join(' '));
        return V(NIL);
    }

    timerSleep(ctx: RunCtx, msV: Value): ActionResult {
        if (msV.t !== 'int') return T('type-error', 'timer::sleep requires an integer', msV);
        const ms = Number(msV.v);
        if (ctx.pid === null) {
            this.clock += ms;
            return V(NIL);
        }
        const entry = this.procs.get(ctx.pid)!;
        if (entry.sleepDeadline === undefined) entry.sleepDeadline = this.clock + ms;
        if (this.clock >= entry.sleepDeadline) {
            entry.sleepDeadline = undefined;
            return V(NIL);
        }
        return BLOCK('host');
    }
}
