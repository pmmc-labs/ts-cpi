# The Life runner

A TUI program that runs the Game of Life with any of eleven engines, on a
board and preset of your choice, with live stats. It is also an experiment in
how the TUI and the CPI work together.

```sh
examples/runner/run.sh            # the runner (needs a terminal)
examples/runner/run.sh check      # every engine checked against the reference
```

**Menu:** ↑↓ choose a field, ←→ change it, enter to run, q to quit. The
fields are:

- engine;
- board size: 24×16 up to 128×64, or fit the terminal;
- preset: R-pentomino, glider, Gosper glider gun, pulsar, acorn, diehard, lightweight spaceship, or seeded random;
- rule: Conway, HighLife, Seeds, Day & Night, or Life without death;
- pace: 0 to 600 ms per generation.

Each rule's description is shown under the fields.

**Run screen:** the board is drawn with half blocks (two rows per line), with
the keys beside it. Below it are the stats (generation, live cells, cells
born and died this generation, timings), the engine's own notes, and a
sparkline of the population. Space pauses, s steps one generation while
paused, and q goes back to the menu. The pace is set in the menu. The menu
also describes each rule, since three of them behave nothing like Conway's:
under Seeds every cell dies each generation, under Day & Night most Conway
patterns die out, and under Life without death nothing ever dies.

## How it fits together

| File | Contents |
| --- | --- |
| `lib/board.slight` | Boards of any size with a row-sweep step, rules parsed from rulestrings, presets, mailbox "cells" (a one-message mailbox used as a variable), and the engine contract. |
| `engines/*.slight` | One engine per file: `(NAME-engine config report)`. |
| `engines.slight` | The registry. Engines are named by symbol and looked up with `environment::lookup` when chosen, so a missing file shows as "not loaded". |
| `runner.slight` | The menu, and the run screen's `report` function. |
| `check.slight` | Runs every loaded engine against the reference; `tests/runner.test.ts` requires every one to agree. |

An engine calls `(report gen board notes)` once per generation. That call is
the runner's only chance to draw, keep pace and read the keyboard: while the
engine computes a generation, nothing else happens.

## Engines

| Engine | Based on | How it computes a generation |
| --- | --- | --- |
| Reference | `01` | The row sweep in `lib/board.slight`, in the CPI. |
| Decision tree | `22` | The rule compiled into a 512-leaf tree per run; nine steps down it per cell. |
| Actors | `02` | One actor per cell trading `(gen state)` with its neighbors, messages from the next generation buffered. |
| Row workers | `03` | One process per row, with the CPI as a bulk-synchronous barrier. |
| Trapped world | `05` | Cells run a message protocol; every send and recv traps to the CPI, which is the world. |
| Mailboxes as memory | `06` | No processes: a live cell is a mailbox holding a token. |
| Literal death | `07` | A live cell is a process; death is `process::kill`, birth a spawn. |
| Hibernation | `09` | Quiet cells are parked and unparked when news arrives, and untouched cells are never spawned. |
| Join dataflow | `11` | A process per cell per generation, joining its nine inputs, spawned two generations ahead. |
| Hourglass | `15` | Neighbor counts (exactly 0 to 8) read from how many ticks a process runs. |
| Hostile scheduler | `18` | Workers on a shared job queue, scheduled adversarially; the protocol keeps the boards right. |

None of the old versions needed a rewrite of its core idea.

## Measurements

These come from the real runner on a real (pseudo-)terminal, 200×60, with the
R-pentomino at pace 0. "q answered" is the time from pressing q to the runner
showing the menu again. The draw column is the whole `tui::render` call:
building the view in slight, plus Ink's layout and write.

**64×32 (2,048 cells)**

| Engine | Engine ms / generation | Draw ms | q answered in ms |
| --- | ---: | ---: | ---: |
| Reference | 50 | 13 | 44 |
| Row workers | 54 | 13 | 44 |
| Mailboxes as memory | 62 | 13 | 43 |
| Hibernation | 63 | 14 | 45 |
| Literal death | 74 | 14 | 43 |
| Hourglass | 167 | 14 | 128 |
| Join dataflow | 219 | 13 | 159 |
| Actors | 256 | 14 | 226 |
| Trapped world | 428 | 13 | 148 |
| Hostile scheduler | 591 | 14 | 36 |
| Decision tree | 1283 | 15 | 327 |

