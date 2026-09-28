# ts-cpi

A TypeScript prototype of the slight control plane interpreter. See `README.md`
for layout and commands, `DECISIONS.md` for choices made, and `TUTORIAL.md` for
the language.

## Code style

- **Indent with 4 spaces**, in all code: TypeScript, `.slight` (CPI) source,
  CPI source embedded in tests, code blocks in Markdown, and JSON. Write it
  that way from the start; there is no reformatting tool, and existing code
  isn't reformatted just to line up.
- CPI (`.slight`) code indents 4 spaces per open parenthesis:

  ```lisp
  (defun sum-to (n acc)
      (if (= n 0)
          acc
          (sum-to (- n 1) (+ acc n))))
  ```

## Commands

- `npm run check`: type-check.
- `npm test`: all tests (about 15 s; the runner's engine check is most of it).
- `node bin/cpi.ts file.slight ...`: run a program.
- `examples/runner/run.sh` (the Life runner, needs a terminal) and `examples/runner/run.sh check`.
- `tools/`: `build_tutorial.py` (the tutorial's published page), `drive_runner.py` (measure the runner on a real pty). See `tools/README.md`.

## Where things are decided

- `../../design-xxx/DESIGN-001.md` and `SPEC-CPI.md` are the design and spec. Never edit them from here.
- `DECISIONS.md` records every prototype decision, spec issue, and **spec change** (quasiquote, `append`, `value->string`, `list` and the other language additions, roles), with text ready to move into SPEC-CPI.
- `SPEC-TUI.md` specifies `tui::`, the real clock, `host::wait`, charts and tables, all accepted.
- `SPEC-HTTP.md` specifies `http::`, requests as messages and reply addresses, accepted.
- A change to language semantics, a new core operation or builtin, or a change to runtime timing is a spec change: propose it, with options and a recommendation, before building.

## Rules learned the hard way

- **Time is real.** The virtual clock is a `Runtime` option for tests only (`clock: 'virtual'`), never reachable from CPI code or the CLI. Tests also use the headless TUI (`src/tui/headless.ts`), where scripted input arrives instead of time passing.
- Every test that compares output against a reference (Life frames, runner engines) must keep passing. `examples/life/12-timer-wheel.slight` is correct only under the virtual clock and is marked as a fixture.
- Verify a reported misbehavior against an independent implementation before calling it a bug: the Seeds, Day & Night and Life-without-death rules looked broken but were correct.
- When editing with scripts, assert that each replacement matched: a silent no-op once caused a false bug hunt.
