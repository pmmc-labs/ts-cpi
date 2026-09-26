#!/usr/bin/env node

// The CPI: the control plane interpreter. Loads code from files and runs (main).
// Usage: node bin/cpi.ts file.slight ...
// Exit codes: 0 when main finishes, 1 when main fails, 2 on a load error.

import type { ErrorValue } from '../src/types.ts';
import { loadFiles } from '../src/loader.ts';
import { LoadError } from '../src/errors.ts';
import { print } from '../src/printer.ts';
import { traceEntries } from '../src/core.ts';
import { listToArray } from '../src/values.ts';
import { Runtime } from '../src/runtime.ts';

async function main(): Promise<number> {
    const paths = process.argv.slice(2);
    if (paths.length === 0) {
        console.error('usage: cpi file.slight ...');
        return 2;
    }

    let env;
    try {
        env = loadFiles(paths);
    } catch (e) {
        if (!(e instanceof LoadError)) throw e;
        printError(e.e);
        return 2;
    }

    const runtime = new Runtime({ out: (line) => process.stdout.write(line + '\n') });
    const result = await runtime.boot(env);
    if (!result.ok) {
        printError(result.e);
        return 1;
    }
    return 0;
}

// Prints an error, its trace, and each error in its cause chain, to stderr.
function printError(e: ErrorValue): void {
    let cur: ErrorValue | null = e;
    let first = true;
    while (cur !== null) {
        if (!first) console.error('caused by:');
        console.error(print(cur));
        for (const entry of listToArray(traceEntries(cur)) ?? []) {
            const [name, file, line, col] = listToArray(entry) ?? [];
            const nameStr = name?.t === 'sym' ? name.name : '<anonymous>';
            const fileStr = file?.t === 'str' ? file.v : '';
            console.error(`  at ${nameStr} (${fileStr}:${line?.t === 'int' ? line.v : 0}:${col?.t === 'int' ? col.v : 0})`);
        }
        cur = cur.cause;
        first = false;
    }
}

// A closed pipe (e.g. `| head`) ends the output; it is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
});

process.exitCode = await main();
