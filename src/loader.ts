// Loader for CPI code (SPEC-CPI section 9).
// Reads source files, expands them, and evaluates const definitions while building
// the environment.

import { readFileSync } from 'node:fs';

import type { Closure, Env, Pos, Sym, Value } from './types.ts';
import { read } from './reader.ts';
import { expand } from './expander.ts';
import { emptyEnv, fromBindings, composeModule } from './env.ts';
import { listToArray } from './values.ts';
import { LoadError } from './errors.ts';
import { startExpr, run } from './machine.ts';

// ---------------------------------------------------------------------------
// Loading source code
// ---------------------------------------------------------------------------

/**
 * Load source code (a string) and return the resulting environment.
 * Throws LoadError if loading fails.
 */
export function loadSource(source: string, file: string, base: Env = emptyEnv()): Env {
    let env = base;

    // Read the source into a list of Value forms
    let forms: Value[];
    try {
        forms = read(source, file);
    } catch (e) {
        if (e instanceof LoadError) throw e;
        throw new LoadError(`read error in ${file}: ${(e as any).message}`);
    }

    // Expand the forms one at a time, so an expander error can name the
    // position of the top-level form it came from.
    const expanded: Value[] = [];
    for (const form of forms) {
        try {
            expanded.push(...expand([form], 'file'));
        } catch (e) {
            if (!(e instanceof LoadError)) throw e;
            const pos = form.t === 'pair' ? form.pos : null;
            const where = pos ? `${pos.file}:${pos.line}:${pos.col}` : file;
            throw new LoadError(`${where}: ${e.message}`, e.e.payload);
        }
    }

    // Process each expanded form
    for (const form of expanded) {
        try {
            env = loadTopLevelForm(form, file, env);
        } catch (e) {
            if (e instanceof LoadError) throw e;
            throw new LoadError(`error loading ${file}: ${(e as any).message}`);
        }
    }

    return env;
}

/**
 * Load a single top-level form (after expansion).
 * Returns the updated environment.
 */
function loadTopLevelForm(form: Value, file: string, env: Env): Env {
    if (form.t !== 'pair') {
        throw new LoadError(`top-level form must be (defun ...) or (const ...)`, form);
    }

    const elements = listToArray(form);
    if (elements === null) {
        throw new LoadError(`top-level form must be a proper list`, form);
    }

    if (elements.length < 1) {
        throw new LoadError(`top-level form must be (defun ...) or (const ...)`, form);
    }

    const head = elements[0]!;
    if (head.t !== 'sym') {
        throw new LoadError(`top-level form must be (defun ...) or (const ...)`, form);
    }

    if (head.name === 'defun') {
        return loadDefun(elements, file, env, form.pos);
    } else if (head.name === 'const') {
        return loadConst(elements, file, env, form.pos);
    } else {
        throw new LoadError(`top-level form must be (defun ...) or (const ...), got (${head.name} ...)`, form);
    }
}

/**
 * Load a defun: create a closure with empty scope and group: null.
 * Elements are [sym('defun'), name, paramsForm, ...body]
 */
function loadDefun(elements: Value[], file: string, env: Env, pos: Pos | null): Env {
    if (elements.length < 3) {
        throw new LoadError(`(defun ...) must have at least 3 elements`, elements[0]!);
    }

    const name = elements[1]!;
    if (name.t !== 'sym') {
        throw new LoadError(`defun name must be a symbol`, name);
    }

    const paramsForm = elements[2]!;
    const paramsArray = listToArray(paramsForm);
    if (paramsArray === null) {
        throw new LoadError(`defun parameter list must be a list`, paramsForm);
    }

    const params = paramsArray as Sym[];
    const bodyElements = elements.slice(3);

    const closure: Closure = {
        t: 'closure',
        name: name as Sym,
        params,
        body: bodyElements,
        scope: null,
        group: null,
    };

    // Compose the closure into the environment
    const closureEnv = fromBindings([[name.name, closure]]);
    const result = composeModule(env, closureEnv);

    if (!result.ok) {
        const posStr = pos ? `${pos.file}:${pos.line}:${pos.col}` : file;
        throw new LoadError(`${posStr}: duplicate definition(s): ${result.conflicts.join(', ')}`, elements[0]!);
    }

    return result.env;
}

/**
 * Load a const: evaluate its expression and add the resulting value to the environment.
 * Elements are [sym('const'), name, expr]
 */
function loadConst(elements: Value[], file: string, env: Env, pos: Pos | null): Env {
    if (elements.length < 3) {
        throw new LoadError(`(const ...) must have at least 3 elements`, elements[0]!);
    }

    const name = elements[1]!;
    if (name.t !== 'sym') {
        throw new LoadError(`const name must be a symbol`, name);
    }

    const expr = elements[2]!;

    // Evaluate the expression in the current environment
    const s0 = startExpr(expr, env);
    let state = s0;

    // Run the machine with large batches until it stops
    while (state.mode.m !== 'done' && state.mode.m !== 'failed' && state.mode.m !== 'host') {
        state = run(state, 100_000);
    }

    // Check the final mode
    if (state.mode.m === 'host') {
        const posStr = pos ? `${pos.file}:${pos.line}:${pos.col}` : file;
        throw new LoadError(
            `${posStr}: host request not allowed during loading (${state.mode.ns}::${state.mode.action})`,
            elements[0]!
        );
    }

    if (state.mode.m === 'failed') {
        const posStr = pos ? `${pos.file}:${pos.line}:${pos.col}` : file;
        const e = state.mode.e;
        throw new LoadError(
            `${posStr}: const evaluation failed: ${e.tag.name}: ${e.message}`,
            e,
            e
        );
    }

    // Get the value from done mode
    if (state.mode.m !== 'done') {
        throw new LoadError(`unexpected state after evaluation`, elements[0]!);
    }

    const value = state.mode.v;

    // Compose the value into the environment
    const valueEnv = fromBindings([[name.name, value]]);
    const result = composeModule(env, valueEnv);

    if (!result.ok) {
        const posStr = pos ? `${pos.file}:${pos.line}:${pos.col}` : file;
        throw new LoadError(`${posStr}: duplicate definition(s): ${result.conflicts.join(', ')}`, elements[0]!);
    }

    return result.env;
}

/**
 * Load multiple files in order, building one environment.
 * Throws LoadError if any file fails to load.
 */
export function loadFiles(paths: string[]): Env {
    let env = emptyEnv();

    for (const path of paths) {
        let source: string;
        try {
            source = readFileSync(path, 'utf-8');
        } catch (e) {
            throw new LoadError(`failed to read file ${path}: ${(e as any).message}`);
        }

        env = loadSource(source, path, env);
    }

    return env;
}
