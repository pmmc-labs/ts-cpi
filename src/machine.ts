// The evaluator (SPEC-CPI sections 2, 4, 5.1, 6, 7, 8). Owned by Task M.
//
// `step` is a pure function from State to State: one call is one transition,
// following the tables in section 7.3 exactly. The only exception to purity
// is setting `e.box.ctx` the first time an error is thrown (section 7.5),
// which is the one mutable field any Value carries (see src/types.ts).

import type {
    Checkpoint, Closure, Env, ErrorValue, Frame, GroupMember, Head, Kont, Mode, Scope, Site, State, Sym, Value,
} from './types.ts';
import { FALSE, NIL, TRUE, codeArray, isFalse, listToArray } from './values.ts';
import { makeError } from './errors.ts';
import { CORE_ARITY, isCoreName, isHostName } from './names.ts';
import { CORE } from './core.ts';
import { lookup } from './env.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pushFrame(K: Kont, f: Frame): Kont {
    return { top: f, next: K };
}

export function kontDepth(K: Kont): number {
    let n = 0;
    let cur = K;
    while (cur !== null) {
        n += 1;
        cur = cur.next;
    }
    return n;
}

// The position of a sub-expression: its own pos if it's a pair, otherwise the
// nearest enclosing position (manager's note: either is acceptable for a bare
// symbol or literal; we carry the enclosing one forward for better traces).
// `fn` never changes here: it changes only when a closure is applied.
function childSite(v: Value, parent: Site): Site {
    return { fn: parent.fn, pos: v.t === 'pair' ? v.pos : parent.pos };
}

function isFormHead(v: Value, name: string): boolean {
    return v.t === 'pair' && v.car.t === 'sym' && v.car.name === name;
}

// Section 7.5: start a new throw. If `e` was already thrown once (its box is
// already set), throw a fresh `already-thrown` error carrying `e` instead.
// Otherwise record `e`'s context now, the one mutation this module performs.
function raise(e: ErrorValue, site: Site, scope: Scope, K: Kont, R: Env, A: Checkpoint): State {
    if (e.box.ctx !== null) {
        const wrapped = makeError('already-thrown', 'error already thrown', e);
        wrapped.box.ctx = { site, scope, K, R };
        return { mode: { m: 'throw', e: wrapped }, K, R, A };
    }
    e.box.ctx = { site, scope, K, R };
    return { mode: { m: 'throw', e }, K, R, A };
}

// `(rethrow e)`: throw `e` again with the context its first throw recorded.
// Nothing is recorded, so `e`'s trace still points at the original failure.
function applyRethrow(e: Value, scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site): State {
    if (e.t !== 'error') return raise(makeError('type-error', 'rethrow requires an error', e), site, scope, K, R, A);
    if (e.box.ctx === null) {
        return raise(makeError('bad-state', 'rethrow requires an error that has been thrown; use throw', e), site, scope, K, R, A);
    }
    return { mode: { m: 'throw', e }, K, R, A };
}

// ---------------------------------------------------------------------------
// `do`, `cond`, `and`/`or` bodies (SPEC-CPI section 7.3)
// ---------------------------------------------------------------------------

