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

- `src/reader.ts`: floats need digits on both sides of `.` (`.5`, `5.`, `1e3` read as symbols).
- `src/reader.ts`: a tag's name must not match int/float syntax or start with `#`, `:` or `'`.
- `src/reader.ts`: a `.` token inside a list is a `load-error` (no dotted pairs).
- `src/reader.ts`: only the first pair of a list carries the list's position; the other spine pairs have `pos: null`.
- `src/expander.ts`: an eta-expanded core operation's lambda has `pos: null` (symbols carry no position).
- `src/expander.ts`: in `'expr'` mode each form is one expression, not a body, so a bare top-level `let` or `defun` is a `load-error`; wrap it in `(do ...)`.
- `src/env.ts`: identity for composition is `===`, or atoms of the same type and value.
- `src/env.ts` (manager): `composeModule` flags any conflicted slot the composition created or changed, including a third definition added to an already-conflicted name.
- `src/printer.ts` (manager): error messages inside `#<error tag "...">` are escaped like strings.
- `src/core.ts` (manager review): `throw` does not check already-thrown; the machine applies that rule so it can set the new error's context.

## Spec issues

- SPEC-CPI section 1 says the CPI "is granted the privileged namespaces in section 8"; they are listed in section 10. Editorial.
- SPEC-CPI section 2.3 calls tag, message, payload and cause "three visible fields". There are four. Editorial.
