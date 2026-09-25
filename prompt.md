# Build the CPI prototype

You are the **manager** of a small team building a prototype of the slight control plane interpreter (CPI) in TypeScript. Run this session on Opus. Your workers are Sonnet and Haiku subagents, defined in `.claude/agents/`. You dispatch their tasks, answer their questions, integrate their work, and commit it.

**Start now.** This prompt is the plan, and the spec is the design. Do not brainstorm, write a plan, or ask the user to confirm anything. Do not invoke planning or process skills (brainstorming, writing-plans, executing-plans, subagent-driven-development, test-driven-development). These instructions come from the user and take precedence over any skill that says otherwise. If something is unclear, decide it using the rules under Answering questions, record it in `DECISIONS.md`, and keep going. Leave the user a list of anything worth their attention in the final report.

The philosophy for this stage: **keep it simple and solid now, and build on it later.** Prefer the obvious implementation. Do not optimize, generalize or add features the spec does not ask for.

## Sources of truth

In order of precedence:

1. `../../design-xxx/DESIGN-001.md`: the design. It wins any conflict.
2. `../../design-xxx/SPEC-CPI.md`: the specification you are implementing. Every section applies except where this prompt narrows scope.
3. **Prototype choices** in this prompt: decisions that belong to the prototype, not the spec.
4. The simplest behavior consistent with the above.

`../../design-xxx` is a git repository. Do not edit it. If you find a real contradiction in the spec, record it in `DECISIONS.md` under **Spec issues** and pick the reading closest to DESIGN-001.

## What already exists

These files are written and type-check. They belong to you; workers must not edit them.

| File | Contents |
| --- | --- |
| `src/types.ts` | The shared contract: values, scopes, environments, frames, continuations, machine state, core-operation shape. |
| `src/values.ts` | Constructors and helpers: `sym` (interned), `gensym`, `NIL`, `TRUE`, `FALSE`, `bool`, `int` (64-bit checked), `fitsInt`, `float`, `str`, `cons`, `list`, `listToArray`, `newAddr`, `pid`, `isFalse`. |
| `src/errors.ts` | `makeError`, `ok`, `fail`, the runtime tag list, and `LoadError` (a JS exception carrying a `load-error` value). |
| `src/names.ts` | `CORE_ARITY`, `SPECIAL_FORMS`, `DERIVED_FORMS`, `isCoreName`, `isHostName`, `isReserved`. |
| `package.json`, `tsconfig.json` | Node runs `.ts` directly (no build step). `npm run check` type-checks; `npm test` runs `tests/**/*.test.ts`. |
| `.claude/agents/cpi-*.md` | The three worker types, with the rules every worker follows. |

If a worker needs a change to one of your files, make it yourself, check it still type-checks, and tell every running worker it affects.

## Setup (do this first, then dispatch Wave 1)

1. `git init`, add a `.gitignore` with `node_modules/` and `.DS_Store`, and commit the scaffold.
2. `npm install`. If it cannot reach the network, use `../ts-slight/node_modules/.bin/tsc` for type checks instead of `npx tsc`, and tell the workers so in their briefs.
3. Create `DECISIONS.md` with the headings **Prototype decisions**, **Worker decisions** and **Spec issues**.

## Prototype choices

These settle what the spec leaves to an implementation. Include the relevant ones in each brief (the briefs below already do).

