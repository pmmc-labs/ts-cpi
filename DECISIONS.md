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
- PIDs are interned like symbols, so every PID value for one process is the same object and `eq?` holds (before, PIDs returned by `host::wait` were fresh objects).

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
- `src/builtins.ts`: `IO::print` is variadic; its declared arity is `'any'`, the one action exempt from the arity check.
- `src/runtime.ts`: when the CPI fails (section 12), every live process ends as `(killed ())`.
- `src/runtime.ts`: a parked process's grants are kept in the runtime's park table (not in the parked value), so `process::unpark` restores them.
- `src/runtime.ts`: `environment::error-pad` on a never-thrown error is `range-error` (there is no trace entry); `error-env` is `bad-state` as the spec says.
- `src/runtime.ts`: capacity for a process's buffered sends is reserved at send time, so `full` reaches the sender in the same batch.
- `src/runtime.ts` (manager): `host::wait` never moves the clock backward (the CPI's own `timer::sleep` may already have passed a deadline).
- `src/loader.ts`: load-error messages are prefixed with `file:line:col` of the top-level form; a failing `const`'s load-error has the thrown error as both payload and cause, so the CLI prints its trace.
- `bin/cpi.ts` (manager): prints the error, one `at name (file:line:col)` line per trace entry, then each cause under `caused by:`.
- `IO::print` uses `display` all the way down, so strings inside printed lists also appear without quotes.
- `tests/programs/scheduler.slight`: both mailboxes are created before spawning, so each player knows the other's address. The expected output was captured from a run, not simulated by hand. The program prints each full stop reason (manager change).
- `tests/programs/tailcalls.slight`: the spawned loop runs with a quota of 20,000,000. One iteration costs about 18 ticks, because every step is metered.
- `tests/programs/timers.slight`: `host::now` is called from the CPI, not from the actors, because `host::` is privileged.
- `tests/programs/parking.slight`: the address is read with `process::address` before parking (it is `bad-state` afterwards).
- `tests/programs/traps.slight`: the CPI resumes a trapped send with `#true`, what `actor::send` returns.

## Spec issues

- SPEC-CPI section 1 says the CPI "is granted the privileged namespaces in section 8"; they are listed in section 10. Editorial.
- SPEC-CPI section 2.3 calls tag, message, payload and cause "three visible fields". There are four. Editorial.
- SPEC-CPI section 10.1 says `process::park` returns "plain data: its continuation…", but no value type in section 2.1 can hold a continuation or frame. The prototype keeps the continuation in a runtime table and returns a key (see Prototype decisions). DESIGN-001 section 6 (frames are plain, content-addressed data) suggests frames should become values, or be stored in the store and referenced by hash.
- SPEC-CPI section 8 says each namespace declares actions "and their arities", and a mismatched count is an `arity-error`. `IO::print` is used with any number of arguments (prototype choices), so the prototype allows a variadic arity for it alone.
- SPEC-CPI section 10.1 describes `process::state` as "the state as a symbol, plus detail" without fixing the shape of states that have no detail. The prototype always returns a list.
- SPEC-CPI section 7.5 records one trace entry per frame in `K`. Two frames can wait on the same expression, for example `(let r (catch …))`, where the `let` frame and the `catch` frame both sit at the `catch`. The trace then shows the same entry twice. This follows the spec literally; the spec may want entries collapsed, or per-procedure entries only.
- An ordinary process cannot read the time: `host::now` is in the privileged `host::` namespace, and `timer::` has only `sleep` in the prototype. SPEC-CPI section 10.5 leaves other namespaces to their subsystems, so this is a gap rather than a contradiction.
- SPEC-CPI section 11 counts every `step` as a tick, and section 7.3's `Eval((do rest …))` transitions make tick counts depend on how literally the table is read. Quotas are therefore implementation-defined until the spec fixes a canonical step count per form.
- The language cannot build an environment with a new or replaced binding: every env ref derives from `environment::self`. `process::set-env`, and the hot reload of SPEC-CPI section 6 and DESIGN-001 section 8, therefore can't be driven from control plane code (`examples/life/20-rule-swap.slight`). DESIGN-001 has patches come from the pipeline, which is not specified yet.
- SPEC-CPI does not say what happens when several live processes receive on one address (spawning onto a live process's mailbox, or unparking one parked value twice). The prototype lets the newest process own it, and a non-durable mailbox dead-letters sends once that owner ends, even if others still wait on it.
- The CPI has no way to wait for a particular process: `actor::join` and `actor::recv` are not available to it (SPEC-CPI section 1), and `host::wait` reports which PIDs woke but not why.
- Nothing in SPEC-CPI reclaims ended processes or parked state: the process table and the park table only grow.

