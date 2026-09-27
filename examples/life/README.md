# Twenty-two Games of Life

The Game of Life, written 22 ways as control plane code. The point is not the
Game of Life; it is a fixed, checkable workload for exploring what the CPI can
do. Every version runs the same seed (a glider that crashes into a blinker on
an 8×8 torus) for 8 generations, and prints exactly the same frames as
`01-reference.slight`. `tests/life.test.ts` checks that for every file here.
Everything else a version prints is its own commentary, and that is where
the interesting part is.

```sh
examples/life/run.sh examples/life/15-hourglass.slight
node --test tests/life.test.ts
```

`run.sh` loads `lib/lists.slight` and `lib/life.slight` (list helpers, the
board, the rule, `print-board`), then any files named on a `; load:` line in
the version's header, then the version itself.

The versions that spawn processes keep the processes' code in a role, which
declares every host action and library procedure the code uses; `process-env`
and `spawn-in` in `lib/lists.slight` build the environment and spawn in it.
A role that needs only host actions runs alone, with none of the CPI's
environment (07, 12, 15, 16).

## The versions

### The baseline

| # | Version | Idea |
| --- | --- | --- |
| 01 | Reference | The board is a value and each generation is a pure function of the last, all in the CPI. |
| 21 | Rulestring | The rule is a string, `"B3/S23"`, parsed at load time with `string-ref`. The same parser runs HighLife, Seeds and Day & Night for comparison. |
| 22 | Decision tree | A `const` compiles the rule into a 512-leaf binary tree over the 3×3 neighborhood while the file loads. At run time each cell takes nine steps down the tree, and nothing is counted. |

### Classic process designs

| # | Version | Idea |
| --- | --- | --- |
| 02 | Actors | 64 cell actors exchange `(gen state)` with their neighbors and buffer messages from a generation ahead. This is the barrier the old ts-slight version lacked. An uneven, shuffled scheduler lets cells drift up to two generations apart, and 926 early messages get buffered. |
| 03 | Row workers | Bulk-synchronous: scatter three rows to each of 8 workers, compute, and meet at a barrier on one result mailbox. Results arrive in a different order from the run order every superstep. |
| 04 | Metronome | One generation per 100 ms of virtual time. Row 5 oversleeps beat 3 by 30 ms. The conductor waits for it with `(host::wait 10)`, and beat 4 is still on time because players aim at absolute beats. |

### The control plane as the laws of physics

| # | Version | Idea |
| --- | --- | --- |
| 05 | Trapped world | Cells run a real message protocol, but `send` and `recv` are trapped. The CPI is the world: it answers every `recv` with a state nobody sent. In the end 8,704 effects were trapped and the real mailboxes held 0 messages. |
| 06 | Mailboxes as memory | No processes. A live cell is a mailbox of capacity 1 holding a `(born g)` token, a neighbor count is a sum of `mailbox::size`, and two banks give double buffering. A second birth into a live cell is `full`. |
| 07 | Literal death | A live cell is a process and a dead cell is no process. The CPI kills cells with a reason (`:loneliness`, `:overcrowding`) and spawns newborns. Neighbors watch each other, and an undertaker prints obituaries from the terminated signals. |
| 13 | Let it crash | Death is `throw`, and birth is a restart on the cell's durable mailbox from `process::checkpoint`. The supervisor writes post-mortems by reading the dead cell's locals with `environment::error-pad`. |

### Time, memory and history

| # | Version | Idea |
| --- | --- | --- |
| 08 | Checkpoint observer | The universe is one loop with no grants that never prints. The CPI sees it only through `process::checkpoint`. At generation 3 it forks HighLife and Seeds timelines from the checkpoint and runs all three in step: the same loop, with each rule a role that redefines `life-rule` in the timeline's environment. |
| 09 | Hibernation | Cells with nothing to do are parked, and unparked into the same `recv` when news arrives. On this small board 37–43 of 64 cells stay awake (327 of 512 cell-steps), so it pays only on bigger boards. |
| 10 | History as an error chain | Each generation wraps the last with `wrap-error`, and the history is one error. It is replayed at the end by walking `error-cause` and reading each generation's cells back out of the pads of the stack it was thrown from. |

### Computation in odd places

| # | Version | Idea |
| --- | --- | --- |
| 11 | Join dataflow | 576 processes, one per cell per generation, each joining its 9 inputs. The CPI's scheduler knows nothing about Life. Run newest-first, the blocked-in-join count drains one generation per round; oldest-first, everything finishes in one round. |
| 12 | Timer wheel | The board is stored only in the timer queue: a live cell is a sleeper whose deadline is `generation*1000 + cell-index`. The CPI decodes `host::now`. |
| 14 | Closure pads | The board is a scrambled bag of closures, read only through `environment::closure-pad`. The next state comes from processes that throw a confession and are read with `environment::error-pad`. |
| 15 | Hourglass | Nothing counts neighbors. Each cell's process pours one grain of spin loop per live neighbor, and the CPI times it: the stop reason at each calibrated tick mark (`(quota)` or `(exited …)`) is the count. |
| 16 | Join-chain abacus | A number is a chain of processes, each blocked in `actor::join` on the next. Every generation the whole image is one deliberate deadlock (ready to run: 0), read by walking `(blocked join <pid>)`, then released like dominoes. |
| 17 | Amb | One cell program, spawned once, asks six yes/no questions. The CPI answers each both ways by unparking the same parked continuation twice, growing 64 parked leaves that are revived every generation. |

