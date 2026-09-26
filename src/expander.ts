// The base expander (SPEC-CPI sections 4, 4.1, 5.1, 9; DESIGN-001 section 3
// "The base expander"). Rewrites derived forms into `cond`, eta-expands core
// operations used as values, and rejects every static violation named in the
// spec, throwing `LoadError` (src/errors.ts).
//
// Input is `Value` trees built from `pair`s the way the reader would build
// them (src/values.ts): every pair may carry a source `pos`, copied from the
// form it replaces so traces still point at source. Output contains only
// special forms, applications, symbols and literals; `quote` data is left
// untouched.

import type { Pos, Sym, Value } from './types.ts';
import { cons, gensym, listToArray, sym, NIL, TRUE } from './values.ts';
import { LoadError } from './errors.ts';
import { CORE_ARITY, isCoreName, isHostName, isReserved } from './names.ts';

// A body element may be `let` or a local `defun`; anywhere else ('value')
// those two forms are a load-error (SPEC-CPI section 4).
type Ctx = 'value' | 'body';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function posOf(v: Value): Pos | null {
    return v.t === 'pair' ? v.pos : null;
}

// Builds a fresh, proper list out of `items`, with `pos` on every cons cell
// this call creates. Values already built (e.g. a reused parameter list) are
// inserted as-is and keep whatever position they already carry.
function mkList(items: readonly Value[], pos: Pos | null): Value {
    let out: Value = NIL;
    for (let i = items.length - 1; i >= 0; i--) out = cons(items[i]!, out, pos);
    return out;
}

function checkNotReserved(name: Sym, what: string): void {
    if (isReserved(name.name)) {
        throw new LoadError(`'${name.name}' is reserved and cannot be used as ${what}`, name);
    }
}

function requireSym(v: Value, what: string): Sym {
    if (v.t !== 'sym') throw new LoadError(`${what} must be a symbol`, v);
    return v;
}

function requireParamList(paramsForm: Value, what: string): readonly Sym[] {
    const params = listToArray(paramsForm);
    if (params === null) throw new LoadError(`${what} must be a list`, paramsForm);
    for (const p of params) {
        const s = requireSym(p, `${what} entry`);
        checkNotReserved(s, 'a parameter');
    }
    return params as Sym[];
}

