import type { Value } from './types.ts';

/**
 * print(v: Value): string
 * Shows strings quoted with their escapes.
 * Formats:
 * - #true, #false, ()
 * - Integers in decimal
 * - Floats always show a . or exponent; NaN/inf as +nan.0, +inf.0, -inf.0
 * - Symbol as its name
 * - Proper list as (a b c), improper tail as (a b . c)
 * - (quote x) stays as (quote x) - no abbreviation
 * - Other values: #<procedure name>, #<error tag "message">, #<address id>, #<pid n>, #<env>
 */
export function print(v: Value): string {
    return formatValue(v, true);
}

/**
 * display(v: Value): string
 * Same as print, except strings appear raw without quotes.
 */
export function display(v: Value): string {
    return formatValue(v, false);
}

function formatValue(v: Value, quoted: boolean): string {
    switch (v.t) {
        case 'bool':
            return v.v ? '#true' : '#false';

        case 'nil':
            return '()';

        case 'int':
            return v.v.toString();

        case 'float':
            return formatFloat(v.v);

        case 'str':
            if (quoted) {
                return '"' + escapeString(v.v) + '"';
            } else {
                return v.v;
            }

        case 'sym':
            return v.name;

        case 'pair':
            return formatList(v, quoted);

        case 'closure':
            if (v.name === null) {
                return '#<procedure>';
            } else {
                return `#<procedure ${v.name.name}>`;
            }

        case 'error':
            return `#<error ${v.tag.name} "${escapeString(v.message)}">`;

        case 'addr':
            return `#<address ${v.id}>`;

        case 'pid':
            return `#<pid ${v.id}>`;

        case 'env':
            return '#<env>';
    }
}

function formatFloat(v: number): string {
    // Special float values
    if (Number.isNaN(v)) {
        return '+nan.0';
    }
    if (!Number.isFinite(v)) {
        return v > 0 ? '+inf.0' : '-inf.0';
    }

    // Handle negative zero specially: Object.is(v, -0) checks for -0.0
    if (Object.is(v, -0)) {
        return '-0.0';
    }

    // Regular float formatting
    const str = v.toString();

    // If it already has 'e' in it (exponential notation), we're done
    if (str.includes('e')) {
        // Ensure there's a sign in the exponent
        return formatExponent(str);
    }

    // Otherwise, ensure it has a decimal point
    if (!str.includes('.')) {
        return str + '.0';
    }

    return str;
}

function formatExponent(s: string): string {
    // Format: 1e21 -> 1e+21, 1e-10 -> 1e-10
    const parts = s.split('e');
    if (parts.length !== 2) return s;

    const mantissa = parts[0]!;
    const exponent = parts[1]!;

    // Add + if not present and not negative
    const formattedExp = exponent.startsWith('+') || exponent.startsWith('-')
        ? exponent
        : '+' + exponent;

    return mantissa + 'e' + formattedExp;
}

function escapeString(s: string): string {
    let result = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        switch (c) {
            case '"':
                result += '\\"';
                break;
            case '\\':
                result += '\\\\';
                break;
            case '\n':
                result += '\\n';
                break;
            case '\t':
                result += '\\t';
                break;
            default:
                result += c;
        }
    }
    return result;
}

function formatList(v: Value, quoted: boolean): string {
    // Collect all elements in the proper list part, and detect if improper
    const elements: Value[] = [];
    let current: Value = v;
    let improperTail: Value | null = null;

    while (current.t === 'pair') {
        elements.push(current.car);
        current = current.cdr;
    }

    // current is now either nil (proper list) or something else (improper)
    if (current.t !== 'nil') {
        improperTail = current;
    }

    // Format the list
    const formattedElements = elements.map(el => formatValue(el, quoted));

    if (improperTail === null) {
        // Proper list
        return '(' + formattedElements.join(' ') + ')';
    } else {
        // Improper list
        const tail = formatValue(improperTail, quoted);
        if (formattedElements.length === 0) {
            // This shouldn't happen in normal code, but handle it
            return '(' + tail + ')';
        }
        return '(' + formattedElements.join(' ') + ' . ' + tail + ')';
    }
}