- **Integers** are `bigint`, always checked to fit 64 bits (`fitsInt`). Floats are JS numbers.
- **Strings** are JS strings. `string-length` and `string-ref` count Unicode scalar values (iterate with `[...s]`). O(n) is fine.
- **Addresses** come from a counter (`newAddr`). They are unique, not unguessable, and `values.ts` says so.
- **Binding hash**: SHA-256 (`node:crypto`) over the environment's resolved names in sorted order, each with the printed form of its value. For a closure, print its name, parameters and body.
- **Time is virtual.** The runtime keeps a virtual clock in milliseconds, starting at 0. `host::now` reads it. `(timer::sleep ms)` blocks the process until the clock reaches now + `ms`. `host::wait` advances the clock to the earliest pending deadline (or to the timeout, if that comes first), completes what is due, and returns the PIDs that became ready. If nothing is pending, `host::wait` returns `()` at once instead of hanging. Nothing in the prototype uses real time or real async I/O, so every run is deterministic.
- **Output**: `(IO::print v ...)` writes its arguments separated by spaces, followed by a newline, to the runtime's output sink: stdout in the CLI, an array in tests. Strings print without quotes; everything else prints as `printer.ts` shows it.
- **Namespaces**: `process::`, `mailbox::`, `host::` and `environment::` are privileged. `actor::`, `IO::` and `timer::` are ordinary. The CPI is granted all of them. A process gets the list of namespace symbols passed to `process::spawn`, for example `'(actor IO timer)`. It may not be granted a privileged one: that throws `not-granted`.
- **Ticks**: in `process::run`, every `step` counts one tick. Servicing a host request is not a step and costs nothing.
- **Delivery timing**: messages sent during a batch are buffered and delivered when the batch ends, so they are visible to their receivers at their next turn.
- **Lifecycle signals**: a watcher address receives the message `(signal terminated <pid> <reason>)` when the watched process ends, where `<reason>` is the process's stop detail, `(exited v)`, `(failed e)` or `(killed r)`. Other signals are not implemented.
- **Dead letters**: the runtime keeps them in an array of `{ from, to, msg }`. Nothing reads them yet.
- **Loading** (SPEC-CPI section 9): a `const` expression may not make host requests. If evaluating one reaches a host request, that is a `load-error`.
- **Unknown positions** in a trace entry are written as file `""`, line `0` and column `0`.

## Code layout and ownership

| File | Owner | Wave |
| --- | --- | --- |
| `src/types.ts`, `src/values.ts`, `src/errors.ts`, `src/names.ts` | you | done |
| `src/reader.ts`, `tests/reader.test.ts` | Task R | 1 |
| `src/printer.ts`, `tests/printer.test.ts` | Task P | 1 |
| `src/core.ts`, `tests/core.test.ts` | Task C | 1 |
| `src/env.ts`, `tests/env.test.ts` | Task E | 1 |
| `src/expander.ts`, `tests/expander.test.ts` | Task X | 1 |
| `src/machine.ts`, `tests/machine.test.ts` | Task M | 2 |
| `src/runtime.ts`, `src/builtins.ts`, `tests/runtime.test.ts` | Task T | 3 |
| `src/loader.ts`, `bin/cpi.ts`, `tests/loader.test.ts` | Task L | 3 |
| `tests/programs/*.slight`, `tests/acceptance.test.ts` | Task A | 4 |
| `DECISIONS.md`, `README.md` | you | throughout |

The worker types and their settings:

| Agent | Model | Effort | Used for |
| --- | --- | --- | --- |
| `cpi-haiku` | Haiku | default | R, P, C, E, L: small modules that the spec pins down closely |
| `cpi-sonnet` | Sonnet | medium | X, A: the expander and the acceptance programs |
| `cpi-sonnet-deep` | Sonnet | high | M, T: the evaluator and the runtime, where correctness is subtle |

## How to run a wave

1. Dispatch every task in the wave **in one message**, one `Agent` call per task, with `subagent_type` set to the task's agent. The prompt is the task's brief, copied from below and filled in. Workers run in the background, and you are notified as each one finishes. Do not poll.
2. While they work, answer any question a worker sends back with `SendMessage` to that worker, so it continues with its context intact.
3. When every worker in the wave has reported:
   - run `npm run check` and `npm test`;
   - fix small integration problems yourself, such as a mismatched import or a signature. Send anything larger back to the worker that owns the file, with `SendMessage`;
   - copy each worker's `// DECISION:` lines into `DECISIONS.md` under **Worker decisions**, with the file each came from. If you disagree with one, have it changed;
   - commit, with a message naming the wave and the modules.
