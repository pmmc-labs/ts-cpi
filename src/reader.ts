// Reader for CPI source syntax (SPEC-CPI section 3).

import type { Pos, Value } from './types.ts';
import { NIL, TRUE, FALSE, int, float as floatVal, str, sym, cons, INT_MIN, INT_MAX, fitsInt } from './values.ts';
import { LoadError } from './errors.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token = {
    kind: 'lparen' | 'rparen' | 'quote' | 'tag' | 'int' | 'float' | 'string' | 'symbol' | 'bool';
    value: string;
    pos: Pos;
};

function tokenize(source: string, file: string): Token[] {
    const tokens: Token[] = [];
    let line = 1;
    let col = 1;
    let i = 0;

    const getPos = (): Pos => ({ file, line, col });

    while (i < source.length) {
        const ch = source[i]!;

        // Whitespace
        if (/\s/.test(ch)) {
            if (ch === '\n') {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
            i += 1;
            continue;
        }

        // Comments
        if (ch === ';') {
            col += 1;
            i += 1;
            while (i < source.length && source[i] !== '\n') {
                col += 1;
                i += 1;
            }
            continue;
        }

        // Parentheses
        if (ch === '(') {
            tokens.push({ kind: 'lparen', value: '(', pos: getPos() });
            col += 1;
            i += 1;
            continue;
        }

        if (ch === ')') {
            tokens.push({ kind: 'rparen', value: ')', pos: getPos() });
            col += 1;
            i += 1;
            continue;
        }

        // Strings
        if (ch === '"') {
            const startPos = getPos();
            let value = '';
            col += 1;
            i += 1;

            while (i < source.length && source[i] !== '"') {
                if (source[i] === '\\') {
                    i += 1;
                    col += 1;
                    if (i >= source.length) {
                        throw new LoadError(`Unterminated string at ${file}:${startPos.line}:${startPos.col}`, NIL);
                    }

                    const escChar = source[i];
                    if (escChar === '"' || escChar === '\\') {
                        value += escChar;
                        col += 1;
                        i += 1;
                    } else if (escChar === 'n') {
                        value += '\n';
                        col += 1;
                        i += 1;
                    } else if (escChar === 't') {
                        value += '\t';
                        col += 1;
                        i += 1;
                    } else if (escChar === 'u') {
                        col += 1;
                        i += 1;
                        if (source[i] !== '{') {
                            throw new LoadError(`Invalid unicode escape at ${file}:${line}:${col}`, NIL);
                        }
                        col += 1;
                        i += 1;
                        let hexStr = '';
                        while (i < source.length && source[i] !== '}') {
                            hexStr += source[i];
                            col += 1;
                            i += 1;
                        }
                        if (i >= source.length) {
                            throw new LoadError(`Unterminated unicode escape at ${file}:${line}:${col}`, NIL);
                        }
                        const codePoint = parseInt(hexStr, 16);
                        if (isNaN(codePoint)) {
                            throw new LoadError(`Invalid unicode escape at ${file}:${line}:${col}`, NIL);
                        }
                        try {
                            value += String.fromCodePoint(codePoint);
                        } catch {
                            throw new LoadError(`Invalid unicode code point at ${file}:${line}:${col}`, NIL);
                        }
                        col += 1;
                        i += 1;
                    } else {
                        throw new LoadError(`Invalid escape sequence at ${file}:${line}:${col}`, NIL);
                    }
                } else {
                    if (source[i] === '\n') {
                        line += 1;
                        col = 1;
                    } else {
                        col += 1;
                    }
                    value += source[i];
                    i += 1;
                }
            }

            if (i >= source.length) {
                throw new LoadError(`Unterminated string at ${file}:${startPos.line}:${startPos.col}`, NIL);
            }

            col += 1;
            i += 1;
            tokens.push({ kind: 'string', value, pos: startPos });
            continue;
        }

        // Quote and quasiquote: 'x, `x, ,x and ,@x. The token's value is the
        // name of the form the next datum is wrapped in.
        if (ch === "'" || ch === '`' || ch === ',') {
            const splicing = ch === ',' && source[i + 1] === '@';
            const form = ch === "'" ? 'quote' : ch === '`' ? 'quasiquote' : splicing ? 'unquote-splicing' : 'unquote';
            tokens.push({ kind: 'quote', value: form, pos: getPos() });
            const width = splicing ? 2 : 1;
            col += width;
            i += width;
            continue;
        }

        // Tag (:name)
        if (ch === ':') {
            const startPos = getPos();
            col += 1;
            i += 1;

            // Read the symbol following :
            const startSymbol = i;
            while (i < source.length && !/[\s()';"`,]/.test(source[i]!)) {
                i += 1;
                col += 1;
            }

            const symbolName = source.slice(startSymbol, i);
            if (!symbolName) {
                throw new LoadError(`Expected symbol after ':' at ${file}:${startPos.line}:${startPos.col}`, NIL);
            }

            // DECISION: Tag symbol must not match int/float syntax or start with special chars.
            // Reject: `:12`, `:-3`, `:1.5`, `:#foo`, `::foo`, `:'foo`.
            if (/^-?\d+$/.test(symbolName) || /^-?\d+\.\d+([eE][+-]?\d+)?$/.test(symbolName) ||
                    symbolName.startsWith('#') || symbolName.startsWith(':') || symbolName.startsWith("'")) {
                throw new LoadError(`Invalid symbol after ':' at ${file}:${startPos.line}:${startPos.col}`, NIL);
            }

            tokens.push({ kind: 'tag', value: symbolName, pos: startPos });
            continue;
        }

        // Numbers, booleans, symbols
        const startPos = getPos();
        const startIdx = i;

        // Check for #true, #false or other # tokens
        if (ch === '#') {
            col += 1;
            i += 1;
            const rest = [];
            while (i < source.length && !/[\s()';"`,]/.test(source[i]!)) {
                rest.push(source[i]!);
                col += 1;
                i += 1;
            }
            const fullToken = '#' + rest.join('');

            if (fullToken === '#true') {
                tokens.push({ kind: 'bool', value: 'true', pos: startPos });
            } else if (fullToken === '#false') {
                tokens.push({ kind: 'bool', value: 'false', pos: startPos });
            } else {
                throw new LoadError(`Unknown literal '${fullToken}' at ${file}:${startPos.line}:${startPos.col}`, NIL);
            }
            continue;
        }

        // Read the whole token first, then determine its type
        let tokenEnd = i;
        while (tokenEnd < source.length && !/[\s()';"`,]/.test(source[tokenEnd]!)) {
            tokenEnd += 1;
        }

        const token = source.slice(i, tokenEnd);
        col += tokenEnd - i;
        i = tokenEnd;

        // Try to parse as number
        let isInt = false;
        let isFloat = false;

        if (/^-?\d+$/.test(token)) {
            isInt = true;
        } else if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token)) {
            // DECISION: Floats require digits on both sides of decimal, and optional exponent.
            // 1e3, .5, and 5. are not floats per SPEC-CPI section 3: "Floats: ...digits, `.`, digits".
            isFloat = true;
        }

        if (isInt) {
            tokens.push({ kind: 'int', value: token, pos: startPos });
        } else if (isFloat) {
            tokens.push({ kind: 'float', value: token, pos: startPos });
        } else {
            // Symbol
            tokens.push({ kind: 'symbol', value: token, pos: startPos });
        }
    }

    return tokens;
}


// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ParseState = {
    tokens: Token[];
    index: number;
    file: string;
};

export function read(source: string, file: string): Value[] {
    const tokens = tokenize(source, file);
    const state = { tokens, index: 0, file };
    const values: Value[] = [];

    while (state.index < tokens.length) {
        values.push(parseValue(state));
    }

    return values;
}

function parseValue(state: ParseState): Value {
    if (state.index >= state.tokens.length) {
        throw new LoadError(`Unexpected end of input in ${state.file}`, NIL);
    }

    const token = state.tokens[state.index]!;

    switch (token.kind) {
        case 'lparen':
            return parseList(state);

        case 'quote': {
            const pos = token.pos;
            state.index += 1;
            if (state.index >= state.tokens.length) {
                throw new LoadError(`Expected a datum after ${token.value} at ${state.file}:${pos.line}:${pos.col}`, NIL);
            }
            const quoted = parseValue(state);
            // (quote x), (quasiquote x), (unquote x) or (unquote-splicing x),
            // with the position of the ', `, , or ,@
            return cons(sym(token.value), cons(quoted, NIL), pos);
        }

        case 'tag': {
            const pos = token.pos;
            const name = token.value;
            state.index += 1;
            // (quote name) pair with position of :
            return cons(sym('quote'), cons(sym(name), NIL), pos);
        }

        case 'int': {
            state.index += 1;
            try {
                const n = BigInt(token.value);
                if (!fitsInt(n)) {
                    throw new LoadError(
                        `Integer out of 64-bit range at ${state.file}:${token.pos.line}:${token.pos.col}`,
                        NIL
                    );
                }
                return int(n);
            } catch (e) {
                if (e instanceof LoadError) throw e;
                throw new LoadError(
                    `Invalid integer at ${state.file}:${token.pos.line}:${token.pos.col}`,
                    NIL
                );
            }
        }

        case 'float': {
            state.index += 1;
            try {
                const n = parseFloat(token.value);
                if (!isFinite(n)) {
                    throw new LoadError(
                        `Invalid float at ${state.file}:${token.pos.line}:${token.pos.col}`,
                        NIL
                    );
                }
                return floatVal(n);
            } catch {
                throw new LoadError(
                    `Invalid float at ${state.file}:${token.pos.line}:${token.pos.col}`,
                    NIL
                );
            }
        }

        case 'string': {
            state.index += 1;
            return str(token.value);
        }

        case 'bool': {
            state.index += 1;
            return token.value === 'true' ? TRUE : FALSE;
        }

        case 'symbol': {
            state.index += 1;
            return sym(token.value);
        }

        case 'rparen':
            throw new LoadError(
                `Unexpected ')' at ${state.file}:${token.pos.line}:${token.pos.col}`,
                NIL
            );
    }
}

function parseList(state: ParseState): Value {
    const token = state.tokens[state.index];
    if (!token || token.kind !== 'lparen') {
        throw new LoadError(
            `Expected '(' at ${state.file}:${token?.pos.line}:${token?.pos.col}`,
            NIL
        );
    }

    const pos = token.pos;
    state.index += 1;

    // Check for empty list
    if (state.index < state.tokens.length && state.tokens[state.index]!.kind === 'rparen') {
        state.index += 1;
        return NIL;
    }

    // Parse list elements
    const elements: Value[] = [];
    while (state.index < state.tokens.length && state.tokens[state.index]!.kind !== 'rparen') {
        // DECISION: Reject dotted pairs. A `.` token inside a list is a load-error.
        const curToken = state.tokens[state.index]!;
        if (curToken.kind === 'symbol' && curToken.value === '.') {
            throw new LoadError(
                `Dotted pairs are not supported at ${state.file}:${curToken.pos.line}:${curToken.pos.col}`,
                NIL
            );
        }
        elements.push(parseValue(state));
    }

    if (state.index >= state.tokens.length) {
        throw new LoadError(`Unterminated list at ${state.file}:${pos.line}:${pos.col}`, NIL);
    }

    state.index += 1; // consume ')'

    // Build the list from elements
    let result: Value = NIL;
    for (let i = elements.length - 1; i >= 0; i--) {
        result = cons(elements[i]!, result, i === 0 ? pos : null);
    }

    return result;
}
