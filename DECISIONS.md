# Decisions

Decisions made while building the CPI prototype. Sources of truth, in order:
`../../design-xxx/DESIGN-001.md`, `../../design-xxx/SPEC-CPI.md`, the prototype
choices in `prompt.md`, then the simplest consistent behavior.

## Prototype decisions

- Integers are `bigint`, checked to fit 64 bits; floats are JS numbers.
- Strings are JS strings; `string-length` and `string-ref` count Unicode scalar values.
- Addresses come from a counter: unique, not unguessable.
- Binding hash: SHA-256 over resolved names in sorted order with the printed form of each value.
- Time is virtual (milliseconds from 0); `host::wait` returns `()` at once when nothing is pending.
- `IO::print` writes its arguments separated by spaces plus a newline, using `display`.
- `process::`, `mailbox::`, `host::`, `environment::` are privileged; `actor::`, `IO::`, `timer::` are ordinary. Granting a privileged namespace to a process throws `not-granted`.
- Every `step` in `process::run` is one tick; servicing a host request costs nothing.
- Messages sent during a batch are buffered and delivered when the batch ends.
- Lifecycle: watchers receive `(signal terminated <pid> <reason>)`; no other signals.
- Dead letters are kept in an array of `{ from, to, msg }`; nothing reads them yet.
- A `const` expression that reaches a host request is a `load-error`.
- Unknown trace positions are file `""`, line `0`, column `0`.
- `npm install` worked, so workers use `npx tsc`.

## Worker decisions

## Spec issues