4. Start the next wave only when the type check and the tests pass.

## Answering questions

Workers are told to decide small things themselves and to ask only when a choice changes an interface another worker depends on. When one asks:

- Answer from the spec, then DESIGN-001, then the prototype choices, then the simplest option. Answer at once and decisively. A worker is waiting.
- If the answer changes an interface, update the relevant brief text and tell any affected worker that is still running.
- Record the answer in `DECISIONS.md`.

## Testing

TDD, in proportion. Each worker writes a few focused tests for a behavior before implementing it, and covers the main behavior plus the error cases the spec names. Do not push for exhaustive coverage. This is an early prototype. The acceptance programs in Wave 4 are the real check that the pieces compose.

---

## Wave 1: parallel, no dependencies between tasks

### Task R: reader (`cpi-haiku`)

> **Task R: the reader.** You own `src/reader.ts` and `tests/reader.test.ts`. Read SPEC-CPI section 3, and section 2.1 for the literal forms.
>
> Export `read(source: string, file: string): Value[]`. It returns the top-level forms in order and throws `LoadError` (from `src/errors.ts`) on any syntax error, with a message that includes the file, line and column.
>
> - Every pair you build carries the `Pos` of its opening `(` in `pos`, with lines and columns starting at 1. For `'x` and `:x`, the `(quote x)` pair gets the position of the `'` or `:`.
> - Integers become `int(...)`. A literal outside 64 bits is a `LoadError`. Floats need a `.` with digits on both sides, and an optional exponent.
> - Strings accept only the escapes `\"`, `\\`, `\n`, `\t` and `\u{hex}`.
> - `#true` and `#false` are booleans. Any other token starting with `#` is a `LoadError`, so source text can never spell a `gensym` name (`#:...`).
> - `:name` reads as `(quote name)`. A lone `:`, or `:` followed by something that is not a valid symbol, is a `LoadError`.
> - `;` comments run to the end of the line. A dot inside a list, meaning a dotted pair, is a `LoadError`. A symbol may contain `::`: the reader does not treat it specially.
>
> Test at least: each literal kind, nested lists with positions, `'x` and `:x`, comments, and each error case above.

### Task P: printer (`cpi-haiku`)

> **Task P: the printer.** You own `src/printer.ts` and `tests/printer.test.ts`. Read SPEC-CPI section 2.
>
> Export `print(v: Value): string`, which shows strings quoted with their escapes, and `display(v: Value): string`, which is the same except that strings appear raw. `IO::print` uses `display`.
>
> Formats:
> - `#true`, `#false`, `()`.
> - Integers in decimal. Floats always show a `.` or an exponent (`1.0`, `0.5`, `1e+21`), and `NaN`, `+inf` and `-inf` print as `+nan.0`, `+inf.0` and `-inf.0`.
> - A symbol prints as its name.
> - A proper list prints as `(a b c)`. An improper tail prints as `(a b . c)`.
> - `(quote x)` prints as `(quote x)`: the printer does not abbreviate.
> - Other values: `#<procedure name>` (or `#<procedure>` when anonymous), `#<error tag "message">`, `#<address id>`, `#<pid n>` and `#<env>`.
>
> Test each format.

### Task C: core operations (`cpi-haiku`)