// Core operation name used anywhere but the head of an application (SPEC-CPI
// section 5.1): `+` becomes `(lambda (a b) (+ a b))`.
// DECISION: the source symbol carries no position of its own (only pairs do),
// so the synthesized lambda's pairs get a null pos.
function etaExpand(name: string): Value {
    const arity = CORE_ARITY.get(name)!;
    const params: Sym[] = [];
    for (let i = 0; i < arity; i++) params.push(gensym('a'));
    const call = mkList([sym(name), ...params], null);
    const paramList = mkList(params, null);
    return mkList([sym('lambda'), paramList, call], null);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function expand(forms: Value[], mode: 'file' | 'expr'): Value[] {
    if (mode === 'file') return forms.map(expandTopLevelFile);
    // DECISION: an 'expr'-mode top-level form is a single expression, not a
    // body, so `let` and local `defun` are not allowed directly at that level
    // either (only inside a nested lambda/defun/do/clause body).
    return forms.map((f) => expandExpr(f, 'value'));
}

function expandTopLevelFile(form: Value): Value {
    if (form.t !== 'pair') throw new LoadError('top-level form must be (defun ...) or (const ...)', form);
    const elements = listToArray(form);
    if (elements === null) throw new LoadError('top-level form must be a proper list', form);
    const head = elements[0]!;
    if (head.t !== 'sym' || (head.name !== 'defun' && head.name !== 'const')) {
        throw new LoadError('top-level form must be (defun ...) or (const ...)', form);
    }
    const p = form.pos;
    return head.name === 'defun' ? expandDefun(elements, p) : expandConst(elements, p);
}

// ---------------------------------------------------------------------------
// Bodies (SPEC-CPI section 4): the sequence of a lambda, a defun, a do, or a
// cond/case clause. `let` and local `defun` are legal only as elements here.
// ---------------------------------------------------------------------------

function expandBody(forms: readonly Value[]): Value[] {
    return forms.map((f) => expandExpr(f, 'body'));
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function expandExpr(form: Value, ctx: Ctx): Value {
    if (form.t === 'sym') {
        if (isHostName(form.name)) {
            throw new LoadError(`'${form.name}' is a host request name and may only be the head of an application`, form);
        }
        if (isCoreName(form.name)) return etaExpand(form.name);
        return form;
    }
    if (form.t !== 'pair') return form; // nil, bool, int, float, str

    const elements = listToArray(form);
    if (elements === null) throw new LoadError('an expression must be a proper list', form);
    const p = form.pos;
    const head = elements[0]!;

    if (head.t !== 'sym') {
        const fn = expandExpr(head, 'value');
        const args = elements.slice(1).map((e) => expandExpr(e, 'value'));
        return mkList([fn, ...args], p);
    }

    switch (head.name) {
        case 'quote':
            return expandQuote(form, elements, p);
        case 'lambda':
            return expandLambda(form, elements, p);
        case 'defun':
            if (ctx !== 'body') {
                throw new LoadError('defun may appear only at the top level of a file or as an element of a body', form);
            }
            return expandDefun(elements, p);
        case 'const':
            throw new LoadError('const may appear only at the top level of a file', form);
        case 'let':
            if (ctx !== 'body') throw new LoadError('let may appear only as an element of a body', form);
            return expandLet(elements, p);
        case 'do':
            return expandDo(elements, p);
        case 'cond':
            return expandCond(elements, p);
        case 'and':
        case 'or':
            return expandAndOr(elements, p);
        case 'catch':
            return expandCatch(elements, p);
        case 'if':
            return expandIf(elements, p);
        case 'when':
            return expandWhen(elements, p);
        case 'case':
            return expandCase(elements, p);
        case 'quasiquote':
            if (elements.length !== 2) throw new LoadError('quasiquote requires exactly one template', form);
            return expandTemplate(elements[1]!);
        case 'unquote':
        case 'unquote-splicing':
            throw new LoadError(`${head.name} may appear only inside a quasiquote`, form);
        default: {
            // An ordinary application, a core-operation call, or a host request:
            // the head stays put (this is the one position eta-expansion and the
            // `::`-elsewhere check both exempt); only the arguments are expressions.
            const args = elements.slice(1).map((e) => expandExpr(e, 'value'));
            return mkList([head, ...args], p);
        }
    }
}

// ---------------------------------------------------------------------------
// Special forms
// ---------------------------------------------------------------------------

function expandQuote(form: Value, elements: readonly Value[], p: Pos | null): Value {
    if (elements.length !== 2) throw new LoadError('quote requires exactly one datum', form);
    return mkList([elements[0]!, elements[1]!], p); // datum is left untouched
}

function expandLambda(form: Value, elements: readonly Value[], p: Pos | null): Value {
    if (elements.length < 2) throw new LoadError('lambda requires a parameter list', form);
    const paramsForm = elements[1]!;
    requireParamList(paramsForm, 'lambda parameters');
    const body = expandBody(elements.slice(2));
    return mkList([elements[0]!, paramsForm, ...body], p);
}

function expandDefun(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length < 3) throw new LoadError('defun requires a name, a parameter list, and a body', elements[0]);
    const name = requireSym(elements[1]!, 'defun name');
    checkNotReserved(name, 'a defun name');
    const paramsForm = elements[2]!;
    requireParamList(paramsForm, 'defun parameters');
    const body = expandBody(elements.slice(3));
    return mkList([elements[0]!, name, paramsForm, ...body], p);
}

function expandConst(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length !== 3) throw new LoadError('const requires a name and an expression', elements[0]);
    const name = requireSym(elements[1]!, 'const name');
    checkNotReserved(name, 'a const name');
    const expr = expandExpr(elements[2]!, 'value');
    return mkList([elements[0]!, name, expr], p);
}

function expandLet(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length !== 3) throw new LoadError('let requires a name and an expression', elements[0]);
    const name = requireSym(elements[1]!, 'let name');
    checkNotReserved(name, 'a let name');
    const expr = expandExpr(elements[2]!, 'value');
    return mkList([elements[0]!, name, expr], p);
}

function expandDo(elements: readonly Value[], p: Pos | null): Value {
    const body = expandBody(elements.slice(1));
    return mkList([elements[0]!, ...body], p);
}

function expandCond(elements: readonly Value[], p: Pos | null): Value {
    const clauses = elements.slice(1).map((clauseForm) => {
        const arr = listToArray(clauseForm);
        if (arr === null || arr.length === 0) throw new LoadError('a cond clause must be a non-empty list', clauseForm);
        const test = expandExpr(arr[0]!, 'value');
        const body = expandBody(arr.slice(1));
        return mkList([test, ...body], posOf(clauseForm));
    });
    return mkList([elements[0]!, ...clauses], p);
}

function expandAndOr(elements: readonly Value[], p: Pos | null): Value {
    const parts = elements.slice(1).map((e) => expandExpr(e, 'value'));
    return mkList([elements[0]!, ...parts], p);
}

function expandCatch(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length !== 4) throw new LoadError('catch requires exactly a body, a name, and a handler', elements[0]);
    const body = expandExpr(elements[1]!, 'value');
    const name = requireSym(elements[2]!, 'catch name');
    checkNotReserved(name, 'a catch variable');
    const handler = expandExpr(elements[3]!, 'value');
    return mkList([elements[0]!, body, name, handler], p);
}

