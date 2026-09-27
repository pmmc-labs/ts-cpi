// The global names a role's code uses (DECISIONS.md, "Building environments
// from roles"). Works on expanded code, which contains only special forms,
// applications, symbols and literals (src/expander.ts).

import type { Value } from './types.ts';
import { listToArray } from './values.ts';
import { isCoreName, isHostName } from './names.ts';

// Adds to `out` every name that `body`, run with `locals` in scope, uses as a
// global name: a symbol in value position, or at the head of an application,
// that no enclosing parameter, `let`, local `defun` or `catch` binds. Host
// request names count; core operations do not.
export function globalUses(body: readonly Value[], locals: ReadonlySet<string>, out: Set<string>): void {
    walkBody(body, locals, out);
}

function isForm(v: Value, name: string): boolean {
    return v.t === 'pair' && v.car.t === 'sym' && v.car.name === name;
}

function names(paramsForm: Value): string[] {
    return (listToArray(paramsForm) ?? []).map((p) => (p.t === 'sym' ? p.name : ''));
}

// A body: `let` binds its name for the rest of the body, and consecutive
// local `defun`s form a group whose names are visible to one another and to
// the rest of the body (SPEC-CPI section 4).
function walkBody(forms: readonly Value[], locals: ReadonlySet<string>, out: Set<string>): void {
    let scope = new Set(locals);
    let i = 0;
    while (i < forms.length) {
        const form = forms[i]!;
        if (isForm(form, 'defun')) {
            const group: Value[][] = [];
            while (i < forms.length && isForm(forms[i]!, 'defun')) {
                group.push(listToArray(forms[i]!)!);
                i++;
            }
            scope = new Set([...scope, ...group.map((d) => (d[1] as { name: string }).name)]);
            for (const d of group) walkBody(d.slice(3), new Set([...scope, ...names(d[2]!)]), out);
            continue;
        }
        if (isForm(form, 'let')) {
            const arr = listToArray(form)!;
            walkExpr(arr[2]!, scope, out);
            scope = new Set([...scope, (arr[1] as { name: string }).name]);
        } else {
            walkExpr(form, scope, out);
        }
        i++;
    }
}

function walkExpr(x: Value, scope: ReadonlySet<string>, out: Set<string>): void {
    if (x.t === 'sym') {
        if (!scope.has(x.name) && !isCoreName(x.name)) out.add(x.name);
        return;
    }
    if (x.t !== 'pair') return;
    const arr = listToArray(x)!;
    const head = arr[0]!;
    if (head.t !== 'sym') {
        for (const e of arr) walkExpr(e, scope, out);
        return;
    }
    switch (head.name) {
        case 'quote':
            return;
        case 'lambda':
            walkBody(arr.slice(2), new Set([...scope, ...names(arr[1]!)]), out);
            return;
        case 'do':
            walkBody(arr.slice(1), scope, out);
            return;
        case 'cond':
            for (const clause of arr.slice(1)) {
                const parts = listToArray(clause)!;
                walkExpr(parts[0]!, scope, out);
                walkBody(parts.slice(1), scope, out);
            }
            return;
        case 'and':
        case 'or':
            for (const e of arr.slice(1)) walkExpr(e, scope, out);
            return;
        case 'catch':
            walkExpr(arr[1]!, scope, out);
            walkExpr(arr[3]!, new Set([...scope, (arr[2] as { name: string }).name]), out);
            return;
        case 'let':
        case 'defun':
            walkBody([x], scope, out);
            return;
        default:
            if (isHostName(head.name) || !isCoreName(head.name)) walkExpr(head, scope, out);
            for (const e of arr.slice(1)) walkExpr(e, scope, out);
    }
}