> **Task C: core operations.** You own `src/core.ts` and `tests/core.test.ts`. Read SPEC-CPI sections 2.2, 2.3 and 5 in full. `src/names.ts` lists every operation and its arity.
>
> Export:
> - `CORE: ReadonlyMap<string, CoreOp>`, with an entry for every name in `CORE_ARITY` and the same arity. Each `fn` returns `ok(v)` or `fail(tag, message, payload)`. `apply`'s `fn` is never called (the machine handles `apply`), so make it return a `fail('type-error', ...)`.
> - `eq(a: Value, b: Value): boolean`, the rules for `eq?`.
> - `traceEntries(e: ErrorValue): Value`, the trace of `e` as a list, innermost first. Entry 0 comes from `e.box.ctx.site`. Then comes one entry per frame of `e.box.ctx.K`, from the top, skipping `val` and `throw` frames, which have no site. Each entry is `(name file line column)`, with `name` a symbol or `#false`. An unknown position is file `""`, line `0` and column `0`. It returns `()` if `ctx` is null. `stack-trace-for` uses it, and the runtime will too.
>
> Key rules:
> - Arithmetic needs both integers or both floats, else `type-error`. Integer results are checked with `fitsInt`, else `overflow`. Integer `/` truncates toward zero, and integer `/` or `%` by zero is `divide-by-zero`. `%` takes the sign of the dividend and is integers only.
> - Comparisons are numeric, with both operands of the same type.
> - `make-error` and `wrap-error` build a never-thrown error with `makeError`. `wrap-error`'s cause must be an error.
> - `throw`'s `fn` returns `fail`-style `{ ok: false, e }` with the error it was given. The machine applies the already-thrown rule.
> - `float->integer` throws `type-error` for NaN or infinity, and `overflow` if the result does not fit.
>
> Test every group of operations, including each error tag they can raise.

### Task E: environments (`cpi-haiku`)

> **Task E: environments.** You own `src/env.ts` and `tests/env.test.ts`. Read DESIGN-001 section 8 (Environments) and the Glossary's Environments entries, SPEC-CPI section 6, and `environment::` in SPEC-CPI section 10.4. Use the `Slot` and `Env` types in `src/types.ts`.
>
> Export:
> - `emptyEnv(): Env`.
> - `fromBindings(bindings: ReadonlyArray<readonly [string, Value]>): Env`, all `defined` slots.
> - `required(name: string): Env`.
> - `compose(left: Env, right: Env): Env`. It is total: `required` is the identity; two `defined` slots that are identical compose to one; different ones become `conflicted(left, right)`, keeping both in order; composition recurses into slots that are already conflicted. "Identical" means `===`, or two atoms (bool, nil, int, float, str, sym) of the same type and value. Implement that comparison locally; do not import `core.ts`.
> - `composeModule(left: Env, right: Env): { ok: true; env: Env } | { ok: false; conflicts: string[] }`, the module rule: any new `conflicted` slot is an error.
> - `lookup(env: Env, name: string): Value | null`, the scope rule: the right side shadows the left, so a `conflicted` slot resolves to its right side, recursively. `required`, or no slot at all, is `null`.
> - `conflicts(env: Env): string[]`, the names of `conflicted` slots.
> - `bindingHash(env: Env, printValue: (v: Value) => string): string`: SHA-256 hex of the resolved names in sorted order, each with `printValue` of its value. The caller passes a printer so this module does not depend on `printer.ts`. Two environments with the same resolved bindings must hash the same, however they were composed.
>
> Test composition identities, conflicts and their order, the scope rule, the module rule and hash equality.

### Task X: expander (`cpi-sonnet`)

