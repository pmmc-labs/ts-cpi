// Namespace tables for the CPI's host requests (SPEC-CPI section 10).
// Owned by Task T, alongside runtime.ts.
//
// A namespace table only declares shape: each action's arity and a `run`
// function that forwards to a method on `Handlers`, which `Runtime`
// implements. All state (the process table, mailboxes, the clock, the trap
// set, dead letters, the TUI) lives in runtime.ts; this file has none.

import type { Addr, ErrorValue, Value } from './types.ts';

// ---------------------------------------------------------------------------
// The shape a handler call produces (SPEC-CPI section 8, and the manager's
// dispatch order in the task brief).
// ---------------------------------------------------------------------------

export type ActionResult =
    | { readonly kind: 'value'; readonly v: Value }
    | { readonly kind: 'throw'; readonly e: ErrorValue }
    // Leaves the process in `Host` mode; the runtime records why it is blocked.
    | { readonly kind: 'block'; readonly reason: 'recv' | 'join' | 'host' }
    // Only ever produced by a trappable `actor::` action whose name is in the
    // trap set. `args` is already the list the trap reports, e.g. `(addr msg)`.
    | { readonly kind: 'trap'; readonly effect: string; readonly args: Value };

// What a handler needs to know about who is asking.
export type RunCtx = {
    // null when the CPI itself is the caller (SPEC-CPI section 1): the CPI has
    // no process layer, so `actor::` handlers reject this with `bad-state`.
    readonly pid: number | null;
    // Where a process's `actor::send` during `process::run` buffers its sends,
    // to be delivered when the batch ends (see the task brief's prototype
    // choices). Null when there is no batch to buffer into (the CPI's own
    // `mailbox::send` delivers at once instead).
    readonly outbox: { addr: Addr; msg: Value }[] | null;
};

// Only requests the CPI makes can take real time and return a promise:
// `host::wait`, `timer::sleep` in the CPI, and the `tui::` actions that draw.
// A process's requests are always answered at once (SPEC-CPI section 11).
export type Answer = ActionResult | Promise<ActionResult>;

export type ActionSpec = {
    readonly arity: number | 'any';
    readonly run: (h: Handlers, ctx: RunCtx, args: readonly Value[]) => Answer;
};

// ---------------------------------------------------------------------------
// The methods `Runtime` implements, one per builtin action.
// ---------------------------------------------------------------------------

export interface Handlers {
    // 10.1 process::
    spawn(f: Value, args: Value, env: Value, grants: Value, mailbox: Value): ActionResult;
    processRun(pidV: Value, nV: Value): ActionResult;
    processResume(pidV: Value, v: Value): ActionResult;
    processResumeThrow(pidV: Value, e: Value): ActionResult;
    processKill(pidV: Value, reason: Value): ActionResult;
    processState(pidV: Value): ActionResult;
    processAddress(pidV: Value): ActionResult;
    processEnv(pidV: Value): ActionResult;
    processSetEnv(pidV: Value, envV: Value): ActionResult;
    processPark(pidV: Value): ActionResult;
    processUnpark(dataV: Value, envV: Value): ActionResult;
    processWatch(pidV: Value, watcherV: Value): ActionResult;
    processCheckpoint(pidV: Value): ActionResult;

    // 10.2 mailbox::
    mailboxCreate(durableV: Value, capacityV: Value): ActionResult;
    mailboxSend(addrV: Value, msgV: Value): ActionResult;
    mailboxSize(addrV: Value): ActionResult;
    mailboxTake(addrV: Value): ActionResult;

    // 10.3 host::
    hostWait(timeoutV: Value): Answer;
    hostSetTraps(effectsV: Value): ActionResult;
    hostNow(): ActionResult;

    // 10.4 environment::
    envSelf(): ActionResult;
    envCompose(aV: Value, bV: Value): ActionResult;
    envConflicts(eV: Value): ActionResult;
    envLookup(eV: Value, nameV: Value): ActionResult;
    envBindingHash(eV: Value): ActionResult;
    envErrorEnv(eV: Value): ActionResult;
    envErrorPad(eV: Value, levelV: Value): ActionResult;
    envClosurePad(fV: Value): ActionResult;
    envDefine(eV: Value, nameV: Value, value: Value): ActionResult;
    envRequired(eV: Value): ActionResult;
    envResolve(eV: Value, grantsV: Value): ActionResult;
    envHistory(eV: Value, nameV: Value): ActionResult;
    envAccept(eV: Value, namesV: Value): ActionResult;
    envDifference(aV: Value, bV: Value): ActionResult;

    // 10.5 actor:: (needs the caller's own pid, via RunCtx)
    actorRecv(ctx: RunCtx): ActionResult;
    actorSend(ctx: RunCtx, addrV: Value, msgV: Value): ActionResult;
    actorSelf(ctx: RunCtx): ActionResult;
    actorJoin(ctx: RunCtx, pidV: Value): ActionResult;

    // IO:: and timer:: (ordinary; usable by the CPI too)
    ioPrint(args: readonly Value[]): ActionResult;
    timerSleep(ctx: RunCtx, msV: Value): Answer;

    // tui:: (SPEC-TUI; privileged, the CPI only)
    tuiOpen(modeV: Value): Answer;
    tuiRender(viewV: Value): Answer;
    tuiSize(): ActionResult;
    tuiSubscribe(addrV: Value): ActionResult;
    tuiUnsubscribe(): ActionResult;
    tuiClose(): Answer;
}

// ---------------------------------------------------------------------------
// The tables themselves.
// ---------------------------------------------------------------------------

