# ts-cpi

A prototype of the slight **control plane interpreter** (CPI) in TypeScript.
It implements `../../design-xxx/SPEC-CPI.md`, following the design in
`../../design-xxx/DESIGN-001.md`. Choices the spec leaves open are recorded in
[`DECISIONS.md`](DECISIONS.md).

[`new-vision.md`](new-vision.md), a first draft, narrows the focus: what
slight is for, the guarantees that matter, and what waits.

The goal of this stage is simple and solid: a pure CEK-style evaluator with
constant-space tail calls, plain-data continuations, and a runtime whose
processes, mailboxes, traps, parking and timers are driven entirely by
control-plane code written in the language.

Environments are built in the language from **roles**: `(role ...)` holds
definitions, captures nothing from where it is written, and declares with
`require` every name it uses from outside, host actions included. Roles
compose; a required `const` works as a parameter; `process::set-env` swaps a
running process onto a new composition. Processes in the examples run code
kept in roles. The language also has `list`, a variadic `string-append`,
`string-join`, `rethrow` and immutable vectors, proposed and agreed in
[`DECISIONS.md`](DECISIONS.md) along with quasiquote, `append` and
`value->string`.

## Running

Node 22.6 or later runs the `.ts` files directly; there is no build step.

```sh
npm install
npm run check          # type-check (tsc --noEmit)
npm test               # all tests: node --test "tests/**/*.test.ts"
node bin/cpi.ts prog.slight [more.slight ...]
```

`bin/cpi.ts` loads the files in order, then evaluates `(main)` as the CPI.
Output from `IO::print` goes to stdout. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | `main` finished. |
| 1 | `main` failed. The error, its trace and its causes go to stderr. |
| 2 | Loading failed (syntax, expansion, a duplicate definition, or a `const` that threw or made a host request). |

A minimal program:

```lisp
(defun main ()
    (IO::print "hello" (* 6 7)))
```

[`PERFORMANCE.md`](PERFORMANCE.md) has a first performance baseline: the interpreter, and where the gateway spends its time.

[`TUTORIAL.md`](TUTORIAL.md) walks through the language, errors, processes and
the builtins, using the programs in `examples/` and `tests/programs/`.
`examples/actors/` builds a minimal actor system in the language (message
helpers kept in a role, a round-robin scheduler, idle shutdown) and runs ping
pong on it:

```sh
node bin/cpi.ts examples/actors/actors.slight examples/actors/ping-pong.slight
```

`examples/gateway/` is a web gateway on `http::` (`SPEC-HTTP.md`): a router
actor, a pool of pre-warmed workers on one shared queue that grows under load
and parks when idle, and counters created on first use that sleep and wake
(tutorial section 10). It runs plain or under a live terminal monitor, and
`examples/gateway/scenarios/` plays curl load against it. See
[`examples/gateway/README.md`](examples/gateway/README.md), which also records
what the first measurements showed.

```sh
node bin/cpi.ts examples/gateway/gateway.slight examples/gateway/plain.slight     # then: curl localhost:8080/hello/ada
node bin/cpi.ts examples/gateway/gateway.slight examples/gateway/monitor.slight   # the same, with the monitor
```

`examples/life/` holds the Game of Life written 22 different ways, as a tour of
what the CPI's builtins can do. See [`examples/life/README.md`](examples/life/README.md).

`examples/ring/` is the ring benchmark from *Programming Erlang*: N processes
in a ring, and a message sent round it M times. Each ring is timed three ways,
by how much of the running the CPI hands to the host at once: a turn
(`process::run`), a round (`process::run-ready`), or everything until the
ring ends (`plan::run`). See [`examples/ring/README.md`](examples/ring/README.md)
for what it measured.

```sh
node bin/cpi.ts examples/ring/ring.slight examples/ring/bench.slight
```

## The terminal UI

The CPI can draw on the terminal and read the keyboard through the privileged
`tui::` namespace, specified in [`SPEC-TUI.md`](SPEC-TUI.md). A screen is a
view: plain data in SXML's shape, built with quasiquote, and drawn by Ink:

```lisp
(tui::render `(Box (@ (borderStyle round) (paddingX 1))
    (Text (@ (bold #true)) "generation " ,gen)
    ,@(map row-view board)))
```

```sh
node bin/cpi.ts examples/life/lib/lists.slight examples/life/lib/life.slight examples/tui/life.slight
node bin/cpi.ts examples/life/lib/lists.slight examples/tui/top.slight   # interactive: q quits
```

`examples/runner/` is a Life runner: pick one of eleven engines, a board
size, a preset and a rule, and watch it run with live stats
(`examples/runner/run.sh`). Its README has measurements of how the TUI and the
CPI work together.

`examples/tui/life.slight` animates the Life reference run with a population
sparkline. `examples/tui/top.slight` is a live process monitor: it schedules
six workers round robin and lets you pause, step, select, kill and change the
quota from the keyboard.

## Modules

| File | Contents |
| --- | --- |
| `src/types.ts` | The shared contract: values, scopes, environments, frames, continuations, machine state. |
| `src/values.ts` | Value constructors, interned symbols, `gensym`, list helpers. |
| `src/errors.ts` | Error construction, runtime tags, `LoadError`. |
| `src/names.ts` | Core-operation arities, special and derived form names, reserved-name rules. |
| `src/reader.ts` | Source text to values, with a position on every list (SPEC-CPI section 3). |
| `src/printer.ts` | `print` and `display`. |
| `src/core.ts` | The core operations, `eq?`, and trace entries (section 5). |
| `src/env.ts` | Slot composition with values compared by content, the scope and module rules, `define`, `history`, `accept`, `difference`, and the binding hash (DESIGN-001 section 8). |
| `src/role.ts` | The global names a role's code uses, found by walking its expanded bodies. |
| `src/expander.ts` | The base expander: derived forms to `cond`, eta-expansion, reserved names, placement and shape checks (section 4), and `role`, built into an environment when the file loads. |
| `src/machine.ts` | The pure `step` function and its state: tail calls, local `defun` groups, catch/throw, host requests, the checkpoint slot (sections 6 to 8). |
| `src/builtins.ts` | The namespace tables: `process::`, `mailbox::`, `host::`, `environment::`, `actor::`, `IO::print`, `timer::sleep`, with arities. |
| `src/runtime.ts` | `Runtime`: boots the CPI, the process table, mailboxes, `process::run` batches, traps, parking, the clock, dead letters, the TUI and HTTP (sections 10 to 12, SPEC-TUI and SPEC-HTTP). |
| `src/tui/` | The `tui::` namespace (`SPEC-TUI.md`): views as data (`views.ts`), charts drawn by the host (`charts.ts`, with `@pppp606/ink-chart`), tables (`table.ts`), input events (`events.ts`), and two backends, Ink on a terminal (`terminal.ts`) and headless for tests (`headless.ts`). |
| `src/http/` | The `http::` namespace (`SPEC-HTTP.md`): the backend interface and request-target parsing (`backend.ts`), and two backends, `node:http` on the loopback interface (`node.ts`) and scripted for tests (`headless.ts`). |
| `src/loader.ts` | Loads `.slight` files into an environment (section 9). |
| `bin/cpi.ts` | The command line. |

## What the prototype does not do yet

- **Two external event sources.** `host::wait` wakes on timers, on keys from the TUI and on HTTP requests (`SPEC-HTTP.md`); there is no other I/O, no HTTP client, and no other event stream yet.
- **Only the terminated lifecycle signal** exists, delivered as an ordinary message appended to the watcher's mailbox. Signals are not delivered ahead of messages.
- **No acknowledgment** of messages, no selective receive support, and no reader for the dead-letter queue.
- **Addresses are guessable** counters, not 128-bit random identifiers.
- **Parked state is not plain data**: the continuation stays in a runtime table referenced by an integer key, so it cannot be stored or moved to another image.
- **No hashing of code or frames** beyond the binding hash, which hashes a printed form of each closure's code (and of any role inside it) rather than a core hash. There is no composition hash.
- **The CPI's own code does not come from roles.** It comes from its files, and it cannot call a role's procedures, so a library shared by the CPI and its processes cannot be a role. Processes that need one run in a role composed onto `(environment::self)` (`DECISIONS.md`, Spec issues).
- **No pipeline, phases, store, distribution, JIT tapes or reflection** (out of scope for SPEC-CPI).
- **No quota for the CPI.** A CPI loop that never returns to `process::run` or `host::wait` runs forever (DESIGN-001 open question 4).
- **No deadlock detection** and no default recovery strategies. Those are policies to write in the language.
- **Tick counts** are lower than a literal reading of SPEC-CPI section 7.3, because `Eval((do …))` transitions are folded into the step that produces them.