> **Task X: the base expander.** You own `src/expander.ts` and `tests/expander.test.ts`. Read SPEC-CPI sections 4 (including 4.1), 5.1 and 9, and DESIGN-001 section 3, "The base expander". Your input is what `read` returns: `Value`s built from `pair`s with positions. Build test input with the helpers in `src/values.ts`, not with the reader, which is being written in parallel.
>
> Export `expand(forms: Value[], mode: 'file' | 'expr'): Value[]`. It throws `LoadError` for every violation.
> - **In `'file'` mode**, every top-level form must be `(defun name (params) body...)` or `(const name expr)`. `'expr'` mode expands expressions that are not definitions.
> - **Derived forms become `cond`**, exactly as the table in section 4.1 says. `case` binds its topic with `(let t topic)` inside a `do`, using `gensym('case')` for `t`. A final `(else body...)` clause becomes `(#true body...)`.
> - **Core operations in value position** (anywhere except the head of an application) become `(lambda (a1 .. an) (op a1 .. an))`, with `gensym` names and the arity from `CORE_ARITY`.
> - **Reserved names**: binding any name for which `isReserved` is true is a `LoadError`. That covers parameters, `let`, `defun`, `const` and the `catch` variable. So is a `::` name used anywhere except the head of an application.
> - **Placement**: `let` and local `defun` may appear only as elements of a body: a `lambda`, `defun`, `do` or clause body (section 4). `const`, and `defun` outside a body, are allowed only at the top level in `'file'` mode.
> - **Shape checks**: every special form's shape is checked, with a `LoadError` saying what is wrong. A `catch` must have exactly a body, a name and a handler.
> - **Positions**: every pair you build copies `pos` from the form it replaces, so traces still point at source.
> - **Output** contains only special forms, applications, symbols and literals. `quote` data is left untouched.
>
> Test each derived form, eta-expansion, each reserved-name and placement error, and that positions survive.

---

## Wave 2

### Task M: the machine (`cpi-sonnet-deep`)

> **Task M: the evaluator.** You own `src/machine.ts` and `tests/machine.test.ts`. Read SPEC-CPI sections 2, 4, 5.1, 6, 7 and 8 in full. You depend on `src/core.ts` (`CORE`, `eq`), `src/env.ts` (`lookup`), `src/expander.ts` (`expand`, for tests) and `src/reader.ts` (`read`, for tests); they are finished. Build test programs as source text, read, expanded in `'expr'` mode, and run.
>
> Export:
> - `step(s: State): State`. It is **pure**: it never mutates `s`, a frame, a scope or a value. The one exception is setting `e.box.ctx` the first time an error is thrown. It follows the transition tables in section 7.3 exactly: one transition per call, and one frame popped per step while unwinding.
> - `start(f: Closure, args: Value[], R: Env): State`, the state for applying `f` to `args`, with `A = { name: f.name?.name ?? null, args }`.
> - `startExpr(x: Value, R: Env): State`, the state for evaluating the expanded expression `x`, with an empty scope and `A = { name: null, args: [] }`.
> - `resume(s: State, frames: Frame[]): State`. `s` must be in `host` mode. It pushes `frames` (`frames[0]` ends up on top) and delivers `()`, as section 8 says.
> - `run(s: State, limit: number): State`, which steps until the mode is `done`, `failed` or `host`, or until `limit` steps. It is used by tests and the loader.
> - `kontDepth(K: Kont): number`, for tests.
>
> Rules to get right:
> - **Tail calls** (section 7.4): applying a closure pushes **no** frame. The last expression of a body is evaluated with nothing pushed.
> - **Local `defun` groups** (sections 7.2 and 7.3): a run of consecutive `defun`s at the front of a body shares one group, and applying a group member binds fresh closures for every member over the captured scope. A global `defun` (a closure with `group` null) does not bind its own name.
> - **Names** (section 6): look in the local scope first, then `lookup(s.R, name)`, else throw `unbound` with the symbol as payload. Special forms, core operations and `::` names are recognized by the head symbol before any lookup.
> - **Core operations**: check the arity, then call `CORE.get(op).fn`. Handle `apply` yourself. A `{ ok: false }` result throws. Each application is one tick like any other step.
> - **Host requests**: `(ns::action args...)` evaluates its arguments, then enters `host` mode. Do not check grants: the runtime does.
> - **Throwing** (section 7.5): when a new throw starts, whether from `throw`, a failed core operation, an `unbound` name or an arity mismatch, set `e.box.ctx = { site, scope, K, R }` from the current state. If `e.box.ctx` was already set, throw a new `already-thrown` error with `e` as its payload instead. `catch` binds the error and evaluates the handler in tail position. No handler means `failed`.
> - **Sites**: every frame you push records `site = { fn, pos }`. `fn` is the name of the procedure whose body is being evaluated: set it when a closure is applied, and carry it in `eval` mode. `pos` is the `pos` of the expression pushing the frame.
> - **Checkpoint slot** (section 7.3): applying a closure whose name equals `s.A.name` replaces `A.args`.
>
> Test at least:
> - every special form;
> - tail calls: a 1,000,000-iteration self-recursive loop, where `kontDepth` stays at or below 2 throughout;
> - mutual recursion in a local `defun` group;
> - `catch`, `wrap-error` and `already-thrown`;
> - a trace that shows the throwing procedure;
> - `unbound`;
> - the checkpoint slot tracking a loop's arguments;
> - `resume` with each of the resumption frames `val`, `throw` and `eval`.