### The CPI as game master

| # | Version | Idea |
| --- | --- | --- |
| 18 | Hostile scheduler | Four workers share a job queue, and an adversarial scheduler randomizes quotas, shuffles jobs, forges stale jobs, duplicates work and starves a victim. Frames still match because the protocol tags and deduplicates answers. |
| 19 | Tick economy | One coin buys 1,000 ticks. Regions borrow at 25%, fall into debt spirals and go bankrupt. The Treasury kills and respawns bankrupt workers from their checkpoints. |
| 20 | Rule swap | The CPI changes the code of a running world four ways: a patch composed onto its environment and set with `process::set-env`, a rule sent in a message, checkpoint surgery, and a swap back that also restores the old environment. |

## What the versions found out about the CPI

Each worker reported the bugs, gaps and surprises it ran into. They are
combined and de-duplicated here, the most significant first.

**Fixed.** PIDs were not interned, so a PID returned by `host::wait` was not
`eq?` to the one from `process::spawn`. `pid()` now interns them like symbols
(found by 04).

**Worth a design decision**
1. **No hot reload from the language** (20, 08). No builtin creates, adds or replaces a binding. Every env ref derives from `environment::self`, so `process::set-env` can only swap in an env with identical bindings. SPEC-CPI section 6's hot reload cannot be exercised from control plane code. Swaps that do work pass code as values: closures in loop arguments, in messages, or in edited checkpoints. A primitive such as `(environment::bind e name value)` would close the gap. *Resolved Sep 27, 2026:* roles (`DECISIONS.md`). 20's swap A now patches the running world's `hr-step` with `set-env`, and 08's forks run one `universe` loop under rules given as roles.
2. **Mailbox ownership is underspecified** (17, 13, 18). Spawning onto an address a live process owns succeeds silently. Unparking one parked value twice makes two live clones share one address. "Owner" becomes the newest process, so when it ends, a non-durable mailbox dead-letters sends meant for the survivors, and `mailbox::send` still returns `#true`. A send wakes every process blocked on the address (a thundering herd).
3. **The CPI can't wait on a process.** `actor::join` and `actor::recv` are `bad-state` in the CPI, so it polls `process::state`. `host::wait` returns PIDs but not which deadline fired (11, 12).
4. **Nothing is reclaimed** (11, 09). Ended processes stay in the process table forever, waking joiners scans the whole table, and the park table never shrinks because parked data may be unparked again.
5. **Metering is invisible** (09, 19, 15). `process::run` doesn't report ticks used, so a scheduler can only meter in whole quotas. Tick costs are implementation-defined but exact and repeatable, and 15 depends on the boundary between `(quota)` and `(exited …)` at exactly n ticks, which the spec doesn't promise.
6. **`actor::join` has two result shapes** (11, 17): `(exited v)`, `(failed e)` or `(killed r)`, but the bare symbol `ended` for a parked or unknown target.
7. **Timers** (12, 04): `timer::sleep 0` sets no timer, a sleep counts from the process's first run rather than from spawn, and processes can't read the clock, so drift correction needs the CPI to send the time.
8. **Traps are global and not fully virtual** (05). `host::set-traps` applies to every process, and a trapped `send` still type-checks its address, so a fully simulated world still needs real mailboxes.
9. **Pads** (14, 13): tail calls erase a procedure's pad, so what `error-pad` sees depends on how the code was written. A closure's pad is its whole defining scope, not just the variables it uses.
10. **Restarts repeat side effects** (20). Sends are flushed at batch end and can't be recalled, so a restart from a checkpoint gives at-least-once effects, and consumers must deduplicate (18 and 20 do).

**Smaller things**
- `(eq? (environment::self) (environment::self))` is `#false`: env refs compare by wrapper identity, so only `binding-hash` identifies an env (20).
- `mailbox::take` returns `#false` for an empty mailbox, which is ambiguous with a `#false` message, and there is no `mailbox::peek` (06, 03).
- Host requests are not values: `(map mailbox::size row)` is a load error, though core operations can be passed (06).
- The checkpoint follows only the spawned procedure, matched by name. A boot wrapper freezes it at the wrapper's arguments (09).
- Reading mail destroys the only "had mail" signal the CPI can see (09).
- A woken joiner shows `(ready)` before it has seen the ended target, so stop reasons go stale within a round (11, 16).
- There is no structural `equal?` and no number-to-string conversion, and `IO::print` always separates arguments with spaces (08, 02, 07).
- `examples/actors/actors.slight` prints a line for every spawn and every `(blocked recv)`, and has one global quota, so it doesn't scale past a handful of actors (02).
