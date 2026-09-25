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
- Host mode carries the request's local scope (SPEC-CPI section 8's `Host(ns, action, args, L)`), and a `ThrowK` frame carries the site and scope of the host request it answers, so handler errors get a trace entry and a pad at the request. The machine exports `resumeValue` and `resumeThrow` to build them.
- `process::state` always returns a list: `(ready)`, `(blocked recv)`, `(blocked join <pid>)`, `(blocked host)`, `(trapped)`, `(parked)`, `(ended exited <v>)`, `(ended failed <e>)`, `(ended killed <reason>)`.
- Parked state is the list `(parked <key> <checkpoint-args> <binding-hash> <address>)`. The continuation itself stays in a runtime table under the integer `<key>`, because frames are not language values. `process::unpark` checks the shape and the key, else `type-error`. The same data may be unparked more than once.
- A trap stop reason is `(trap <effect> <args>)` with `<args>` a list, e.g. `(trap send (<addr> <msg>))`. Trappable effects are the `actor::` actions `recv`, `send`, `self` and `join`.
- `IO::print` and `timer::sleep` return `()`.
- A mailbox made by `process::spawn` with `#false` is non-durable with capacity 1000.
- Sends by the CPI (`mailbox::send`) are delivered at once; the CPI is not in a batch. Sends by a process during `process::run` are buffered and delivered when the batch ends.
- A terminated signal to a watcher is appended to its mailbox like any message (signals are not reordered ahead of messages yet). A PID watcher is sent to its process's mailbox.
- `actor::` requests from the CPI throw `bad-state`: the CPI has no process layer (SPEC-CPI section 1). `timer::sleep` in the CPI advances the virtual clock at once.
- `host::wait` with nothing pending returns `()` at once. With a timeout shorter than the earliest deadline, it advances the clock by the timeout and returns `()`.

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
- `src/machine.ts`: `Eval((do rest …), L)` after LetK, SeqK, a defun group or a closure application is folded into the step that produces it instead of building a `(do …)` pair. Tick counts are therefore lower than a literal reading of section 7.3; each step still does bounded work.
- `src/machine.ts`: a bare symbol or literal has no position, so its site carries the enclosing expression's position.
- `src/machine.ts`: entering a closure body starts the site `{ fn: <closure name>, pos: null }`; body expressions then use their own positions.
- `src/machine.ts`: `seq` and `let` frames record the site of the expression they wait on, so trace entries point at the waiting line.
- `src/machine.ts`: errors the machine raises itself (arity, applying a non-procedure, `apply`'s type checks) have payload `()`.

## Spec issues

- SPEC-CPI section 1 says the CPI "is granted the privileged namespaces in section 8"; they are listed in section 10. Editorial.
- SPEC-CPI section 2.3 calls tag, message, payload and cause "three visible fields". There are four. Editorial.