---

## Wave 3: parallel

### Task T: runtime and builtins (`cpi-sonnet-deep`)

> **Task T: the runtime.** You own `src/runtime.ts`, `src/builtins.ts` and `tests/runtime.test.ts`. Read SPEC-CPI sections 8, 10, 11 and 12 in full, and section 7.5. The prototype choices pasted below are part of your task. You depend on `src/machine.ts`, `src/core.ts` (`traceEntries`, `eq`), `src/env.ts` and `src/printer.ts`; all are finished.
>
> *(Paste the whole Prototype choices section here.)*
>
> Export `class Runtime`:
> - `constructor(opts: { out: (line: string) => void })`.
> - `boot(env: Env): { ok: true; v: Value } | { ok: false; e: ErrorValue }`. It runs `(main)` as the CPI: `startExpr` of the expanded `(main)`, in `env`, granted every namespace, under no quota. It steps until `done` or `failed`, servicing each host request synchronously as it comes. A `failed` CPI is section 12: report it through the return value.
> - Whatever else your tests need: the process table, mailboxes, the virtual clock and dead letters.
>
> Put the namespace tables in `src/builtins.ts`: `process::`, `mailbox::`, `host::` and `environment::` (all of section 10), `actor::` (section 10.5), `IO::print`, and `timer::sleep`. Each action declares its arity.
>
> Host dispatch (section 8), in this order:
> 1. The namespace is not granted: resume with a `throw` frame carrying `not-granted`.
> 2. The namespace or the action is unknown: `unknown-action`.
> 3. The arity is wrong: `arity-error`.
> 4. Otherwise, call the action. An action returns one of three things:
>    - frames to resume with;
>    - a **block** (`recv`, `join <pid>`, or `host` for `timer::sleep`), which leaves the process blocked;
>    - for `actor::` actions in the trap set, a **trap**.
>
> `process::run(pid, n)` runs a `ready` process for up to `n` steps and returns the exact stop reason lists in section 11: `(quota)`, `(blocked recv)`, `(blocked join <pid>)`, `(blocked host)`, `(exited v)`, `(failed e)` and `(trap <effect> <args>)`. A process whose machine state is `done` or `failed` has ended. Keep its stop detail for `process::state`, `actor::join` and watchers.
>
> Test at least:
> - spawn and run to exit;
> - `(quota)` preemption and resuming;
> - send and recv between two processes, with delivery at the batch boundary;
> - `(blocked recv)` becoming ready when a message arrives;
> - join;
> - traps with `process::resume` and `process::resume-throw`;
> - `process::checkpoint` after a failure;
> - park, then unpark and continue;
> - `set-env`, where a pending call reaches the new code;
> - `not-granted` for a process calling `process::`;
> - `environment::error-pad` and `error-env`;
> - `timer::sleep` with `host::wait` advancing the virtual clock;
> - a failing `main`.

### Task L: loader and CLI (`cpi-haiku`)