// DECISION: `Eval((do rest …), L)` (and the analogous cond/group/apply cases)
// is folded into the step that would have produced it, rather than built as
// an actual `(do …)` pair and re-dispatched through stepEval; tick counts are
// therefore lower than a literal reading of section 7.3, but each step still
// does bounded work, since evalDo itself does no looping over unbounded input.
function evalDo(forms: readonly Value[], scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site): State {
    if (forms.length === 0) return { mode: { m: 'ret', v: NIL }, K, R, A };

    const first = forms[0]!;

    if (isFormHead(first, 'let')) {
        const arr = codeArray(first)!; // [sym('let'), name, expr]
        const name = arr[1] as Sym;
        const expr = arr[2]!;
        const rest = forms.slice(1);
        const childSt = childSite(expr, site);
        if (rest.length === 0) {
            return { mode: { m: 'eval', x: expr, scope, site: childSt }, K, R, A };
        }
        const frame: Frame = { k: 'let', name, rest, scope, site: childSt };
        return { mode: { m: 'eval', x: expr, scope, site: childSt }, K: pushFrame(K, frame), R, A };
    }

    if (isFormHead(first, 'defun')) {
        // A run of consecutive local defuns at the front shares one group
        // (SPEC-CPI sections 7.2, 7.3).
        let i = 0;
        const group: GroupMember[] = [];
        while (i < forms.length && isFormHead(forms[i]!, 'defun')) {
            const arr = codeArray(forms[i]!)!; // [sym('defun'), name, paramsForm, ...body]
            const name = arr[1] as Sym;
            const params = codeArray(arr[2]!) as readonly Sym[];
            const body = arr.slice(3);
            group.push({ name, params, body });
            i += 1;
        }
        const rest = forms.slice(i);
        let L1: Scope = scope;
        let lastClosure: Closure | null = null;
        for (const gm of group) {
            const cl: Closure = { t: 'closure', name: gm.name, params: gm.params, body: gm.body, scope, group };
            L1 = { name: gm.name, value: cl, next: L1 };
            lastClosure = cl;
        }
        if (rest.length === 0) {
            return { mode: { m: 'ret', v: lastClosure! }, K, R, A };
        }
        return evalDo(rest, L1, K, R, A, site);
    }

    const rest = forms.slice(1);
    const childSt = childSite(first, site);
    if (rest.length === 0) {
        return { mode: { m: 'eval', x: first, scope, site: childSt }, K, R, A };
    }
    const frame: Frame = { k: 'seq', rest, scope, site: childSt };
    return { mode: { m: 'eval', x: first, scope, site: childSt }, K: pushFrame(K, frame), R, A };
}

function evalCond(clauses: readonly Value[], scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site): State {
    if (clauses.length === 0) return { mode: { m: 'ret', v: NIL }, K, R, A };
    const arr = codeArray(clauses[0]!)!; // [test, ...body]
    const test = arr[0]!;
    const body = arr.slice(1);
    const rest = clauses.slice(1);
    const frame: Frame = { k: 'cond', body, rest, scope, site };
    return { mode: { m: 'eval', x: test, scope, site: childSite(test, site) }, K: pushFrame(K, frame), R, A };
}

function evalAndOr(
    kind: 'and' | 'or', forms: readonly Value[], scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site
): State {
    if (forms.length === 0) return { mode: { m: 'ret', v: kind === 'and' ? TRUE : FALSE }, K, R, A };
    const first = forms[0]!;
    const rest = forms.slice(1);
    const childSt = childSite(first, site);
    if (rest.length === 0) {
        return { mode: { m: 'eval', x: first, scope, site: childSt }, K, R, A };
    }
    const frame: Frame = kind === 'and' ? { k: 'and', rest, scope, site } : { k: 'or', rest, scope, site };
    return { mode: { m: 'eval', x: first, scope, site: childSt }, K: pushFrame(K, frame), R, A };
}

// ---------------------------------------------------------------------------
// Applications: args, core ops, host requests, closures (SPEC-CPI 7.3, 7.4)
// ---------------------------------------------------------------------------

function evalArgsThenApply(
    head: Head, forms: readonly Value[], scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site
): State {
    if (forms.length === 0) {
        return applyHead(head, [], scope, K, R, A, site);
    }
    const first = forms[0]!;
    const frame: Frame = { k: 'args', head, done: [], rest: forms.slice(1), scope, site };
    return { mode: { m: 'eval', x: first, scope, site: childSite(first, site) }, K: pushFrame(K, frame), R, A };
}

function applyHead(
    head: Head, args: readonly Value[], scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site
): State {
    if (head.h === 'core') {
        const arity = CORE_ARITY.get(head.op)!;
        if (arity !== null && args.length !== arity) {
            return raise(makeError('arity-error', `${head.op} requires ${arity} argument(s)`), site, scope, K, R, A);
        }
        if (head.op === 'apply') {
            return applyApply(args, scope, K, R, A, site);
        }
        if (head.op === 'rethrow') {
            return applyRethrow(args[0]!, scope, K, R, A, site);
        }
        if (head.op === 'fold') {
            return foldNext(args[0]!, args[1]!, args[2]!, scope, K, R, A, site);
        }
        const op = CORE.get(head.op)!;
        const result = op.fn(args);
        if (result.ok) return { mode: { m: 'ret', v: result.v }, K, R, A };
        return raise(result.e, site, scope, K, R, A);
    }
    if (head.h === 'host') {
        return { mode: { m: 'host', ns: head.ns, action: head.action, args, scope, site }, K, R, A };
    }
    // head.h === 'call': args[0] is the procedure, the rest are its arguments.
    const fn = args[0]!;
    const callArgs = args.slice(1);
    if (fn.t !== 'closure') {
        return raise(makeError('type-error', 'application requires a procedure'), site, scope, K, R, A);
    }
    return applyClosure(fn, callArgs, scope, K, R, A, site);
}

