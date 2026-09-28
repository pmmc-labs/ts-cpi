# Specification: TUI namespace (draft)

Sep 26, 2026 · Accepted and implemented · Extends `../../design-xxx/SPEC-CPI.md`

Sep 28, 2026 · Charts (sections 3 and 15) accepted and implemented

Sep 28, 2026 · Tables (sections 3 and 16) accepted and implemented

This document specifies `tui::`, a privileged namespace through which the CPI
presents what it is managing on a terminal and receives keyboard input. It
also specifies the changes to time and to `host::wait` that interactive use
requires. Section 13 records the decisions made in review.

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
- The props list `(@ ...)` is optional. Each prop is a two-element list of a symbol and a value. A value is a string, a symbol (which stands for the string of its name), an integer, a float or a boolean. The data props of chart components (section 3.3) take lists, in the shapes their rows describe. A list in any other prop is a `type-error`.
- Each child is one of:
  - an element;
  - a string or number, which is text, and allowed only inside `Text`;
  - a list of children, which is spliced in place, so `(map row-view rows)` can be a child;
  - `()` or `#false`, which renders nothing, so `(and show? view)` can be a child.
- Children are identified by position. A `key` prop may be given to an element whose position among its siblings changes between frames.
- `Newline` may appear only inside a `Text`.

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
| `Sparkline` | none | A one-row trend of a list of numbers. |
| `BarChart` | none | Horizontal bars, one row per labelled value. |
| `StackedBarChart` | none | One bar divided into labelled segments. |
| `LineGraph` | none | One or more series of numbers as lines, several rows high. |

| `Table` | `Row` elements | Rows of cells laid out in columns (section 3.3.2). |
| `Row` | cells | One row of a `Table`. Only inside a `Table`. |
| `Cell` | what a `Text` may hold, or one chart | One cell with its own alignment or span. Only inside a `Row`. |

Chart components are drawn by the host from the numbers the view gives them (section 15). They may not be inside a `Text`, and neither may a `Table`.

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

### 3.3.1 Chart props

Chart components take only the props below. A color is a string or symbol
naming one of Ink's colors (`red`, `cyan`, `gray`, `blueBright`, ...) or a hex
code (`"#1baf7a"`). A label is a string. A number is an integer or a float.

**`Sparkline`**

| Prop | Value | Meaning |
| --- | --- | --- |
| `data` | a list of numbers | Required. Oldest first. |
| `width` | an integer | Columns. Default: one per value. With fewer values than columns, the values are right-aligned, so the newest is always at the right edge. With more, the oldest are dropped. |
| `min`, `max` | numbers | The values drawn empty and full height. Default: 0 and the largest value. A fixed `max` keeps heights comparable from frame to frame. |
| `color` | a color | |
| `underline` | a boolean | Underlines the whole width, so empty positions still show as a line. |
| `mode` | `block` or `braille` | Block characters, one value per column, or braille, two values per column. Default `block`. |

**`BarChart`**

| Prop | Value | Meaning |
| --- | --- | --- |
| `data` | a list of `(label value)` or `(label value color)` | Required. One row each, in order. |
| `width` | an integer | Columns for the whole chart, labels and values included. |
| `max` | a number | The value drawn full width. Default: the largest value. |
| `showValue` | `right`, `inside` or `none` | Where each value is written. Default `right`. |
| `suffix` | a string | Written after each value shown, e.g. `" ms"` or `"%"`. |
| `sort` | `none`, `asc` or `desc` | Default `none`. |
| `color` | a color | For rows that give none. |
| `barChar` | one of `"█"`, `"▆"`, `"▓"`, `"▒"`, `"░"` | |

**`StackedBarChart`**

| Prop | Value | Meaning |
| --- | --- | --- |
| `data` | a list of `(label value)` or `(label value color)` | Required. The segments, left to right. |
| `mode` | `percentage` or `absolute` | Each segment's share of the whole bar, or its value against `max`. Default `percentage`. |
| `max` | a number | The value drawn full width in `absolute` mode. Default: the sum of the values. |
| `width` | an integer | Columns. |
| `showLabels`, `showValues` | booleans | Labels above the bar, values below it. Default `#true`. |
| `suffix` | a string | Written after each value shown. |

**`LineGraph`**

| Prop | Value | Meaning |
| --- | --- | --- |
| `data` | a list of lists of numbers | Required. One list per series, oldest first. |
| `colors` | a list of colors | One per series, in order. |
| `width` | an integer | Columns. |
| `height` | an integer | Rows. Default 10. |
| `min`, `max` | numbers | The range of the vertical axis. Default: the range of the data. |
| `showYAxis` | a boolean | Labels the vertical axis. |
| `xLabels` | a list of strings | Spread evenly under the horizontal axis. |
| `caption` | a string | Written under the graph. |