> **Task L: the loader and the CLI.** You own `src/loader.ts`, `bin/cpi.ts` and `tests/loader.test.ts`. Read SPEC-CPI section 9. You depend on `read`, `expand`, `src/env.ts` (`composeModule`, `fromBindings`) and `src/machine.ts` (`startExpr`, `run`), which are finished, and on `Runtime` from `src/runtime.ts`, which is being written in parallel. Only `bin/cpi.ts` uses `Runtime`, through `new Runtime({ out })` and `boot(env)`, so write the loader first.
>
> Export from `src/loader.ts`:
> - `loadSource(source: string, file: string, base?: Env): Env`
> - `loadFiles(paths: string[]): Env`, which reads each file in order and builds one environment.
>
> Both throw `LoadError`. For each expanded top-level form, in order:
> - A `defun` becomes a closure with that name, an empty scope and `group: null`.
> - A `const` evaluates its expression with `startExpr` in the environment built so far, stepping with `run`. `done` gives the value. `failed` is a `LoadError`, with the error as payload. Reaching `host` mode is a `LoadError`: host requests are not allowed while loading.
> - Each definition is added with `composeModule`. A conflict is a `LoadError` naming the conflicting names.
>
> `bin/cpi.ts`: `node bin/cpi.ts file.slight ...` loads the files, then boots a `Runtime` that writes to stdout. It exits 0 when `main` finishes. When `main` fails, it prints the error and its trace to stderr and exits 1. A load error is printed the same way, with exit 2.
>
> Test `defun` and `const` loading, `const` referring to an earlier definition, duplicate definitions, a `const` that throws, and a `const` that makes a host request.

---

## Wave 4

### Task A: acceptance programs (`cpi-sonnet`)

> **Task A: acceptance programs.** You own `tests/programs/*.slight` and `tests/acceptance.test.ts`. Read SPEC-CPI in full, and skim `src/runtime.ts` and `src/builtins.ts` to see what exists. Write each scenario as a CPI program: a `.slight` file with a `(main)`. The test loads it with `loadFiles`, boots a `Runtime` whose output goes to an array, and asserts the exact output lines. Every run is deterministic, so exact assertions are right.
>
> Scenarios, one program each:
> 1. **Scheduler.** `main` spawns two ping-pong actors, each granted `'(actor IO)`, which exchange 5 messages and exit. A round-robin loop written in the language drives them with `process::run` and a quota of 20. It calls `host::wait` when nothing is ready and prints each stop reason.
> 2. **Tail calls.** A 1,000,000-iteration loop, running both in the CPI and in a spawned process, finishes. The acceptance test also asserts that the host process's memory stays bounded; a loose check on `process.memoryUsage()` is enough.
> 3. **Errors.** `catch`, `wrap-error`, a chain walked with `error-cause`, `stack-trace-for` showing procedure names and lines, `already-thrown` when an error is thrown twice, and `environment::error-pad` showing a local variable's value at the throw point.
> 4. **Restart from checkpoint.** A counter actor with `(defun counter (n) ...)` throws on the message `:boom`. The CPI sees `(failed e)`, reads `process::checkpoint`, and spawns a new run with those arguments on the same mailbox address. Later increments continue from the checkpointed count.
> 5. **Traps.** After `(host::set-traps '(send))`, an actor's send comes back to the CPI as `(trap send ...)`. The CPI performs it with `mailbox::send` and resumes the actor with `process::resume`.
> 6. **Parking.** An actor blocked in `recv` is parked with `process::park` and unparked with `process::unpark` into `(environment::self)`. After a message is sent to its address, it continues and prints.
> 7. **Timers.** Two actors sleep for different virtual durations. The output order follows virtual time, and `host::now` reports the expected values.
>
> If a scenario fails because of a bug in someone else's module, do not fix it. Report the failing scenario, the program and the observed output to the manager.

---

## Finishing

When Wave 4 passes:

1. Write `README.md`: how to run the tests and the CLI, a table of modules, and what the prototype does not do yet.
2. Make sure `DECISIONS.md` is complete.
3. Commit.
4. Report to the user:
   - what works;
   - the test count;
   - every **Spec issue**;
   - the worker decisions most worth their review;
   - anything unfinished.
