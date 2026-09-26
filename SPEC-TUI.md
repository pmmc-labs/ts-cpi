# Specification: TUI namespace (draft)

Sep 26, 2026 · Draft for review · Extends `../../design-xxx/SPEC-CPI.md`

This document specifies `tui::`, a privileged namespace through which the CPI
presents what it is managing on a terminal and receives keyboard input. It
also specifies the changes to time and to `host::wait` that interactive use
requires. Section 13 lists the decisions this draft makes that need review.
Until they are settled, the text is written with the recommended choice.

## Conventions

As in SPEC-CPI: **must** is required, **should** is followed unless there is a
stated reason not to, signatures are written `(name arg ...) → result`, and
rationale is set apart.

## 1. Scope

`tui::` is a tool for the CPI, not a user interface framework for
applications. A runtime built in the CPI uses it to show its processes,
mailboxes, schedules and failures, and to take commands from the person at
the terminal.

- `tui::` is privileged. It is granted to the CPI and must not be granted to a process: `process::spawn` with `tui` in its grants throws `not-granted`. A process that needs to show something asks the CPI, which decides what appears.
- There is one terminal and one screen. The CPI owns both while the TUI is open.
- The namespace is bound to an existing terminal UI library in the host (Ink, a React renderer for terminals). The library is a host detail: nothing in this document depends on it except where section 12 says so.

## 2. Model

The CPI describes the whole screen as a **view**: a plain value built from
lists, symbols, strings and numbers (section 3). `(tui::render view)` replaces
the view on screen. The host works out what changed and updates the
terminal; the CPI never addresses individual widgets, and the host keeps no
state for the CPI other than the current view.

> **Rationale.** Views as data keep the CPI's side of the interface in the
> language's own terms. A view can be logged, compared, stored and replayed
> like any other value. A frame costs one host request, and all UI state
> stays in the CPI, where scheduling state already lives. This is the
> Elm architecture, with the CPI's main loop as the update function.

## 3. Views

### 3.1 Encoding

A view is an **element**:

```lisp
(Tag (@ (prop value) ...) child ...)
```

- `Tag` is a symbol naming a component (section 3.2).
- The props list `(@ ...)` is optional. Each prop is a two-element list of a symbol and a value. A value is a string, a symbol (which stands for the string of its name), an integer, a float or a boolean.
- Each child is one of:
  - an element;
  - a string or number, which is text, and allowed only inside `Text`;
  - a list of children, which is spliced in place, so `(map row-view rows)` can be a child;
  - `()` or `#false`, which renders nothing, so `(and show? view)` can be a child.
- Children are identified by position. A `key` prop may be given to an element whose position among its siblings changes between frames.

The shape follows SXML, the conventional encoding of XML as s-expressions.
With quasiquote, a view reads like the screen it describes:

```lisp
`(Box (@ (flexDirection column) (borderStyle round) (paddingX 1))
    (Text (@ (bold #true)) "processes")
    ,@(map process-line pids))
```

### 3.2 Components

A view may name only these components. The list is the capability surface of
the namespace and grows by amending this section.

| Component | Children | Meaning |
| --- | --- | --- |
| `Box` | elements | A flexbox container. |
| `Text` | text and `Text` elements | Styled text. Nested `Text` runs inline. |
| `Newline` | none | A line break inside `Text`. |
| `Spacer` | none | Fills the free space along its parent `Box`'s main axis. |

### 3.3 Props

Props follow flexbox as CSS defines it, with the terminal cell as the unit.

| Component | Props |
| --- | --- |
| `Box` | `flexDirection`, `flexGrow`, `flexShrink`, `flexBasis`, `flexWrap`, `alignItems`, `alignSelf`, `justifyContent`, `gap`, `columnGap`, `rowGap`, `width`, `height`, `minWidth`, `minHeight`, `padding`, `paddingX`, `paddingY`, `paddingTop`, `paddingBottom`, `paddingLeft`, `paddingRight`, `margin` and its sides, `borderStyle`, `borderColor`, `overflow`, `display` |
| `Text` | `color`, `backgroundColor`, `bold`, `italic`, `underline`, `strikethrough`, `inverse`, `dimColor`, `wrap` |

A prop not in this table is a `type-error` (decision D8). Values are passed to
the renderer unchanged, and their meanings are the renderer's.

Flexbox defaults apply, including the surprising one: items shrink to fit, so
a fixed-width panel beside a long line is narrowed unless it has
`(flexShrink 0)`.

### 3.4 Errors

`tui::render` checks the whole view before anything is drawn. A malformed
view throws `type-error` from the `tui::render` call, with the offending part
of the view as the payload. The screen is unchanged.

## 4. Builtins: `tui::`

| Signature | Result | Errors |
| --- | --- | --- |
| `(tui::open mode)` | `#true`. Takes over the terminal. `mode` is `inline` (the view is drawn below the existing output) or `fullscreen` (the terminal's alternate screen, restored on close). | `bad-state` if already open; `type-error`. |
| `(tui::render view)` | `#true`, once the view is on screen (section 5). | `bad-state` unless open; `type-error` for a malformed view. |
| `(tui::size)` | `(columns rows)` of the terminal. | `bad-state` unless open. |
| `(tui::subscribe addr)` | `#true`. From now on, input events are sent to `addr` (section 6). A second call replaces the first. | `bad-state` unless open, or if input is not a terminal; `type-error`. |
| `(tui::unsubscribe)` | `#true`. Stops sending input events. | `bad-state` unless open. |
| `(tui::close)` | `#true`. Unsubscribes, leaves the last view on screen in `inline` mode, and restores the terminal. | `bad-state` unless open. |

## 5. Painting

`tui::render` returns only after the new view has been written to the
terminal. A view the CPI has rendered is on screen, whatever the CPI does
next.

- The host may merge successive views into one frame, but it must not return from `tui::render` until the latest view is written.
- When output is not a terminal (a pipe or a log file), nothing is drawn while the TUI is open. The final view is written once when it closes.
- Time spent drawing is host time: it costs no ticks and is not metered (SPEC-CPI section 8).
- Pacing is the CPI's job. A CPI that renders on every tick spends its time drawing, so it should render when something worth showing has changed, or at most every so many milliseconds of `host::now`.

> **Rationale.** The alternative is to draw only while the image is
> suspended in `host::wait`, as Tk draws in idle time. That coalesces frames
> for free, but a CPI that is busy scheduling ready processes never waits, so
> it would never show anything; every Game of Life version in
> `examples/life/` is such a CPI. Drawing before `tui::render` returns makes
> "what the CPI rendered is on screen" true at every point, at the cost of
> leaving pacing to the CPI. Ink supports this directly: its
> `waitUntilRenderFlush()` writes a pending frame immediately (measured at
> about 0.3 ms in `spike/tui/probe/paint-timing.ts`).

## 6. Input

Input from the terminal is an external event stream (DESIGN-001 section 11).
Events are delivered as messages to the address given to `tui::subscribe`.

| Event | Meaning |
| --- | --- |
| `(key name modifiers)` | A key press. `name` is a one-character string for a printable key, or one of the symbols `up`, `down`, `left`, `right`, `return`, `escape`, `tab`, `backspace`, `delete`, `pageup`, `pagedown`, `home`, `end`. `modifiers` is a list of the symbols `ctrl`, `shift` and `meta` that were held. |
| `(resize columns rows)` | The terminal changed size. |

- Events are delivered only while the CPI is suspended in `host::wait`, in the order they arrived. An event that arrives at any other time is held by the host until the next `host::wait`. The CPI never sees its mailboxes change except across `host::wait`, `process::run` and its own requests.
- Delivery follows `mailbox::send`: if the mailbox is full, the event is dropped and counted as a dead letter.
- **Ctrl-C** is an ordinary event, `(key "c" (ctrl))`, while a subscription exists. Without one, Ctrl-C ends the image: the host closes the TUI, restores the terminal, and exits with status 130.

## 7. Output while the TUI is open

`IO::print` from the CPI or from any process must not corrupt the screen.

- In `inline` mode, each line is written above the view, which is redrawn below it. The log scrolls and the view stays at the bottom.
- In `fullscreen` mode, lines are held and written to the normal screen when the TUI closes (decision D3).

## 8. Time

Time is real. This replaces the prototype's virtual clock.

- `(host::now)` is the number of milliseconds since the image started, from a monotonic clock, as an integer. It never goes backwards and is unaffected by changes to the wall clock.
- `(timer::sleep ms)` blocks the process until `host::now` is at least `now + ms`.
- `host::wait` suspends the image for real time (section 9).

A **virtual clock** exists for testing only. It is an option of the host's
`Runtime` constructor, `clock: 'virtual'`. No CPI code and no command-line
flag can select it. Under it, `host::now` starts at 0 and moves only when
`host::wait` jumps it to the next deadline, so runs are exact and repeatable.

A program whose correctness depends on the exact values of the virtual clock
is a test fixture, not a program (decision D5).

## 9. `host::wait` (amends SPEC-CPI section 10.3)

`(host::wait timeout)` suspends the image until one of these happens, then
returns the list of PIDs that became `ready`:

- a sleeping process's deadline passes;
- an input event is waiting to be delivered (section 6);
- `timeout` milliseconds pass (`#false` for no timeout).

On return, every due sleeper has been woken and every held input event has
been delivered. If nothing can happen (no sleepers, no subscription) and there
is no timeout, `host::wait` returns `()` at once.

An input event makes no process ready. The CPI learns of it from its mailbox:
`(mailbox::size addr)` after `host::wait`.

## 10. Failure

If the CPI fails (SPEC-CPI section 12), or the image exits for any other
reason while the TUI is open, the host must close the TUI and restore the
terminal before it reports anything. An error report must never be drawn
into a view or lost in the alternate screen.

A CPI that never returns from a loop cannot be interrupted from the keyboard,
because input is handled only when the CPI suspends or renders. This is
DESIGN-001 open question 4 (decision D7).

## 11. Testing

The host provides a **headless** TUI for tests, selected, like the virtual
clock, only through the `Runtime` constructor. It renders each view to text
with the same renderer and records it, and a test can inject input events. A
test can therefore assert exact screens and drive a CPI's interaction
deterministically.

## 12. What this changes elsewhere

**SPEC-CPI**
- §10.3 `host::wait`: its wake sources and the delivery of input events (section 9 here).
- §10.3 `host::now`: milliseconds since the image started, monotonic (section 8).
- §8: a host request may take real time before it resumes the process (`tui::render` does). SPEC-CPI already allows this ("a handler whose work takes time leaves the process blocked").

**The prototype**
- The prototype decision "time is virtual" is replaced by section 8.
- `Runtime.boot` becomes asynchronous: `host::wait` and `tui::render` await real events. Other host requests stay synchronous.
- Programs that print `host::now` produce different numbers from run to run under the real clock. Tests pin them with the virtual clock.

**DESIGN-001**
- Section 11 (external events as message streams) gains its first concrete stream: terminal input.
- Nothing here pushes against the design. `tui::` is a privileged handler namespace, views are values, input is messages, and the native-code boundary is unchanged.

## 13. Decisions for review

| # | Decision | Recommendation | Alternative |
| --- | --- | --- | --- |
| D1 | When a view is drawn. | Before `tui::render` returns (section 5). Busy CPIs stay visible, and pacing is the CPI's job. | Only during `host::wait`, as Tk does: automatic coalescing, but a busy CPI shows nothing. |
| D2 | When input events enter mailboxes. | Only during `host::wait` (section 6), so external events have one entry point. | Whenever the host gets control (e.g. during `tui::render`): lower latency, but a CPI's mailboxes could change during a render. |
| D3 | `IO::print` in fullscreen mode. | Hold lines and write them after close. The CPI shows logs in its own views. | Write them to stderr (visible only if redirected), or deliver them to a CPI mailbox as `(output pid line)` so the CPI decides. |
| D4 | What `host::now` measures. | Monotonic milliseconds since the image started. | Wall-clock time, which jumps with clock changes. That belongs in a separate `clock::` namespace if needed. |
| D5 | Examples that depend on exact virtual time. | `examples/life/12-timer-wheel.slight` decodes cell positions from exact wake times, so under a real clock it computes wrong boards. Keep it only as a test fixture that runs with the virtual clock, and say so in its header. `04-metronome` and `tests/programs/timers.slight` depend on the order of wake-ups, not exact times, so they should stay correct and only their printed times vary. That needs checking once the real clock exists. | Rework 12 so it doesn't need exact times, or remove it. |
| D6 | Ctrl-C. | An ordinary event while subscribed; ends the image otherwise (section 6). | Always end the image, which gives the CPI no chance to shut down cleanly. |
| D7 | A CPI that never yields. | Leave it as DESIGN-001 open question 4 for now. | Run the CPI in a worker thread, so the host's thread can always draw, take Ctrl-C and stop a runaway CPI. This is a bigger change to the host, and a possible answer to open question 4 later. |
| D8 | Unknown props. | `type-error` against the table in section 3.3: typos surface at once, and the prop list stays portable to a web renderer. | Pass everything through to the renderer (Ink silently ignores unknown props). |

## Appendix: implementation notes (not normative)

- `spike/tui/sxml.ts` already implements section 3.1 and the component allowlist. It lacks the prop table (D8) and `key`.
- Ink options: `exitOnCtrlC: false` (Ctrl-C is routed by the host), `patchConsole: false`, `alternateScreen` for `fullscreen`, and `waitUntilRenderFlush()` after each `rerender` for section 5. Inline `IO::print` output can use Ink's `Static` region.
- Input: a small host-side component using Ink's `useInput` pushes events into a host buffer, which `host::wait` delivers.
- Headless: Ink's `renderToString`, with no terminal needed.