**128×64 (8,192 cells)**

| Engine | Engine ms / generation | Draw ms | q answered in ms |
| --- | ---: | ---: | ---: |
| Hibernation | 54 | 45 | 40 |
| Reference | 189 | 44 | 122 |
| Row workers | 214 | 45 | 203 |
| Mailboxes as memory | 224 | 45 | 44 |

## What we learned

**1. The keyboard is only as responsive as one generation.** Keys are read
only when an engine calls `report`, so a key waits for the rest of the
generation in progress: anywhere up to one generation. That's up to 1.3 s for
the decision tree at 64×32, and more on bigger boards. Pause and quit feel
laggy on heavy engines. For 11 of 15 measurements, the time to answer `q` is
a large share of one generation's time. (The hostile scheduler's 36 ms came
from pressing q just before a generation ended.)

**2. A worker thread for the terminal would not fix this.** The code that
reads keys and draws is CPI code, and the CPI is busy inside the engine. What
the runner lacks is not a second host thread but a second thread of control
in the language: the runner and the engine share the one CPI.

**3. The ways to separate them:**
- **Engines report more often.** Give `report` a sub-generation "progress" call. That is cheap, but every engine has to cooperate, and a single long step still blocks.
- **Engines as processes.** The runner would schedule them with quotas and stay responsive between batches, which is what the CPI's design already does for ordinary work. But only engines that need no privileged builtins could run this way: the reference and the decision tree could, and none of the process-based engines could, because they spawn, schedule and trap processes themselves.
- **Engines as images (path B).** Each run is its own image in a worker thread, with its own CPI, and the runner's image stays responsive and can kill it. This is the one option that works for every engine, and it matches DESIGN-001 section 9 (images messaging images). It also gives a real answer to SPEC-TUI decision D7 (a CPI that never yields): it can be stopped from outside.

**4. Drawing is limited by the interpreter, not by Ink.** Ink lays out and
renders the run screen in about 4 ms at either size
(`spike/tui/probe/draw-cost.ts`). The remaining 9 ms at 64×32, and 40 ms at
128×64, is slight code building the half-block strings: one `string-append`
per cell. A `string-join` or `list->string` core operation would cut most of
it.

**5. The runtime slowed down as programs ran.** Delivering a message, ending
a process and `host::wait` scanned the whole process table, which keeps every
process ever spawned. Fixed by indexing processes by what they wait for:
join dataflow at 64×32 went from 490 ms per generation at generation 5 to
1,160 ms by generation 40, and now holds at about 230 ms. Parking was also
slow, because it hashed the whole environment each time; binding hashes are
now cached.

**6. What the engine writers ran into** (combined from four workers):
- **Language:**
  - `string-append` takes exactly two arguments, so notes need helpers. *Resolved Sep 27, 2026:* it takes any number, and `string-join` joins a list.
  - There's no `list` beyond `list3`: quasiquote works, but first drafts reached for `list`. *Resolved Sep 27, 2026:* `list` is a core operation.
  - There are no vectors or random access. Engines use row sweeps and, in one case, a hand-written persistent trie. *Resolved Sep 27, 2026:* immutable vectors with `vector-ref`.
  - There's no "finally", and a caught error can't be rethrown (it's `already-thrown`), so cleanup has to wrap the error, which changes its tag. *Resolved Sep 27, 2026:* `rethrow`.
  - `case` is reserved even as a parameter name.
  - Host actions aren't first-class values: `(map mailbox::size row)` fails.
  - There are no mutable variables. The runner and engines use a one-message mailbox as one, which works but isn't obvious.
- **Runtime:**
  - `process::run` doesn't report ticks used, so calibrating (hourglass, quotas) takes hundreds of one-tick runs.
  - Traps are global, so a trapping engine must restore them and would interfere with anything else running.
  - `process::kill` on an ended process throws, so cleanup must check first.
  - Ended processes are never reclaimed. Engines that run for unbounded generations have to reuse processes: the hourglass keeps one glass per cell rather than spawning a new one each generation.
  - Programs can't read command-line arguments.