function ns(entries: Record<string, ActionSpec>): ReadonlyMap<string, ActionSpec> {
    return new Map(Object.entries(entries));
}

export const NAMESPACES: ReadonlyMap<string, ReadonlyMap<string, ActionSpec>> = new Map([
    ['process', ns({
        'spawn':         { arity: 5, run: (h, _c, a) => h.spawn(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!) },
        'run':           { arity: 2, run: (h, _c, a) => h.processRun(a[0]!, a[1]!) },
        'resume':        { arity: 2, run: (h, _c, a) => h.processResume(a[0]!, a[1]!) },
        'resume-throw':  { arity: 2, run: (h, _c, a) => h.processResumeThrow(a[0]!, a[1]!) },
        'kill':          { arity: 2, run: (h, _c, a) => h.processKill(a[0]!, a[1]!) },
        'state':         { arity: 1, run: (h, _c, a) => h.processState(a[0]!) },
        'address':       { arity: 1, run: (h, _c, a) => h.processAddress(a[0]!) },
        'env':           { arity: 1, run: (h, _c, a) => h.processEnv(a[0]!) },
        'set-env':       { arity: 2, run: (h, _c, a) => h.processSetEnv(a[0]!, a[1]!) },
        'park':          { arity: 1, run: (h, _c, a) => h.processPark(a[0]!) },
        'unpark':        { arity: 2, run: (h, _c, a) => h.processUnpark(a[0]!, a[1]!) },
        'watch':         { arity: 2, run: (h, _c, a) => h.processWatch(a[0]!, a[1]!) },
        'checkpoint':    { arity: 1, run: (h, _c, a) => h.processCheckpoint(a[0]!) },
    })],
    ['mailbox', ns({
        'create': { arity: 2, run: (h, _c, a) => h.mailboxCreate(a[0]!, a[1]!) },
        'send':   { arity: 2, run: (h, _c, a) => h.mailboxSend(a[0]!, a[1]!) },
        'size':   { arity: 1, run: (h, _c, a) => h.mailboxSize(a[0]!) },
        'take':   { arity: 1, run: (h, _c, a) => h.mailboxTake(a[0]!) },
    })],
    ['host', ns({
        'wait':       { arity: 1, run: (h, _c, a) => h.hostWait(a[0]!) },
        'set-traps':  { arity: 1, run: (h, _c, a) => h.hostSetTraps(a[0]!) },
        'now':        { arity: 0, run: (h) => h.hostNow() },
    })],
    ['environment', ns({
        'self':          { arity: 0, run: (h) => h.envSelf() },
        'compose':       { arity: 2, run: (h, _c, a) => h.envCompose(a[0]!, a[1]!) },
        'conflicts':     { arity: 1, run: (h, _c, a) => h.envConflicts(a[0]!) },
        'lookup':        { arity: 2, run: (h, _c, a) => h.envLookup(a[0]!, a[1]!) },
        'binding-hash':  { arity: 1, run: (h, _c, a) => h.envBindingHash(a[0]!) },
        'error-env':     { arity: 1, run: (h, _c, a) => h.envErrorEnv(a[0]!) },
        'error-pad':     { arity: 2, run: (h, _c, a) => h.envErrorPad(a[0]!, a[1]!) },
        'closure-pad':   { arity: 1, run: (h, _c, a) => h.envClosurePad(a[0]!) },
        'define':        { arity: 3, run: (h, _c, a) => h.envDefine(a[0]!, a[1]!, a[2]!) },
        'required':      { arity: 1, run: (h, _c, a) => h.envRequired(a[0]!) },
        'resolve':       { arity: 2, run: (h, _c, a) => h.envResolve(a[0]!, a[1]!) },
        'history':       { arity: 2, run: (h, _c, a) => h.envHistory(a[0]!, a[1]!) },
        'accept':        { arity: 2, run: (h, _c, a) => h.envAccept(a[0]!, a[1]!) },
        'difference':    { arity: 2, run: (h, _c, a) => h.envDifference(a[0]!, a[1]!) },
    })],
    ['actor', ns({
        'recv': { arity: 0, run: (h, c) => h.actorRecv(c) },
        'send': { arity: 2, run: (h, c, a) => h.actorSend(c, a[0]!, a[1]!) },
        'self': { arity: 0, run: (h, c) => h.actorSelf(c) },
        'join': { arity: 1, run: (h, c, a) => h.actorJoin(c, a[0]!) },
    })],
    ['IO', ns({
        // DECISION: IO::print is variadic ("v ..." in SPEC-CPI 10.5's neighbour
        // list), which the fixed-arity signature scheme in section 8 does not
        // cover; `arity: 'any'` skips the arity-error check for it alone.
        'print': { arity: 'any', run: (h, _c, a) => h.ioPrint(a) },
    })],
    ['timer', ns({
        'sleep': { arity: 1, run: (h, c, a) => h.timerSleep(c, a[0]!) },
    })],
    ['tui', ns({
        'open': { arity: 1, run: (h, _c, a) => h.tuiOpen(a[0]!) },
        'render': { arity: 1, run: (h, _c, a) => h.tuiRender(a[0]!) },
        'size': { arity: 0, run: (h) => h.tuiSize() },
        'subscribe': { arity: 1, run: (h, _c, a) => h.tuiSubscribe(a[0]!) },
        'unsubscribe': { arity: 0, run: (h) => h.tuiUnsubscribe() },
        'close': { arity: 0, run: (h) => h.tuiClose() },
    })],
]);