For example, the gateway monitor's request-rate column and its loop split:

```lisp
`(Sparkline (@ (data ,rates) (width 20) (color cyan) (underline #true)))

`(StackedBarChart (@ (width 40) (showValues #false)
    (data (("run" ,run blue) ("other" ,other yellow) ("draw" ,draw magenta) ("wait" ,wait gray)))))
```

### 3.3.2 Tables

```lisp
(Table (@ (columns (("endpoint" 10) ("queue" 7 right) ("req/s" 7 right) ("requests" auto right))))
    (Row "hello" 0 12 (Text (@ (color green)) "<1ms"))
    (Row "counter" 3 1 "-")
    (Row (@ (bold #true)) "total" 3 13 "-"))
```

- **Columns** are data: the `columns` prop is a list of `(title width)` or `(title width align)`. `width` is a number of columns, or `auto` for the widest cell in the column, title included. `align` is `left` (the default), `right` or `center`.
- **Rows** are children: each `Row` holds one cell per column, in order. A row with fewer cells leaves the rest empty; a row with more is a `type-error`.
- **A cell** is anything a `Text` may hold (a string, a number, a `Text` element, or a list of those, spliced), or a chart component. A `Cell` element sets a cell's own alignment or makes it span columns: `(Cell (@ (span 3) (align right)) "queue")`.
- **Text that does not fit** in its column is truncated with an ellipsis. A chart is given its column's width unless it sets its own.

**`Table`**

| Prop | Value | Meaning |
| --- | --- | --- |
| `columns` | a list of `(title width)` or `(title width align)` | Required. `width` is an integer or `auto`; `align` is `left`, `right` or `center`. |
| `header` | a boolean | Draws the titles as the first row, dimmed. Default `#true`. |
| `gap` | an integer | Spaces between columns. Default 1. |

**`Row`**: the text styles of `Text` (`color`, `bold`, `dimColor`, ...), applied
to every cell in the row that does not set its own.

**`Cell`**: `span` (an integer, default 1), `align` (as for a column), and the
text styles of `Text`.

For example, the gateway's since-start table, with a group header over each
min / avg / max triple:

```lisp
`(Table (@ (header #false)
        (columns (("" 12) ("" 9 right) ("" 5 right) ("" 7 right) ("" 6 right) ...)))
    (Row (@ (dimColor #true)) "since start" "requests"
        (Cell (@ (span 3) (align center)) "queue") (Cell (@ (span 3) (align center)) "req/s") ...)
    (Row (@ (dimColor #true)) "" "" "min" "avg" "max" "min" "avg" "max" ...)
    ,@(map summary-row endpoint-names))
```

### 3.4 Errors

`tui::render` checks the whole view before anything is drawn. A malformed
view throws `type-error` from the `tui::render` call, with the offending part
of the view as the payload. The screen is unchanged. For a chart, a `data`
list of the wrong shape, a non-number where a number belongs, an unknown
color, or a missing `data` prop is such a malformed view. So are a `Row`
outside a `Table`, a `Cell` outside a `Row`, anything but `Row` elements in a
`Table`, a row with more cells than columns (spans counted), a `span` below
1, and a malformed `columns` list.

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

- In `inline` mode, each line is written above the view, which is redrawn below it. The log scrolls and the view stays at the bottom. A line appears when the screen is next drawn: at the latest by the next `tui::render`, `host::wait` or `tui::close`.
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
with the same renderer and records it. Input comes from a script: under the
virtual clock, when the CPI subscribes and calls `host::wait` with no input
held, the next scripted event arrives instead of time passing. A test can
therefore assert exact screens and drive a CPI's interaction
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

## 13. Decisions

| # | Decision | Decided (Sep 26, 2026) | Alternative considered |
| --- | --- | --- | --- |
| D1 | When a view is drawn. | Before `tui::render` returns (section 5). Busy CPIs stay visible, and pacing is the CPI's job. | Only during `host::wait`, as Tk does: automatic coalescing, but a busy CPI shows nothing. |
| D2 | When input events enter mailboxes. | Only during `host::wait` (section 6), so external events have one entry point. | Whenever the host gets control (e.g. during `tui::render`): lower latency, but a CPI's mailboxes could change during a render. |
| D3 | `IO::print` in fullscreen mode. | Hold lines and write them after close. The CPI shows logs in its own views. | Write them to stderr (visible only if redirected), or deliver them to a CPI mailbox as `(output pid line)` so the CPI decides. |
| D4 | What `host::now` measures. | Monotonic milliseconds since the image started. | Wall-clock time, which jumps with clock changes. That belongs in a separate `clock::` namespace if needed. |
| D5 | Examples that depend on exact virtual time. | `examples/life/12-timer-wheel.slight` decodes cell positions from exact wake times, so under a real clock it computes wrong boards. Keep it only as a test fixture that runs with the virtual clock, and say so in its header. `04-metronome` and `tests/programs/timers.slight` depend on the order of wake-ups, not exact times, so they should stay correct and only their printed times vary. That needs checking once the real clock exists. | Rework 12 so it doesn't need exact times, or remove it. |
| D6 | Ctrl-C. | An ordinary event while subscribed; ends the image otherwise (section 6). | Always end the image, which gives the CPI no chance to shut down cleanly. |
| D7 | A CPI that never yields. | Leave it as DESIGN-001 open question 4 for now. | Run the CPI in a worker thread, so the host's thread can always draw, take Ctrl-C and stop a runaway CPI. This is a bigger change to the host, and a possible answer to open question 4 later. |
| D9 | Who draws charts (Sep 28, 2026). | The host, as components (section 3.2): the CPI passes numbers, and drawing leaves the interpreter and the CPI's loop. | CPI code builds them as text, costing interpreter time in the loop for every character. |
| D10 | Which props take lists. | Only chart data props (`data`, `colors`, `xLabels`). | Any prop: more general, but nothing else needs it, and it weakens the check that catches a list passed by mistake. |
| D11 | Which charts. | `Sparkline`, `BarChart`, `StackedBarChart`, `LineGraph`. | Two first, the rest when a monitor needs them. |
| D12 | Formatting values. | A `suffix` string. | No formatting, or a format string, which is a small language of its own. |
| D13 | The chart library. | A host detail, as Ink is (section 1). | All four written in the host, with no new dependency. |
| D14 | How table rows are given (Sep 28, 2026). | As `Row` children holding view content, so cells can be coloured pieces or charts. | As data, a `rows` prop of lists of atoms: simpler to check, but cells could hold only plain text. |
| D15 | Column widths. | A fixed width, or `auto` for the widest cell. | Fixed widths only. |
| D16 | Spanning cells. | `Cell` with `span`, for grouped headers. | No spans. |
| D17 | Borders and rules in tables. | None for now. | `borderStyle` and rules between rows. |
| D18 | Numbers in cells. | Shown as `IO::print` shows them; formatting stays with the CPI. | Per-column number formats. |
| D8 | Unknown props. | `type-error` against the table in section 3.3: typos surface at once, and the prop list stays portable to a web renderer. | Pass everything through to the renderer (Ink silently ignores unknown props). |

## Appendix: implementation notes (not normative)

- `spike/tui/sxml.ts` already implements section 3.1 and the component allowlist. It lacks the prop table (D8) and `key`.
- Ink options: `exitOnCtrlC: false` (Ctrl-C is routed by the host), `patchConsole: false`, `alternateScreen` for `fullscreen`, and `waitUntilRenderFlush()` after each `rerender` for section 5. Inline `IO::print` output can use Ink's `Static` region.
- Input: a small host-side component using Ink's `useInput` pushes events into a host buffer, which `host::wait` delivers.
- Headless: Ink's `renderToString`, with no terminal needed.

## 14. Open issues

- ~~**Views can show only strings and numbers.**~~ *Resolved Sep 26, 2026* by the core operation `(value->string v)`, which returns the text `IO::print` shows for any value (proposed SPEC-CPI §5.6 text in the prototype's `DECISIONS.md`). A view shows a value as `(Text ,(value->string v))`.

## 15. Charts

Accepted and implemented Sep 28, 2026 (decisions D9 to D13). The text
above, in sections 3.1 to 3.4, is where they are specified; this section
records why, what was left out, and what they measured.

### 15.1 Why

The CPI is for experimenting with concurrency, and `tui::` is how an
experiment shows what it is doing. Charts are therefore most of what a
monitor draws: throughput over time, latency, where the loop's time goes.

Today a chart is text that CPI code builds: a sparkline is a string of block
characters made one value at a time in the interpreter. The gateway monitor
(`examples/gateway/`) measured the cost. A frame takes 13 to 23 ms, and 40
to 55% of it is building the view in CPI code. Every one of those
milliseconds is time no process runs, because the monitor is a step in the
CPI's loop.

The division of labour that `tui::` already has applies here too: the CPI
decides what to show, and the host draws it. With chart components, the CPI
passes numbers and the host turns them into characters. Views stay plain
data, since a chart's data is numbers and labels, so a view can still be
logged, compared, stored and replayed.

### 15.2 Left out

- **Functions.** Charting libraries format values and choose colors with callbacks. A view is data, so a prop cannot hold a procedure; `suffix` covers the common case.
- **Color gradients by threshold.** They are useful for latency, but they need a way to say "red above 50 ms" as data. Left for when a monitor asks for it.
- **Vertical bar charts, histograms, heat maps.** Added by amending this section when an experiment needs one.

### 15.3 Implementation notes (not normative)

- `@pppp606/ink-chart` 0.2.8 (MIT; needs Ink 6 or later and React 19 or later, which the prototype has) provides `BarChart`, `StackedBarChart` and `LineGraph` with props close to these. `suffix` becomes its `format` callback, and `colors` becomes each series' `color`.
- Its `Sparkline` scales to the largest value and has no fixed `max`, right alignment or underline, so the prototype draws `Sparkline` itself (`src/tui/charts.ts`). It is a few lines of TypeScript, and it is exactly the work that moves out of the interpreter.
- The allowlist in `src/tui/views.ts` gains the four components. The data props are converted and checked there, so the chart library never sees a malformed value.
- The headless backend renders charts with the same `renderToString`, so tests can assert on them.
- The library's `BarChart` and `StackedBarChart` take `width` as the whole chart's width, labels and values included, and section 3.3.1 says the same. (The proposal said the longest bar's width; it changed to match what a fixed-width box needs.)

### 15.4 What it measured

The gateway monitor switched its two sparkline columns to `Sparkline` and
added a `StackedBarChart` of the loop's split. It ran on a pseudo-terminal
under 20 requests a second for 15 seconds, three times each way, alternating:

| Per frame | Text built by CPI code | Host charts |
| --- | --- | --- |
| 4 fps: building / painting | 15.7 / 14.7 ms | 12.9 / 15.8 ms |
| 30 fps: building / painting | 6.6 / 8.3 ms | 5.4 / 9.1 ms |

Building fell by 18%, and painting rose by about 1 ms for the extra
components. The sparklines were about a fifth of the building: most of the
rest is the monitor's tables (cells, padding, worker marks), still built in
CPI code. A table component is the next candidate.

## 16. Tables

Accepted and implemented Sep 28, 2026 (decisions D14 to D18); specified in
sections 3.2 to 3.4. This section records why and what they measured.

### 16.1 Why

Section 15.4 found that the sparklines were a fifth of the cost of building
the gateway monitor's view; most of the rest is its two tables. Each cell is a
`Box` with a width, padding and alignment, and every number is padded to a
fixed width in CPI code so it stays in place as it changes. All of that is
layout: work the host is better placed to do, and work that costs the CPI's
loop interpreter time on every frame.

A table component takes rows of cells and does the layout: column widths,
alignment, truncation and spacing. The CPI still decides what each cell says
and how it looks.

### 16.2 Implementation notes (not normative)

- `Table`, `Row` and `Cell` are converted in `src/tui/views.ts` and laid out in `src/tui/table.ts`. `auto` widths are measured with `string-width`, which Ink uses to measure text.
- A row whose cells are all text or `Sparkline`s is padded and aligned in the host and drawn as a single `Text` line. A row holding a chart that Ink lays out with boxes (`BarChart`, `StackedBarChart`, `LineGraph`) gets a fixed-width `Box` per cell.
- `ink-table` was considered. It takes data as JavaScript objects with a callback per cell, draws a bordered grid, and was last updated for Ink 3.

### 16.3 What it measured

The gateway monitor's two tables became `Table`s. Three runs each way, on a
pseudo-terminal under 20 requests a second, per frame:

| | Tables built in CPI code | `Table`, a `Box` per cell | `Table`, rows as lines |
| --- | --- | --- | --- |
| 4 fps: building / painting / total | 12.8 / 17.2 / 30.0 ms | 5.7 / 24.9 / 30.6 ms | 5.8 / 18.9 / 24.7 ms |
| 30 fps: building / painting / total | 5.7 / 9.3 / 15.0 ms | 2.5 / 11.9 / 14.4 ms | 3.1 / 10.4 / 13.5 ms |

The first version made the same boxes in TypeScript that the CPI had made in
the language: building halved, but painting rose by as much, because the
cost was Ink laying out about 150 boxes, not the interpreter building them.
Drawing each row as one line of text removed most of those boxes. A frame is
now 18% cheaper at 4 fps and 10% at 30 fps, and building it is half what it
was. What remains is mostly Ink's own rendering of the frame.