// (apply f args): SPEC-CPI section 5.5. The machine handles this itself so
// the tail-call rule still applies to the closure `apply` invokes.
function applyApply(args: readonly Value[], scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site): State {
    const f = args[0]!;
    const argsList = args[1]!;
    const arr = listToArray(argsList);
    if (arr === null) {
        return raise(makeError('type-error', 'apply requires a proper list of arguments'), site, scope, K, R, A);
    }
    if (f.t !== 'closure') {
        return raise(makeError('type-error', 'apply requires a procedure'), site, scope, K, R, A);
    }
    return applyClosure(f, arr, scope, K, R, A, site);
}

// (fold f acc xs): applies f to acc and the first element with a FoldK frame
// on K; each value f returns comes back to the frame as the next acc. One
// step per element besides f's own, and each step does bounded work. The
// frame is rebuilt for every element, never updated: a parked continuation
// may be unparked more than once.
function foldNext(
    f: Value, acc: Value, xs: Value, scope: Scope, K: Kont, R: Env, A: Checkpoint, site: Site
): State {
    if (f.t !== 'closure') {
        return raise(makeError('type-error', 'fold requires a procedure'), site, scope, K, R, A);
    }
    if (xs.t === 'nil') return { mode: { m: 'ret', v: acc }, K, R, A };
    if (xs.t !== 'pair') {
        return raise(makeError('type-error', 'fold requires a proper list'), site, scope, K, R, A);
    }
    const frame: Frame = { k: 'fold', f, rest: xs.cdr, scope, site };
    return applyClosure(f, [acc, xs.car], scope, pushFrame(K, frame), R, A, site);
}

// Applying a closure (SPEC-CPI section 7.3 "Applying", section 7.4 tail
// calls): nothing is pushed onto K, so a call in tail position runs in
// constant space.
function applyClosure(
    f: Closure, args: readonly Value[], callerScope: Scope, K: Kont, R: Env, A: Checkpoint, callSite: Site
): State {
    if (args.length !== f.params.length) {
        const label = f.name?.name ?? 'lambda';
        return raise(makeError('arity-error', `${label} requires ${f.params.length} argument(s)`), callSite, callerScope, K, R, A);
    }

    // L1 = L0 (f.scope), plus a fresh closure over L0 for every member of the
    // group, plus the parameter bindings.
    let L1: Scope = f.scope;
    if (f.group !== null) {
        for (const gm of f.group) {
            const cl: Closure = { t: 'closure', name: gm.name, params: gm.params, body: gm.body, scope: f.scope, group: f.group };
            L1 = { name: gm.name, value: cl, next: L1 };
        }
    }
    for (let i = 0; i < f.params.length; i += 1) {
        L1 = { name: f.params[i]!, value: args[i]!, next: L1 };
    }

    // The checkpoint slot (section 7.1, 7.3): matched by name, not by closure.
    const newA: Checkpoint = (f.name !== null && A.name === f.name.name) ? { name: A.name, args } : A;

    // DECISION: entering a closure's body starts a fresh site with no fallback
    // position (fn set to the closure's name, pos null) rather than carrying
    // the call site's position forward; the manager's note allows either.
    const newSite: Site = { fn: f.name, pos: null };
    return evalDo(f.body, L1, K, R, newA, newSite);
}

// ---------------------------------------------------------------------------
// Eval mode (SPEC-CPI section 7.3)
// ---------------------------------------------------------------------------

