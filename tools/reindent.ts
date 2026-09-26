// Re-indents the ts-cpi prototype to 4 spaces.
//
//   node tools/reindent.ts <file> ...
//
// - .ts: each line's leading spaces are doubled (a JSDoc ` *` keeps its odd
//   space). Lines inside a multi-line template literal are string content:
//   CPI source there is re-indented as CPI code, anything else is doubled.
// - .slight: CPI code is re-indented to 4 spaces per open parenthesis.
// - .md: the same, for ```lisp fences at column 0.
// - .json: re-serialized with 4-space indentation.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

const double = (n: number): number => 2 * (n - (n % 2)) + (n % 2);
const lead = (s: string): number => s.length - s.trimStart().length;

// 4 spaces per paren open at the start of the line. Strings and comments do
// not count.
export function reindentLisp(lines: string[]): string[] {
    let depth = 0;
    return lines.map((line) => {
        const text = line.trim();
        const out = text === '' ? '' : ' '.repeat(4 * Math.max(depth, 0)) + text;
        let inStr = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                if (c === '\\') i++;
                else if (c === '"') inStr = false;
            } else if (c === '"') inStr = true;
            else if (c === ';') break;
            else if (c === '(') depth++;
            else if (c === ')') depth--;
        }
        return out;
    });
}

const looksLisp = (lines: string[]): boolean => {
    const first = lines.find((l) => l.trim() !== '');
    return first !== undefined && /^[(;]/.test(first.trim());
};

function reindentTs(text: string, file: string): string {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    // Character ranges of template literal text (start of literal .. end).
    const templates: Array<[number, number]> = [];
    const visit = (n: import('typescript').Node): void => {
        if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
            templates.push([n.getStart(sf), n.getEnd()]);
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);

    const lines = text.split('\n');
    const starts: number[] = [];
    let off = 0;
    for (const l of lines) { starts.push(off); off += l.length + 1; }
    const inTemplate = (pos: number): [number, number] | undefined =>
        templates.find(([a, b]) => pos > a && pos < b);

    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const t = inTemplate(starts[i]!);
        if (t === undefined) {
            const n = lead(lines[i]!);
            out.push(lines[i]!.trim() === '' ? '' : ' '.repeat(double(n)) + lines[i]!.slice(n));
            i++;
            continue;
        }
        // A run of lines inside one template literal. The last may close it.
        const run: string[] = [];
        while (i < lines.length && inTemplate(starts[i]!) === t) run.push(lines[i++]!);
        const opening = out[out.length - 1]!;
        const base = lead(opening) + 4;
        const last = run[run.length - 1]!;
        const closes = /^\s*`/.test(last);
        const content = closes ? run.slice(0, -1) : run;
        if (looksLisp(content)) {
            for (const l of reindentLisp(content)) out.push(l === '' ? '' : ' '.repeat(base) + l);
        } else {
            for (const l of content) out.push(l.trim() === '' ? l : ' '.repeat(double(lead(l))) + l.trimStart());
        }
        if (closes) out.push(' '.repeat(double(lead(last))) + last.trimStart());
    }
    return out.join('\n');
}

function reindentMarkdown(text: string): string {
    const lines = text.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        out.push(lines[i]!);
        if (lines[i] === '```lisp') {
            const body: string[] = [];
            i++;
            while (lines[i] !== '```') body.push(lines[i++]!);
            out.push(...reindentLisp(body));
            out.push(lines[i]!);
        }
        i++;
    }
    return out.join('\n');
}

for (const file of process.argv.slice(2)) {
    const text = readFileSync(file, 'utf8');
    let next: string;
    if (file.endsWith('.ts')) next = reindentTs(text, file);
    else if (file.endsWith('.slight')) next = reindentLisp(text.split('\n')).join('\n');
    else if (file.endsWith('.md')) next = reindentMarkdown(text);
    else if (file.endsWith('.json')) next = JSON.stringify(JSON.parse(text), null, 4) + '\n';
    else throw new Error(`unknown file type: ${file}`);
    if (next !== text) {
        writeFileSync(file, next);
        console.log('reindented', file);
    }
}
