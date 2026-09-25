// Error construction. Owned by the manager, like types.ts.

import type { ErrorValue, Result, Value } from './types.ts';
import { NIL, sym } from './values.ts';

// The runtime's error tags (SPEC-CPI section 2.3).
export type RuntimeTag =
  | 'type-error' | 'arity-error' | 'unbound' | 'overflow' | 'divide-by-zero' | 'range-error'
  | 'not-granted' | 'unknown-action' | 'bad-state' | 'full' | 'load-error' | 'already-thrown';

// A new, never-thrown error.
export function makeError(tag: string, message: string, payload: Value = NIL, cause: ErrorValue | null = null): ErrorValue {
  return { t: 'error', tag: sym(tag), message, payload, cause, box: { ctx: null } };
}

export const ok = (v: Value): Result => ({ ok: true, v });
export const fail = (tag: RuntimeTag, message: string, payload: Value = NIL): Result =>
  ({ ok: false, e: makeError(tag, message, payload) });

// Thrown (as a JS exception) by the reader, expander and loader. `e` has tag load-error.
export class LoadError extends Error {
  readonly e: ErrorValue;
  constructor(message: string, payload: Value = NIL) {
    super(message);
    this.e = makeError('load-error', message, payload);
  }
}