function stepEval(x: Value, scope: Scope, site: Site, K: Kont, R: Env, A: Checkpoint): State {
    if (x.t === 'sym') {
        let cur = scope;
        while (cur !== null) {
            if (cur.name === x) return { mode: { m: 'ret', v: cur.value }, K, R, A };
            cur = cur.next;
        }
        const val = lookup(R, x.name);
        if (val !== null) return { mode: { m: 'ret', v: val }, K, R, A };
        return raise(makeError('unbound', `unbound name: ${x.name}`, x), site, scope, K, R, A);
    }

    if (x.t !== 'pair') {
        // Integer, float, string, boolean or nil: self-evaluating.
        return { mode: { m: 'ret', v: x }, K, R, A };
    }

    const elements = codeArray(x)!;
    const head = elements[0]!;

    if (head.t === 'sym') {
        switch (head.name) {
            case 'quote':
                return { mode: { m: 'ret', v: elements[1]! }, K, R, A };
            case 'lambda': {
                const paramsForm = elements[1]!;
                const params = codeArray(paramsForm) as readonly Sym[];
                const body = elements.slice(2);
                const closure: Closure = { t: 'closure', name: null, params, body, scope, group: null };
                return { mode: { m: 'ret', v: closure }, K, R, A };
            }
            case 'do':
                return evalDo(elements.slice(1), scope, K, R, A, site);
            case 'cond':
                return evalCond(elements.slice(1), scope, K, R, A, site);
            case 'and':
                return evalAndOr('and', elements.slice(1), scope, K, R, A, site);
            case 'or':
                return evalAndOr('or', elements.slice(1), scope, K, R, A, site);
            case 'catch': {
                const bodyExpr = elements[1]!;
                const name = elements[2] as Sym;
                const handler = elements[3]!;
                const frame: Frame = { k: 'catch', name, handler, scope, site };
                return {
                    mode: { m: 'eval', x: bodyExpr, scope, site: childSite(bodyExpr, site) },
                    K: pushFrame(K, frame), R, A,
                };
            }
            default:
                // 'let' and local 'defun' never reach here directly: they are
                // only ever elements of a `do`'s body, handled by evalDo.
                break;
        }

        if (isCoreName(head.name)) {
            return evalArgsThenApply({ h: 'core', op: head.name }, elements.slice(1), scope, K, R, A, site);
        }
        if (isHostName(head.name)) {
            const idx = head.name.indexOf('::');
            const ns = head.name.slice(0, idx);
            const action = head.name.slice(idx + 2);
            return evalArgsThenApply({ h: 'host', ns, action }, elements.slice(1), scope, K, R, A, site);
        }
        // An ordinary application whose head is a symbol: resolve it like any
        // other value, then apply. `elements` is already [head, ...args].
        return evalArgsThenApply({ h: 'call' }, elements, scope, K, R, A, site);
    }

    // The head is itself an expression, e.g. `((lambda (x) x) 5)`.
    return evalArgsThenApply({ h: 'call' }, elements, scope, K, R, A, site);
}

// ---------------------------------------------------------------------------
// Ret mode (SPEC-CPI section 7.3)
// ---------------------------------------------------------------------------

function stepRet(v: Value, K: Kont, R: Env, A: Checkpoint): State {
    if (K === null) return { mode: { m: 'done', v }, K: null, R, A };
    const frame = K.top;
    const rest = K.next;

    switch (frame.k) {
        case 'let': {
            const newScope: Scope = { name: frame.name, value: v, next: frame.scope };
            return evalDo(frame.rest, newScope, rest, R, A, frame.site);
        }
        case 'seq':
            return evalDo(frame.rest, frame.scope, rest, R, A, frame.site);
        case 'cond': {
            if (isFalse(v)) return evalCond(frame.rest, frame.scope, rest, R, A, frame.site);
            if (frame.body.length === 0) return { mode: { m: 'ret', v }, K: rest, R, A };
            return evalDo(frame.body, frame.scope, rest, R, A, frame.site);
        }
        case 'and': {
            if (isFalse(v)) return { mode: { m: 'ret', v: FALSE }, K: rest, R, A };
            return evalAndOr('and', frame.rest, frame.scope, rest, R, A, frame.site);
        }
        case 'or': {
            if (!isFalse(v)) return { mode: { m: 'ret', v }, K: rest, R, A };
            return evalAndOr('or', frame.rest, frame.scope, rest, R, A, frame.site);
        }
        case 'catch':
            return { mode: { m: 'ret', v }, K: rest, R, A };
        case 'fold':
            return foldNext(frame.f, v, frame.rest, frame.scope, rest, R, A, frame.site);
        case 'val':
            return { mode: { m: 'ret', v: frame.v }, K: rest, R, A };
        case 'throw':
            // A ThrowK resumption frame carries the site and scope of the host
            // request it answers (SPEC-CPI 7.1, 7.5), so an error thrown by a
            // handler gets a real trace entry and pad, not an empty one.
            return raise(frame.e, frame.site, frame.scope, rest, R, A);
        case 'eval':
            return { mode: { m: 'eval', x: frame.x, scope: frame.scope, site: frame.site }, K: rest, R, A };
        case 'args': {
            const newDone = [...frame.done, v];
            if (frame.rest.length > 0) {
                const nextForm = frame.rest[0]!;
                const nextFrame: Frame = {
                    k: 'args', head: frame.head, done: newDone, rest: frame.rest.slice(1), scope: frame.scope, site: frame.site,
                };
                return {
                    mode: { m: 'eval', x: nextForm, scope: frame.scope, site: childSite(nextForm, frame.site) },
                    K: pushFrame(rest, nextFrame), R, A,
                };
            }
            return applyHead(frame.head, newDone, frame.scope, rest, R, A, frame.site);
        }
    }
}

