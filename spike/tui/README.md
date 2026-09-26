# TUI spike: views as data, rendered by Ink

A spike for the `tui::` namespace: can CPI code describe a screen as a plain
s-expression, and can the host render it with Ink (React for terminals)?
Yes, and cheaply.

```sh
node spike/tui/preview.ts spike/tui/sample.sxml 60   # views written by hand, rendered to text
node spike/tui/live.ts                               # views built by CPI code, animated in the terminal
node --test tests/tui-spike.test.ts
```

## The view encoding

SXML's shape: `(Tag (@ (prop value) ...) child ...)`.

```lisp
(Box (@ (flexDirection column) (borderStyle round) (paddingX 1))
    (Text (@ (bold #true) (color green)) "life · generation " 4)
    (Text "#.#....."))
```

- `Tag` must be on the host's allowlist: `Box`, `Text`, `Newline` and `Spacer` so far. The allowlist is the capability surface.
- A prop value that is a symbol becomes a string, so `(flexDirection column)` needs no quotes. Integers become numbers.
- Strings and numbers are text, allowed only inside `Text`.
- A child that is a list of views is spliced in, so `(map row-view board)` works as a child. `()` and `#false` render nothing, so `(and show? view)` works.
- Children are positional, so React needs no keys.

`sxml.ts` is the whole binding, about 100 lines: it walks the view and calls
`React.createElement(tag, props, ...children)`, which is already
s-expression shaped. JSX is not involved (Node's type stripping could not
run `.tsx` anyway).

## What the spike showed

1. **Headless rendering is built into Ink 7.** `renderToString` renders synchronously with no terminal. Tests can assert exact screens, and no extra testing library is needed.
2. **Live rendering works as hoped.** One `render`, then a `rerender` per frame. Ink wraps each frame in synchronized-output escapes, so there is no flicker. It redraws the whole frame by default (an `incrementalRendering` option exists). When stdout is not a TTY (piped, CI), Ink writes only the final frame, which is the right behavior for logs.
3. **React stays out of sight.** No hooks, no component state and no JSX: the CPI owns all state and hands over a complete view each frame.
4. **Flexbox rules apply, including the surprising ones.** Items shrink by default, as in CSS, so a fixed-width panel next to a long line gets squeezed unless it has `(flexShrink 0)`. CPI authors will need a short layout guide.
5. **Building views without quasiquote is clumsy.** `spike/tui/life-view.slight` builds views with `cons`, `list2` and `list3`. Writing it, I hit an `arity-error` from using `list3` for a four-element view. That is evidence for adding quasiquote as a derived form.
6. **Colors depend on the terminal.** Chalk turns color off when stdout is not a TTY, so headless output (and the tests) are plain text. That keeps assertions stable.

## Open for the real implementation

- **When frames paint.** Ink paints on the Node event loop, but today the CPI's `boot` loop is synchronous and never yields. With the planned async `host::wait`, frames would paint when the CPI waits, which is a natural frame boundary. Until then, `tui::render` could only record the latest view.
- **Input.** Keystrokes need a small host-side component (Ink's `useInput`) that posts `(key ...)` messages to the CPI's subscribed mailbox.
- **Terminal ownership.** `IO::print` output needs routing once Ink owns stdout, and the terminal must be restored before a failed CPI's error is reported.
