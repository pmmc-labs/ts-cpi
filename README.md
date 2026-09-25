# ts-cpi

A prototype of the slight **control plane interpreter** (CPI) in TypeScript.
It implements `../../design-xxx/SPEC-CPI.md`, following the design in
`../../design-xxx/DESIGN-001.md`. Choices the spec leaves open are recorded in
[`DECISIONS.md`](DECISIONS.md).

The goal of this stage is simple and solid: a pure CEK-style evaluator with
constant-space tail calls, plain-data continuations, and a runtime whose
processes, mailboxes, traps, parking and timers are driven entirely by
control-plane code written in the language.

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

The programs in `tests/programs/` show the builtins in use: a round-robin
scheduler, restart from a checkpoint, traps, parking and timers.

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
| `src/env.ts` | Slot composition, the scope and module rules, binding hash (DESIGN-001 section 8). |
| `src/expander.ts` | The base expander: derived forms to `cond`, eta-expansion, reserved names, placement and shape checks (section 4). |
| `src/machine.ts` | The pure `step` function and its state: tail calls, local `defun` groups, catch/throw, host requests, the checkpoint slot (sections 6 to 8). |
| `src/builtins.ts` | The namespace tables: `process::`, `mailbox::`, `host::`, `environment::`, `actor::`, `IO::print`, `timer::sleep`, with arities. |
| `src/runtime.ts` | `Runtime`: boots the CPI, the process table, mailboxes, `process::run` batches, traps, parking, the virtual clock, dead letters (sections 10 to 12). |
| `src/loader.ts` | Loads `.slight` files into an environment (section 9). |
| `bin/cpi.ts` | The command line. |

## What the prototype does not do yet

- **Time and I/O are virtual.** The clock starts at 0 and moves only through `timer::sleep` and `host::wait`. There is no real I/O or external event source, so `host::wait` never waits on anything but timers.
- **Only the terminated lifecycle signal** exists, delivered as an ordinary message appended to the watcher's mailbox. Signals are not delivered ahead of messages.
- **No acknowledgment** of messages, no selective receive support, and no reader for the dead-letter queue.
- **Addresses are guessable** counters, not 128-bit random identifiers.
- **Parked state is not plain data**: the continuation stays in a runtime table referenced by an integer key, so it cannot be stored or moved to another image.
- **No hashing of code or frames** beyond the binding hash, and the binding hash prints closures rather than hashing expanded code. There is no composition hash.
- **No pipeline, phases, store, distribution, JIT tapes or reflection** (out of scope for SPEC-CPI).
- **No quota for the CPI.** A CPI loop that never returns to `process::run` or `host::wait` runs forever (DESIGN-001 open question 4).
- **No deadlock detection** and no default recovery strategies. Those are policies to write in the language.
- **Tick counts** are lower than a literal reading of SPEC-CPI section 7.3, because `Eval((do …))` transitions are folded into the step that produces them.