// ---------------------------------------------------------------------------
// Derived forms (SPEC-CPI section 4.1): rewritten into `cond` here, once and
// for all, so the evaluator never sees `if`, `when` or `case`.
// ---------------------------------------------------------------------------

function expandIf(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length !== 4) throw new LoadError('if requires a test, a then, and an else', elements[0]);
    const test = expandExpr(elements[1]!, 'value');
    const thenBody = expandBody([elements[2]!]);
    const elseBody = expandBody([elements[3]!]);
    const clause1 = mkList([test, ...thenBody], posOf(elements[2]!));
    const clause2 = mkList([TRUE, ...elseBody], posOf(elements[3]!));
    return mkList([sym('cond'), clause1, clause2], p);
}

function expandWhen(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length < 2) throw new LoadError('when requires a test', elements[0]);
    const test = expandExpr(elements[1]!, 'value');
    const body = expandBody(elements.slice(2));
    const doForm = mkList([sym('do'), ...body], p);
    const clause = mkList([test, doForm], p);
    return mkList([sym('cond'), clause], p);
}

// `(case topic (term body...) ... (else body...))` becomes
// `(do (let t topic) (cond ((eq? t term) body...) ... (#true body...)))`,
// with `t` a fresh name from `gensym('case')`.
function expandCase(elements: readonly Value[], p: Pos | null): Value {
    if (elements.length < 2) throw new LoadError('case requires a topic', elements[0]);
    const topic = expandExpr(elements[1]!, 'value');
    const clauseForms = elements.slice(2);
    const t = gensym('case');

    const condClauses: Value[] = [];
    clauseForms.forEach((cf, i) => {
        const arr = listToArray(cf);
        if (arr === null || arr.length === 0) throw new LoadError('a case clause must be a non-empty list', cf);
        const first = arr[0]!;
        const isElse = first.t === 'sym' && first.name === 'else';
        if (isElse && i !== clauseForms.length - 1) {
            throw new LoadError('an else clause must be the last clause of case', cf);
        }
        const body = expandBody(arr.slice(1));
        if (isElse) {
            condClauses.push(mkList([TRUE, ...body], posOf(cf)));
        } else {
            const term = expandExpr(first, 'value');
            const test = mkList([sym('eq?'), t, term], posOf(cf));
            condClauses.push(mkList([test, ...body], posOf(cf)));
        }
    });

    const condForm = mkList([sym('cond'), ...condClauses], p);
    const letForm = mkList([sym('let'), t, topic], p);
    return mkList([sym('do'), letForm, condForm], p);
}

// `(a ,b ,@c d)` becomes (cons 'a (cons b (append c (cons 'd ())))). Parts
// with no unquote in them stay quoted, so constant structure is shared. A
// splice at the end of a list needs no copy: `(a ,@c)` is (cons 'a c).
// Nested quasiquote is not supported.
function expandTemplate(t: Value): Value {
    if (!hasUnquote(t)) return quoted(t);
    const items = listToArray(t)!;
    const head = items[0]!;
    if (head.t === 'sym' && (head.name === 'unquote' || head.name === 'unquote-splicing')) {
        if (items.length !== 2) throw new LoadError(`${head.name} requires exactly one expression`, t);
        if (head.name === 'unquote-splicing') throw new LoadError('unquote-splicing must be an element of a list', t);
        return expandExpr(items[1]!, 'value');
    }
    const p = posOf(t);
    let out: Value = NIL;
    let tail = true;
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (isForm(item, 'unquote-splicing')) {
            const parts = listToArray(item)!;
            if (parts.length !== 2) throw new LoadError('unquote-splicing requires exactly one expression', item);
            const spliced = expandExpr(parts[1]!, 'value');
            out = tail ? spliced : mkList([sym('append'), spliced, out], p);
        } else {
            out = mkList([sym('cons'), expandTemplate(item), tail ? NIL : out], p);
        }
        tail = false;
    }
    return out;
}

// True if the template contains an unquote. A nested quasiquote is an error.
function hasUnquote(t: Value): boolean {
    if (t.t !== 'pair') return false;
    if (isForm(t, 'quasiquote')) throw new LoadError('nested quasiquote is not supported', t);
    if (isForm(t, 'unquote') || isForm(t, 'unquote-splicing')) return true;
    return (listToArray(t) ?? []).some(hasUnquote);
}

function isForm(v: Value, name: string): boolean {
    return v.t === 'pair' && v.car.t === 'sym' && v.car.name === name;
}

function quoted(v: Value): Value {
    return v.t === 'pair' || v.t === 'sym' ? mkList([sym('quote'), v], posOf(v)) : v;
}