// ---------------------------------------------------------------------------
// Throw mode (SPEC-CPI section 7.3, 7.5): pops one frame per step.
// ---------------------------------------------------------------------------

function stepThrow(e: ErrorValue, K: Kont, R: Env, A: Checkpoint): State {
    if (K === null) return { mode: { m: 'failed', e }, K: null, R, A };
    const top = K.top;
    const rest = K.next;
    if (top.k === 'catch') {
        const newScope: Scope = { name: top.name, value: e, next: top.scope };
        return {
            mode: { m: 'eval', x: top.handler, scope: newScope, site: childSite(top.handler, top.site) },
            K: rest, R, A,
        };
    }
    return { mode: { m: 'throw', e }, K: rest, R, A };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function step(s: State): State {
    switch (s.mode.m) {
        case 'eval':
            return stepEval(s.mode.x, s.mode.scope, s.mode.site, s.K, s.R, s.A);
        case 'ret':
            return stepRet(s.mode.v, s.K, s.R, s.A);
        case 'throw':
            return stepThrow(s.mode.e, s.K, s.R, s.A);
        default:
            // 'host', 'done' and 'failed' have no transition of their own: a host
            // request is left by `resume`, not `step`, and the other two are final.
            return s;
    }
}

export function start(f: Closure, args: Value[], R: Env): State {
    const A0: Checkpoint = { name: f.name?.name ?? null, args };
    return applyClosure(f, args, null, null, R, A0, { fn: null, pos: null });
}

export function startExpr(x: Value, R: Env): State {
    const A0: Checkpoint = { name: null, args: [] };
    const site: Site = { fn: null, pos: x.t === 'pair' ? x.pos : null };
    return { mode: { m: 'eval', x, scope: null, site }, K: null, R, A: A0 };
}

// SPEC-CPI section 8: pushes `frames` (frames[0] ends up on top) and
// delivers `()` to whichever is now on top.
export function resume(s: State, frames: Frame[]): State {
    let K = s.K;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
        K = { top: frames[i]!, next: K };
    }
    return { mode: { m: 'ret', v: NIL }, K, R: s.R, A: s.A };
}

// Convenience wrappers for the runtime answering a host request (section 8):
// they build the resumption frame from the host state itself, so a thrown
// answer carries the request's own site and scope, not an empty one.

export function resumeValue(s: State, v: Value): State {
    return resume(s, [{ k: 'val', v }]);
}

export function resumeThrow(s: State, e: ErrorValue): State {
    if (s.mode.m !== 'host') throw new Error('resumeThrow: state is not in host mode');
    return resume(s, [{ k: 'throw', e, site: s.mode.site, scope: s.mode.scope }]);
}

export function run(s: State, limit: number): State {
    let cur = s;
    for (let i = 0; i < limit; i += 1) {
        if (cur.mode.m === 'done' || cur.mode.m === 'failed' || cur.mode.m === 'host') return cur;
        cur = step(cur);
    }
    return cur;
}
