// Reserved names and core-operation arities (SPEC-CPI sections 4 and 5).
// Owned by the manager, like types.ts. core.ts supplies the implementations.

export const CORE_ARITY: ReadonlyMap<string, number> = new Map<string, number>([
    // 5.2 arithmetic
    ['+', 2], ['-', 2], ['*', 2], ['/', 2], ['%', 2],
    // 5.3 comparison and equality
    ['=', 2], ['<', 2], ['<=', 2], ['>', 2], ['>=', 2], ['eq?', 2], ['not', 1],
    // 5.4 type predicates
    ['nil?', 1], ['pair?', 1], ['boolean?', 1], ['integer?', 1], ['float?', 1], ['string?', 1],
    ['symbol?', 1], ['procedure?', 1], ['error?', 1], ['address?', 1], ['pid?', 1], ['env?', 1],
    // 5.5 pairs
    ['cons', 2], ['car', 1], ['cdr', 1], ['append', 2], ['apply', 2],
    // 5.6 strings
    ['string-length', 1], ['string-ref', 2], ['string-append', 2], ['symbol->string', 1], ['string->symbol', 1], ['value->string', 1],
    // 5.7 conversions
    ['integer->float', 1], ['float->integer', 1],
    // 5.8 errors
    ['make-error', 3], ['wrap-error', 4], ['throw', 1],
    ['error-tag', 1], ['error-message', 1], ['error-payload', 1], ['error-cause', 1], ['stack-trace-for', 1],
]);

// Evaluated by the machine.
export const SPECIAL_FORMS: ReadonlySet<string> = new Set([
    'quote', 'lambda', 'defun', 'const', 'let', 'do', 'cond', 'and', 'or', 'catch',
]);

// Rewritten into cond by the expander; the machine never sees them.
export const DERIVED_FORMS: ReadonlySet<string> = new Set(['if', 'when', 'case', 'quasiquote', 'unquote', 'unquote-splicing']);

export const isCoreName = (name: string): boolean => CORE_ARITY.has(name);
export const isHostName = (name: string): boolean => name.includes('::');

// Names that cannot be bound, shadowed or used as values.
export const isReserved = (name: string): boolean =>
    SPECIAL_FORMS.has(name) || DERIVED_FORMS.has(name) || isCoreName(name) || isHostName(name);
