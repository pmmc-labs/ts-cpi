# Decisions

Decisions made while building the CPI prototype. Sources of truth, in order:
`../../design-xxx/DESIGN-001.md`, `../../design-xxx/SPEC-CPI.md`, the prototype
choices in `prompt.md`, then the simplest consistent behavior.

## Prototype decisions

- Integers are `bigint`, checked to fit 64 bits; floats are JS numbers.
- Strings are JS strings; `string-length` and `string-ref` count Unicode scalar values.
- Addresses come from a counter: unique, not unguessable.
- Binding hash: SHA-256 over resolved names in sorted order with the printed form of each value.
- Time is real (SPEC-TUI section 8): `host::now` is monotonic milliseconds since the image started, and `timer::sleep` and `host::wait` take real time. The virtual clock (milliseconds from 0, moved only by `host::wait`) is a `Runtime` option for tests only; no CPI code or CLI flag can select it. Every test uses it. *(Replaced "time is virtual", Sep 26, 2026.)*
- `Runtime.boot` is asynchronous. `host::wait`, `timer::sleep` in the CPI, and the `tui::` requests that draw may take real time; every other request is answered at once, and a process's requests always are.
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
- `actor::` requests from the CPI throw `bad-state`: the CPI has no process layer (SPEC-CPI section 1). `timer::sleep` in the CPI suspends the whole image for that long (on the virtual clock, it advances the clock at once).
- `host::wait` (SPEC-TUI section 9) wakes on a sleeper's deadline, a held input event, or its timeout. With nothing that can happen and no timeout, it returns `()` at once; with a timeout, the timeout passes.
- PIDs are interned like symbols, so every PID value for one process is the same object and `eq?` holds (before, PIDs returned by `host::wait` were fresh objects). *Since Sep 29, 2026,* each process's one PID value is kept on its entry instead of in a global table, which kept every PID alive (see "Reclaiming what nothing can name").
- `tui::` follows SPEC-TUI, accepted Sep 26, 2026 with every recommended decision (D1 to D8), and its charts, accepted Sep 28, 2026 (D9 to D13): `Sparkline` is drawn in `src/tui/charts.ts`, the other three adapt `@pppp606/ink-chart` 0.2.8, and `src/tui/views.ts` checks chart props before the library sees them. Tables, accepted Sep 28, 2026 (D14 to D18), are laid out in `src/tui/table.ts`: a row of text and `Sparkline`s is drawn as one line, other rows with a `Box` per cell (SPEC-TUI section 16.2). The terminal backend is Ink (`src/tui/terminal.ts`); tests use the headless backend (`src/tui/headless.ts`), whose scripted input arrives in place of time passing under the virtual clock.
- `http::` follows SPEC-HTTP, accepted Sep 28, 2026 with every recommended decision (D1 to D6). The real backend is `node:http` on 127.0.0.1 (`src/http/node.ts`); tests use the headless backend (`src/http/headless.ts`), whose scripted requests arrive in place of time passing under the virtual clock. A request is handed to the runtime once its whole body has arrived. Keys and requests held until `host::wait` are each delivered in arrival order, keys first. On the real clock a timer per request answers 504 at its deadline, so a busy CPI does not delay it; `host::wait` and every send to a reply address also answer any reply whose deadline has passed on `host::now`.
- On the real clock, `host::wait` gives the host's event loop one turn before it checks for input, even with a timeout of 0. Without it, `(host::wait 0)` returned before the host had read anything, so a CPI that was never idle took in no requests or keys: the gateway's pool never grew under 50 concurrent clients (`tests/http.test.ts`, "(host::wait 0) takes in requests while the CPI stays busy").
- The headless HTTP backend's scripted requests carry an arrival time (`after` the previous one, 0 by default); requests due together arrive in one `host::wait`, and the virtual clock moves to the next arrival as to a sleeper's deadline (SPEC-HTTP section 8).
- `host::wait` returns the receivers woken by the keys and requests it delivered, not only due sleepers (SPEC-CPI section 10.3, "the PIDs that became ready"). Before SPEC-HTTP it returned sleepers only.
- `examples/life/12-timer-wheel.slight` is a virtual-clock test fixture (SPEC-TUI decision D5); `examples/life/run.sh` refuses to run it. All other Life versions print the reference frames on the real clock.

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

## Spec changes

Changes to the language agreed during the prototype, written as proposed text
for SPEC-CPI. `../../design-xxx` is not edited from here.

### Quasiquote and `append` (2026-09-26)

**Section 3, Reader.** Add:

- **Quasiquote**: `` `x `` reads as `(quasiquote x)`, `,x` as `(unquote x)` and `,@x` as `(unquote-splicing x)`. `` ` `` and `,` end a symbol.

**Section 4.1, Derived forms.** Add a row:

| Form | Expands to |
| --- | --- |
| `` `template `` | Constructor calls that build `template`, with each `,x` replaced by the value of `x` and each `,@x` by the elements of the list `x`: `` `(a ,b ,@c d) `` is `(cons 'a (cons b (append c (cons 'd ()))))`. Parts with no unquote stay quoted. A `,@x` at the end of a list becomes the tail itself, without a copy. `unquote` or `unquote-splicing` outside a quasiquote, `,@` not directly inside a list, and a nested quasiquote are each a `load-error`. |

`quasiquote`, `unquote` and `unquote-splicing` are reserved like the other derived forms.

**Section 5.5, Pairs.** Add a row:

| Signature | Result | Errors |
| --- | --- | --- |
| `(append a b)` † | A list of the elements of `a` followed by `b`. `b` is not copied. | `type-error` if `a` is not a proper list. |

Rationale: views are data (see `spike/tui/`), and building data without quasiquote means long chains of `cons` calls. Splicing needs `append`, and a derived form may expand only to core operations, so `append` joins the core, marked † like `string-append`. Nested quasiquote is left out until a real use appears.

### `value->string` (2026-09-26)

**Section 5.6, Strings.** Add a row:

| Signature | Result | Errors |
| --- | --- | --- |
| `(value->string v)` † | The text `IO::print` shows for `v`: a string is returned unchanged, and any other value in its printed form, e.g. `"(blocked recv)"`, `"#<pid 3>"`, `"#<error boom \"reached 300\">"`. | None. |

Rationale: a CPI that shows its state in a view (SPEC-TUI) needs values as text, and before this the language had no way to turn a number, list or error into a string. The printed form of an address, PID or env ref describes it and cannot be turned back into it: nothing converts a string to an address, so the result grants no authority.

### `list`, `string-append`, `string-join`, `rethrow` and vectors (2026-09-27)

*Status.* Agreed and implemented 2026-09-27: option A, `string-join` takes the separator first, strings only, no reader syntax for vectors yet. Tests in `tests/additions.test.ts`; the tutorial covers them. Done before building environments from roles. From the field notes: every worker wrote list and string helpers, random access is a list walk, and a caught error cannot be passed on unchanged.

*What the examples do today.* The shared libraries define `list2` and `list3`, called 97 and 39 times in 27 and 17 files. `list-ref`, a walk down the list, is called 135 times in 25 files. Text is built by folding a two-argument `string-append` over a list (the runner's `rn-pair-line` and `rn-sparkline`, and a helper in two engines), which copies the text so far at every step. No program binds `list`, `vector`, `string-join` or `rethrow`, or uses `string-append` as a value, so none of the names below breaks existing code.

*The arity question.* Section 5 gives every core operation a fixed arity, and section 5.1 turns a core operation used as a value into a closure of that arity. `lambda` has no rest parameters, so a variadic operation has no closure form. The options:

- **A. Variadic core operations** (recommended). `list`, `string-append` and `vector` take any number of arguments, and using one anywhere but the head of an application is a `load-error`. Nothing is lost: applying one to a list of arguments is the identity for `list`, `string-join` with `""` for `string-append`, and `list->vector` for `vector`.
- **B. Derived forms.** `(list a b c)` expands to `(cons a (cons b (cons c ())))`, like quasiquote, and `(string-append a b c)` to nested two-argument calls. It needs no new rule for arities, but `string-append` would then be a core operation for two arguments and a derived form for any other number, and a call would cost one tick per argument.
- **C. Rest parameters for `lambda`.** Variadic operations would then have closure forms, and user procedures could be variadic. It is the most general option and the largest change; it can come later without disturbing A.

**Section 5, Core operations.** Change the second sentence of the first paragraph to: "Each has a fixed arity, except the variadic operations `list`, `string-append` and `vector`, and each application costs one tick."

**Section 5.1.** Add: "A variadic core operation has no closure form: using its name anywhere other than the head of an application is a `load-error`."

**Section 5.5, Pairs.** Add a row:

| Signature | Result | Errors |
| --- | --- | --- |
| `(list a ...)` † | A new list of the arguments, in order. `(list)` is `()`. | |

**Section 5.6, Strings.** Replace the `string-append` row and add one:

| Signature | Result | Errors |
| --- | --- | --- |
| `(string-append s ...)` † | A new string: the arguments joined in order. `(string-append)` is `""`. | `type-error` unless every argument is a string. |
| `(string-join sep strings)` † | A new string: the elements of the list `strings` with `sep` between each two, as in Perl's `join`. `(string-join sep ())` is `""`. | `type-error` unless `sep` is a string and `strings` a proper list of strings. |

**Section 2.1, Types.** Add a row:

| Type | Written | Notes |
| --- | --- | --- |
| Vector | none | Immutable, fixed length, indexed from 0. Printed as `#(1 2 3)`; the reader has no syntax for vectors, so quoted data cannot contain one. |

**Section 5.3.** In `eq?`, vectors compare by identity, like pairs.

**Section 5.4.** Add `(vector? a)`.

**Section 5.9, Vectors** (new):

| Signature | Result | Errors |
| --- | --- | --- |
| `(vector x ...)` † | A new vector of the arguments, in order. | |
| `(make-vector n fill)` † | A new vector of `n` elements, each `fill`. | `type-error`; `range-error` if `n` is negative. |
| `(vector-length v)` | The number of elements. | `type-error`. |
| `(vector-ref v i)` | The element at index `i`. | `type-error`; `range-error`. |
| `(vector-set v i x)` † | A new vector equal to `v` except that index `i` holds `x`. `v` is unchanged. | `type-error`; `range-error`. |
| `(list->vector l)` †, `(vector->list v)` † | Conversion. | `type-error` unless `l` is a proper list, or `v` a vector. |

**Section 2.3, Errors.** `range-error`: "An index is outside its string or vector, or a length is negative."

**Section 5.8, Errors.** Add a row:

| Signature | Result | Errors |
| --- | --- | --- |
| `(rethrow e)` | Does not return. Throws `e` again, with the context recorded when it was first thrown. Nothing new is recorded. | `type-error` if `e` is not an error; `bad-state` if `e` has never been thrown. |

**Section 7.5.** Replace "An error is thrown at most once. A handler that wants to pass an error on wraps it with `wrap-error` and throws the new error, so each error in the chain keeps its own trace and the chain records the whole history of the failure." with: "An error's context is recorded at most once, by its first `throw`. A handler passes an error on unchanged with `rethrow`, which keeps that context, or adds to it by wrapping the error with `wrap-error` and throwing the new one, so each error in the chain keeps its own trace and the chain records the whole history of the failure." `bad-state` in section 2.3 also covers `rethrow` of an error that has never been thrown.

Rationale:

- **`list` and variadic `string-append`** replace helper families that every program redefines. One tick per application, marked †, is how `append` already works.
- **`string-join`** builds a line in one pass instead of one copy per piece, and drawing the board is where the Life runner spends most of its time outside the engine.
- **`rethrow`** is cleanup that leaves the error alone: `(catch (work) e (do (cleanup) (rethrow e)))`. The caller sees the original tag, and the trace points at the original failure. `wrap-error` stays the way to add context. `throw` still refuses an error that was thrown before, so a second `throw` by mistake is still caught.
- **Vectors** give constant-time `vector-ref`, which is what the 135 `list-ref` calls want. They are kept simple on purpose: `vector-set` copies (†), and there is no reader syntax. A persistent vector can replace the copying later without changing the interface.
- **Option A over C** because it is the smallest change that removes the helpers, and C can still be added later.

Decided: `string-join` takes the separator first, like Perl's `join` (Scheme's SRFI 130 puts it last). `string-append` and `string-join` accept strings only; `value->string` converts anything else. Vectors have no reader syntax yet, so a role's `const` cannot hold one. If the roles proposal is adopted, vectors compare element by element for composition, like pairs.

### Building environments from roles (2026-09-27)

*Status.* Agreed and implemented 2026-09-27: global names stay late-bound (SPEC-CPI sections 6 and 7.2 are unchanged, so hot reload keeps working); a role declares everything it needs from outside with `require`, host actions included; spawn, `set-env` and `unpark` check a role's host actions against grants; `const` is allowed for literal and quoted data; compacting `Conflicted` history is a strategy the user supplies. The open questions at the end were built with the defaults they propose (see Implementation). Tests in `tests/roles.test.ts`; `examples/roles.slight` and tutorial section 9 show it.

*Background.* DESIGN-001 makes a patch an environment (sections 3, 8 and 9), but SPEC-CPI section 10.4 gives the CPI no way to make one: every env ref derives from `environment::self` (see Spec issues). The model below follows p5-MXCL, where every environment is a role built by composition (`lib/MXCL/Allocator/Roles.pm`, `Context.pm` lines 116–175), and p5-slight's `Partial`, a lambda without an environment, content-addressed on its own (`lib/Slight/Term.pm`). In slight a global `defun` is already a partial: it holds no environment and resolves global names through the caller's env ref. What the CPI lacks is a way to write one that does not capture the CPI's own local scope.

A role written with `role` is **abstract** while it has `Required` slots. Composing it with other roles fills them. Resolving it checks that it can run and fixes its hashes. Nothing in a role comes from the environment of the code that wrote it.

**Section 2.1, Types.** Change the last paragraph to: "Addresses, PIDs and env refs cannot be constructed from other values. Addresses and PIDs are produced only by builtins; env refs by builtins and by `role` (section 4), whose env ref holds only code written in the source. Code holds only those it has been given."

**Section 4, Special forms.** Add a row:

| Form | Meaning |
| --- | --- |
| `(role form ...)` | An env ref for an environment built from the `form`s, each a `(defun name (param ...) body ...)`, a `(const name datum)` or a `(require name ...)`. Each `defun` becomes a `Defined` slot holding a closure with an empty local scope and no group, like a global `defun` (section 7.2): it captures nothing from where `role` appears. Each `const` becomes a `Defined` slot holding `datum`, which must be a literal (integer, float, string, boolean, `()`), a quoted datum or a tag; any other expression is a `load-error`. Each name in a `require` becomes a `Required` slot. Every name that a body uses as a global name, host request names included, must be defined in the role or named in a `require`; any other is a `load-error`. A name that is local where it is used (a parameter, `let` or local `defun`) is not a global use. Two definitions of the same name, or a definition of a special form, core operation or host request name, are a `load-error`. The value depends only on the forms. |

`role` and `require` are reserved like the other special forms.

**Section 10.4, Environments.** Add before the table:

> Two values are **identical** for composition when they are atoms (booleans, `()`, integers, floats, strings, symbols) of the same type and value; pairs whose heads and tails are identical; or closures with an empty local scope and no group whose names, parameters and expanded bodies are the same (they have the same core hash, `DESIGN-001.md` section 8). Any other two values are identical only if they are the same value.

Add rows:

| Signature | Result | Errors |
| --- | --- | --- |
| `(environment::define e name value)` | The env ref of `e` composed with an environment holding only `Defined(name, value)`. | `type-error` if `name` is not a symbol, or is a special form, core operation or host request name. |
| `(environment::required e)` | The list of names whose slots in `e` are `Required`, host request names included. | `type-error`. |
| `(environment::resolve e grants)` | `e`, once it is known to run in a process granted the namespaces in the list `grants`: every `Required` slot left is a host request name whose namespace is in `grants`. Its binding hash is fixed here. | `type-error`; `unbound`, with the list of other `Required` names as payload; `not-granted`, with the first missing namespace as payload. |
| `(environment::history e name)` | The values `name` has been defined to in `e`, oldest first: one for a `Defined` slot, every `Defined` leaf of a `Conflicted` slot in composition order, `()` for a `Required` slot or a name `e` does not have. | `type-error`. |
| `(environment::accept e names)` | The env ref of `e` with each `Conflicted` slot named in the list `names` replaced by the `Defined` slot it resolves to under the scope policy. Other names are left as they are. | `type-error`. |
| `(environment::difference a b)` | The env ref of the slots of `a` that `b` does not have with an identical slot under the same name: what composing `a` onto `b` would change. | `type-error`. |

**Section 10.1, Processes.** `process::spawn`, `process::set-env` and `process::unpark` also throw `not-granted` when their env ref has a `Required` host request name whose namespace the process is not granted: the grants given to `spawn`, or the process's own for `set-env` and `unpark`. The payload is the first missing namespace.

**Composition strategies, as a library.** Policy about history stays in the user's code. A strategy is called with each conflicted name and its history and answers `:accept` (flatten the slot) or `:retain` (keep its history). It is asked about every conflicted name on every composition, so a name tracked for a while can later be accepted:

```lisp
(defun compose-with (a b strategy)
    (let e (environment::compose a b))
    (environment::accept e (accepted-names e (environment::conflicts e) strategy)))

(defun accepted-names (e names strategy)
    (cond
        ((nil? names) ())
        ((eq? (strategy (car names) (environment::history e (car names))) :accept)
            (cons (car names) (accepted-names e (cdr names) strategy)))
        (#true (accepted-names e (cdr names) strategy))))
```

DESIGN-001's two policies are two strategies: the scope rule accepts everything, and the module rule throws on any conflict. Keeping state in a role, tracking `score` and nothing else:

```lisp
(defun track-score (name history)
    (if (eq? name 'score) :retain :accept))

(let s0 (environment::define (role) 'score 0))
(let s1 (compose-with s0 (environment::define (role) 'score 10) track-score))
(environment::history s1 'score)    ; (0 10)
(environment::lookup s1 'score)     ; 10
```

A hot reload, with the rule swapped as a role instead of as quasiquoted code:

```lisp
(defun world-code ()
    (role
        (require actor::send actor::recv)
        (require list2 make-board cell-at neighbor-count life-rule)
        (defun hr-world (gen board out)
            (actor::send out (list2 gen board))
            (actor::recv)
            (hr-world (+ gen 1) (hr-step board) out))
        (defun hr-step (board)
            (make-board (lambda (row col) (life-rule (cell-at board row col) (neighbor-count board row col)))))))

; One rule for every B/S rulestring: born and survives are parameters.
(defun bs-rule ()
    (role
        (require born survives member?)
        (defun life-rule (alive n)
            (if (= alive 1)
                (if (member? n survives) 1 0)
                (if (member? n born) 1 0)))))

(defun highlife ()
    (role
        (const born '(3 6))
        (const survives '(2 3))))

(defun seeds ()
    (role
        (const born '(2))
        (const survives ())))

; world-code and bs-rule are abstract until composed with a library, a rule and its parameters.
(defun world-env (params)
    (environment::resolve
        (environment::compose
            (environment::compose (environment::compose (board-library) (world-code)) (bs-rule))
            params)
        '(actor)))

(let env (world-env (highlife)))
(let pid (process::spawn (environment::lookup env 'hr-world) (list3 0 board out) env '(actor) #false))
; switching to Seeds changes two parameters, not the code: (process::set-env pid (world-env (seeds)));
; rolling back is (process::set-env pid env)
```

A required `const` is a parameter. Because global names are late-bound, a parameter is read by name at each use, so replacing it is an ordinary hot reload, and the role that supplies it is plain data that can be sent, stored and hashed.

Rationale:

- **Independent of the CPI's environment.** A role captures neither the CPI's local scope nor its env ref, so the code it holds means the same wherever it is composed. Anything else a role should hold, such as an address, enters through `environment::define`, where it is visible and hashed.
- **No code as data.** The bodies are ordinary source, checked by the base expander when the CPI loads, so building a patch needs no quasiquote.
- **A boundary for content hashing.** A `defun` in a role is identified by its core hash, and a role by its names and those hashes (the binding hash). Two loads of an unchanged `defun` compose without a conflict. In the prototype today they conflict: composing a module with a second load of the same source marks every closure and every list constant as conflicted, because `src/env.ts` compares them by reference.
- **Late binding keeps the hashes acyclic.** A resolved closure does not hold its role, so a role never contains itself. p5-slight bound partials to their environment early and had to mutate an interned term to tie the knot (`Compiler.pm`, `fixup_top_level_env`).
- **What a role needs is declared.** Its `require` forms are its whole interface: every name it uses from outside, and every host action. A misspelled global is a `load-error` when the CPI loads, not `unbound` at run time. `environment::required` lists what is still unfilled: the inputs to DESIGN-001's capabilities hash (section 9). `(require actor::send)` is a finer-grained statement than a namespace grant, and a process is refused at spawn instead of failing at first use.
- **Parameters without new machinery.** A `require`d name filled by another role's `const` works as a parameter of the whole role, the way a functor takes a structure. Rule tables, board sizes and presets in the Life examples become parameters.
- **An immutable record type.** Roles give named lookup and merging, which the language otherwise lacks, and `history` keeps an update's provenance for as long as the strategy retains it.
- **Strategies as library code.** SPEC-CPI section 8 would let a builtin call the strategy by splicing frames, but no host action does that yet. As library code, strategies run as ordinary CPI code: ticks are counted, errors carry traces, and the policy can be replaced. A builtin `environment::compose-with` stays an option if strategies turn out to be slow.

Consequence for section 9 (not required by this change): each loaded file could be read as a role and the files composed with the module strategy. A file's `require` forms would then be the `Required` slots the field notes asked the loader for (open question 5).

Implementation (ts-cpi):

- The expander builds a role's environment when the file loads and replaces the form with a quoted env ref (`src/expander.ts`, `expandRole`), so evaluating the same `role` form always gives the same env ref. The machine never sees `role` or `require`. The free-variable walk over the expanded bodies is `src/role.ts`.
- A name both required and defined in one role is defined: `Required` is the identity of composition. Repeating a name in `require` is allowed.
- Composition compares values by content (`identical` in `src/env.ts`). Closures that captured local variables still compare by identity (open question 2), and so do addresses, PIDs and errors. Env refs compare slot by slot.
- The binding hash descends into code: a closure hashes as `(name params body)` with any closure, vector or env ref inside it hashed the same way, and an env ref by its own binding hash. A changed `const` in a role that a `defun` returns therefore changes the enclosing environment's hash. Hashes are computed when first asked for and cached per environment (open question 3); `environment::resolve` does not compute one. Hashing the runner's 226 definitions takes about 0.6 ms, against 7 µs for a composition, so hashing eagerly in `resolve` made it 90 times slower.
- `role` works in any code, not only the CPI (open question 1); `eq?` on env refs is unchanged (open question 4); loaded files do not follow the declaration rule (open question 5).
- `environment::required` lists names in the order the role declared them; `environment::resolve` reports unfilled names before missing grants.
- Examples (Sep 27): every process in `examples/` and `tests/programs/` runs code kept in a role. Where the role needs only host actions, or only another role such as the actor library, the process runs in that composition alone. Where it needs the Life libraries, which the CPI also uses, its role is composed onto `environment::self` (`process-env` in `examples/life/lib/lists.slight`); see Spec issues.

Open questions:

1. `role` gives any code a way to make an env ref, not only the CPI. It holds only source code and constants, and using it needs the privileged namespaces, so this looks harmless.
2. A closure with a captured local scope is compared by identity, so defining the same `lambda` value twice always conflicts. Its local scope could be hashed too.
3. Hashes should be computed lazily and cached per environment: re-hashing the CPI's environment cost about 0.7 ms per park before it was cached.
4. `eq?` on env refs compares wrappers (field notes). With content-addressed roles, it could compare composition hashes.
5. Whether top-level files should follow the same declaration rule when section 9 reads them as roles. That would make every CPI program declare its host actions, which today are checked only by grants at run time.

### Several receivers on one mailbox (2026-09-28)

*Status.* Agreed and implemented 2026-09-28 with the recommended options (wake rule B, parked receivers B). Tests in `tests/runtime.test.ts` ("several receivers"); `BUILTINS.txt` and tutorial sections 5 and 7 updated.

*Motivation.* The web-worker gateway example: a router forwards requests to endpoint workers, the CPI scales each endpoint by adding workers, puts idle ones to sleep with `process::park`, and keeps pre-warmed workers in cold storage as parked state. Every worker of one endpoint receives on the endpoint's one mailbox, which then works as a queue: backlog is `mailbox::size`, and adding a worker is adding a receiver. The prototype already allows this (`process::spawn` onto a live process's address, or unparking one parked value twice), but SPEC-CPI says nothing about it (see Spec issues), and the prototype's behavior has two faults: every waiting receiver wakes for each message, and a non-durable mailbox dead-letters once its newest receiver ends, even if others still wait on it.

*What is already settled.* A process receives only on the mailbox it was given by `process::spawn` or `process::unpark`, and `actor::recv` takes no address, so holding an address never lets a process receive on it. Only the CPI attaches receivers. `actor::recv` takes the oldest message, so each message already reaches exactly one receiver. What is open is which waiting receiver wakes, when a non-durable mailbox is closed, and whether parked state may be used more than once.

*The wake rule.* The options:

- **A. Wake every waiting receiver** (the prototype today). Simple, but each message costs the CPI one wasted turn for every receiver that loses the race and blocks again.
- **B. Wake the receiver that has waited longest** (recommended). One wake per message, fair between workers, and deterministic, so scheduling stays replayable without logging who was woken.
- **C. Hand the message to one receiver when it is sent.** The woken receiver is sure to get it, but a receiver the CPI does not run for a while holds the message, parking it has to give the message back, and `mailbox::size` no longer counts the backlog.

*Parked receivers and durability.* The options:

- **A. A parked receiver counts as a receiver** (the prototype today). Messages to a parked actor are kept even on a non-durable mailbox, so within one image durability changes nothing.
- **B. A parked receiver does not count** (recommended). This is what the spec already implies: a parked PID is ended (section 10.1), and a non-durable mailbox whose process has ended dead-letters (section 10.2). A durable mailbox is then what lets an actor sleep, as DESIGN-001 section 6 says: "With a durable mailbox, messages can be sent to an actor whether or not it is running." Every example that sends to a parked actor already uses a durable mailbox.

**Section 10.1, Processes.** In `process::spawn`, replace "`mailbox` is an address to receive on, or `#false` for a new non-durable mailbox" with "`mailbox` is an address to receive on, which the new process shares with any other process receiving on it (section 10.2), or `#false` for a new non-durable mailbox". In `process::unpark`, add: "`data` is not used up: each call makes a new process continuing from the same point, receiving on the same address." Add after the table:

> The processes that receive on a mailbox are its **receivers**: those spawned or unparked onto its address that are neither `parked` nor `ended`.

**Section 10.2, Mailboxes.** Add after the table:

> A mailbox may have any number of receivers. Each message is taken by exactly one of them, oldest message first, and the CPI's `mailbox::take` takes from the same queue. When a message arrives, the receiver that has waited longest in `(recv)` becomes `ready`. If a receiver woken this way ends before it takes a message, the next longest waiting is woken in its place, so a message never waits while a receiver is blocked in `(recv)` on its mailbox.
>
> A non-durable mailbox is **closed** once it has had a receiver and has none left: sends to it go to the dead-letter queue, and messages already in it stay there. A parked receiver does not count, so an actor that will be parked and sent messages needs a durable mailbox. A durable mailbox is never closed. A new receiver (by `process::spawn` or `process::unpark`) reopens a closed non-durable mailbox.
>
> Messages from one sender are taken in the order they were sent. With several receivers, they may be *handled* in any order: two messages taken by two receivers finish in whatever order the scheduler runs them.

Replace the send row's "If `addr` is a non-durable mailbox whose process has ended" with "If `addr` is a closed mailbox".

**Example.** A pool of pre-warmed workers for one endpoint. The worker's warm-up state lives in its continuation, not in loop arguments, which is why it is parked and not checkpointed:

```lisp
(defun endpoint-code ()
    (role
        (require actor::recv actor::send load-routes handle request-reply-to)
        (defun worker ()
            (let routes (load-routes))              ; the expensive warm-up
            (serve routes))
        (defun serve (routes)
            (let req (actor::recv))
            (actor::send (request-reply-to req) (handle routes req))
            (serve routes))))

; Warm one worker on the endpoint's durable queue and park it: the template.
(defun warm-template (env queue)
    (let pid (process::spawn (environment::lookup env 'worker) () env '(actor) queue))
    (process::run pid warm-quota)                   ; stops at (blocked recv)
    (process::park pid))

; Scaling up is one more receiver on the same queue, already warm.
(defun scale-up (template env)
    (process::unpark template env))
```

Scaling down parks an idle worker, which is `(blocked recv)` by definition. Scaling to zero parks them all: the durable queue keeps the requests, and the CPI unparks the template again when `mailbox::size` is non-zero.

Rationale:

- **The mailbox is the dispatcher.** In Erlang every process has its own mailbox, so a worker pool (poolboy, for example) is a library with a dispatching process and an extra hop per request. Here the shared mailbox does the dispatching, and the CPI's scaling policy reads the backlog directly.
- **Multi-shot unpark makes templates.** Parked state is a value, and values are not used up. Warming a worker once and unparking it many times is the pre-warmed pool; `examples/life/17-amb.slight` already uses the same property for a different purpose.
- **Durability means something.** Under option B a durable mailbox is exactly what lets an actor be offline, which is its purpose in DESIGN-001 section 6, and the spec's existing reading of a parked PID as ended stays true.
- **Deterministic wake-ups.** DESIGN-001 section 12 makes the scheduler a deterministic state machine. "Longest waiting" keeps it one, where "unspecified" would make the choice of receiver a new source of nondeterminism that a recording would have to log.

Implementation (ts-cpi):

- A mailbox keeps its `receivers` (a set kept by `setStatus`: added by spawn and unpark, removed on park and end) and `hadReceiver`, in place of `ownerPid`. `isClosed` replaces the three owner-ended checks in `src/runtime.ts`.
- `wakeRecv` wakes the first process in `recvWaiters` (a `Set`, so iteration order is wait order), once per message delivered, and only while the mailbox holds a message. The woken process is marked `wokenForMessage`; the mark clears when its next batch starts, because that batch's first step retries the `recv`. If it ends while still marked, `endProcess` wakes the next waiter.
- A woken receiver can still lose its message to another receiver that is already running; it retries `recv` and blocks again, costing a turn but no ticks. The spec's guarantee is only that a message never waits while a receiver sleeps.
- Tests: the longest waiter wakes, not the first spawned; a killed woken receiver passes its wake-up on; one parked value unparked three times gives three receivers; a non-durable mailbox stays open while any receiver lives; all-parked closes it, unpark reopens it; a process's send to a closed mailbox is a dead letter; a durable mailbox keeps a message for a parked receiver; a mailbox with no receiver yet keeps its messages. No existing test or example changed: every one that sends to a parked actor already used a durable mailbox, and none relied on every waiter waking.

Open questions:

1. Should the CPI be able to count a mailbox's receivers, or its waiting receivers (`mailbox::receivers`)? A scaling policy can track its own pool with `process::state`, so this is left out until an example needs it.
2. Receivers in other images. Once workers move to other images, a mailbox shared across images is a distributed queue, with different ordering and failure guarantees. For now, every receiver of a mailbox is in the mailbox's image.
3. Waking a parked receiver when its mailbox gets a message (DESIGN-001 section 6's "mailbox watcher") is not part of this. The CPI polls `mailbox::size` for now.

### `process::ticks` (2026-09-28)

*Status.* Agreed and implemented 2026-09-28. Tests in `tests/runtime.test.ts` ("process::ticks").

*Motivation.* `process::run` reports why a batch stopped but not how many ticks it used, so a scheduler can meter only in whole quotas: the runner's calibration takes hundreds of one-tick runs (`examples/runner/README.md`), and the Life notes list "metering is invisible" (`examples/life/README.md`). The gateway's monitor needs each endpoint's share of the work.

*Options.* A builtin that reads a running total (recommended, and chosen), or the batch's ticks added to every stop reason: `(quota 200)`, `(blocked recv 37)`, `(exited v 12)`. The second saves a call per turn, but changes the shape of every stop reason, which examples, reference outputs and the tutorial print whole.

**Section 10.1, Processes.** Add a row:

| Signature | Result | Errors |
| --- | --- | --- |
| `(process::ticks pid)` | The number of ticks the process has used, over every batch it has run. `0` for a new process, including one made by `process::unpark`. It remains readable after the process ends or is parked. | `type-error`. |

The ticks one batch used are the difference around it:

```lisp
(let before (process::ticks pid))
(let stop (process::run pid 200))
(let used (- (process::ticks pid) before))
```

Rationale: a total, not a per-batch figure, so reading it never loses anything: a CPI that skips a reading still gets the right sum later, and a process that has ended still reports what it cost.

### `process::run-ready` (2026-09-28)

*Status.* Agreed and implemented 2026-09-28: the round is specified as the loop the CPI could write, and runs every ready process (no groups yet). Tests in `tests/runtime.test.ts` ("process::run-ready"); the gateway's supervisor loop uses it. Measurements in `PERFORMANCE.md`.

*Motivation.* The performance baseline (`PERFORMANCE.md`, Sep 28, 2026) found the gateway's CPI spending 9,400 ticks of its own per hello request, against 430 in the processes. A quarter of that was the scheduling loop: `process::state` on every process every round, per-turn tick charging, idle checks, and the process list rebuilt with `append`. The CPI is interpreted, 100 to 2,000 times slower than host code, so a loop over turns belongs in the host, and the CPI should act only on the events it must decide on.

*Options.*

- **A. Readiness only**: a `process::ready` that returns the ready PIDs, or `host::wait` reporting every wake. The CPI still makes one host request per turn.
- **B. A round in the host, defined as a CPI loop** (recommended, and chosen). One request runs a batch for every ready process and returns only the stop reasons the CPI must act on. The policy (the quota, the idle threshold, what to do with each event) stays in the CPI, and `process::run` remains for a scheduler that wants every turn.
- **C. A round over a group** of processes. Better for per-group quotas, and for schedulers on several threads later, but it needs a way to name groups. Left until `parallel::`.

**Section 10.1, Processes.** Add a row after `process::run`:

| Signature | Result | Errors |
| --- | --- | --- |
| `(process::run-ready n idle)` | Runs one round (section 11) and returns `(events ready)`: the events the CPI must act on, in the order they happened, and how many processes are `ready` after the round. `idle` is a number of milliseconds, or `#false`. | `type-error` unless `n ≥ 1` is an integer and `idle` a non-negative integer or `#false`. |

**Section 11, Running processes.** Add after the stop-reason table:

> `(process::run-ready n idle)` runs one **round**. It is the same as the CPI calling `(process::run pid n)` on each process that is `ready` when its turn comes, in increasing PID order, each at most once, and keeping the results it must act on. A process woken during the round by a message sent in it therefore runs in the same round if its PID is higher than the sender's, and in the next round otherwise. Each event is `(pid what)`, where `what` is:
>
> - a stop reason that ends or stops the process: `(exited v)`, `(failed e)` or `(trap <effect> <args>)`;
> - `(idle)`: the process has been blocked in `(recv)` for at least `idle` milliseconds since it last blocked there. Each blocking is reported at most once, so a process reported idle is reported again only after it has run. With `idle` `#false`, no process is reported idle.
>
> `(quota)` and `(blocked …)` are not reported: the process is still `ready`, or will become `ready` when what it waits for arrives.

Replace the rationale with:

> **Rationale.** Returning a stop reason, as an exokernel returns a trap, keeps scheduling in control plane code: round robin, refill quotas, hierarchical quotas and deadlock detection are all loops over these results. The CPI waits while the host runs a batch, so there is one thread of control and scheduling is deterministic. `process::run-ready` is one such loop run by the host, because a loop over turns in interpreted code costs more than the turns: the policy stays in the CPI, as the quota, the idle threshold and what it does with each event, and a CPI that needs a different loop writes it with `process::run`.

**Example.** A supervisor that parks processes idle for two seconds:

```lisp
(defun supervise (procs)
    (let round (process::run-ready 200 2000))
    (let procs2 (fold handle-event procs (car round)))
    (host::wait (if (> (car (cdr round)) 0) 0 500))
    (supervise procs2))

(defun handle-event (procs event)
    (let what (car (cdr event)))
    (cond
        ((eq? (car what) :idle) (park-one procs (car event)))
        ((eq? (car what) :failed) (restart procs (car event)))
        (#true (forget procs (car event)))))
```

Rationale:

- **The same as a loop the CPI could write.** Nothing a CPI could observe with `process::run` changes: the order, the quotas, the stop reasons and the message timing are those of the loop. Scheduling stays deterministic, and a recording of a round is a recording of the loop.
- **Events, not turns.** The CPI sees a process only when it must decide about it: when it ends, traps or goes idle. With the gateway's metrics stubbed, this took the CPI from 1,700 ticks per request to about 200.
- **Idle in the host.** The host knows when a process last blocked; the CPI only knew when it last ran a turn, and had to ask `process::state` about each process every round to find the idle ones.

Implementation (ts-cpi):

- `Runtime.processRunReady` walks `live`, which holds processes in the order they were made (PID order); a round makes none, and a process that ends during it is skipped. Each ready process gets `runBatch`, as `process::run` does. *Changed Sep 29, 2026:* the round no longer walks `live`, but takes the same turns in the same order (the hibernate node's "Found while building", item 2).
- `setStatus` records `recvSince` and clears `idleReported` whenever a process blocks in `recv`, so the idle check is one comparison per blocked process per round.
- The gateway: its CPI work comes before the round, so a process it wakes or adds runs in the same loop and the round's `ready` count is still right when it waits. The round cannot count the CPI's own inbox, which processes send to during the round, so the loop also waits 0 ms while the inbox has mail: without that, `/system` requests and new counters waited up to half a second. Ticks are charged to endpoints once a second and when a process is parked or ends, instead of every turn.
- Tests: one batch per ready process, only exits, failures and traps reported, with the count of ready processes; PID order, and a process woken during the round runs in it only if it comes later; a trap waits for `process::resume`; idle reported once, then again only after running, and never with `#false`; argument errors. `tests/gateway.test.ts` gains two loops (the CPI's inbox handled one loop later), and its ticks per endpoint are unchanged.

Open questions:

1. **Sleeping actors are still polled.** The gateway checks `mailbox::size` for every parked counter every loop, and with 200 asleep this halves hello throughput again (`PERFORMANCE.md`). The round could report "a message arrived for a parked receiver" as an event, which is DECISIONS' earlier open question on a mailbox watcher (DESIGN-001 section 6).
2. **The CPI's own mailboxes** are not processes, so the round cannot report mail for them. A CPI that handles requests itself checks its inbox after the round.
3. **Groups and quotas per group**, for `parallel::`.

### `plan::run` (2026-09-28)

*Status.* Agreed and implemented 2026-09-28: whole plans passed on every call (option A), node shapes `(round n idle)` and `(inbox addr …)`, the event `(addr (mail))`, host nodes only, and equivalence checked by an exact trace. Design: `DESIGN-PLAN.md`. Tests in `tests/runtime.test.ts` ("plan::run") and `tests/gateway.test.ts` (the gateway under the reference program). Measurements in `PERFORMANCE.md`.

*Motivation.* The first step of `DESIGN-PLAN.md`: the host runs the plan, and the CPI reacts. After `process::run-ready` the CPI still went round its loop once per round, to call `host::wait` and read its mailboxes. One blocking request that runs rounds and waits until the CPI is needed makes the CPI's loop event-driven.

*Options for passing the plan.* **A. The whole plan on every call** (chosen): each call carries the current desk, an edit takes effect at the next call, and a recording shows the plan at every step. The host reads the plan again only when it is a different value from the last call's. **B. `plan::set`, then `plan::run`**: edits as separate events, but the plan in force is hidden state.

**Section 10, Builtins.** Add a namespace:

> ### 10.6 Plans: `plan::`
>
> A **plan** is a list of nodes, each a list starting with its kind. The host runs it (`DESIGN-PLAN.md`); the CPI builds it, and handles the events it returns.
>
> | Node | Meaning |
> | --- | --- |
> | `(round n idle)` | Rounds of `process::run-ready` with quota `n` and idle threshold `idle` (milliseconds, or `#false`). At most one. Without it, the plan runs no process. |
> | `(inbox addr …)` | Mailboxes whose mail wakes the CPI: its own, and any it watches. |
>
> | Signature | Result | Errors |
> | --- | --- | --- |
> | `(plan::run plan timeout)` | Runs `plan` until the CPI is needed, and returns the events: the round's `(pid what)` events, or `(addr (mail))` for each inbox with mail, or `()` when `timeout` milliseconds pass (`#false` for no timeout), when something arrives that wakes no process, or when nothing can happen. | `type-error` for a malformed plan or timeout. |
>
> `(plan::run plan timeout)` is the same as the following program, and an implementation must be indistinguishable from it: the same processes run in the same order, the same messages are delivered at the same times, and it returns the same events at the same times.

The reference program is `tests/programs/plan-run-reference.slight`: `(plan-run-reference plan timeout)`. Its loop, for the spec text:

```lisp
(defun pr-loop (round inboxes deadline)
    (let r (if round (process::run-ready (car round) (car (cdr round))) (list () 0)))
    (cond
        ((not (nil? (car r))) (car r))
        ((pr-any-mail? inboxes) (pr-mail inboxes))
        ((and deadline (>= (host::now) deadline)) ())
        ((> (car (cdr r)) 0)
            (host::wait 0)
            (pr-loop round inboxes deadline))
        (#true
            (let limit (pr-limit (if round (car (cdr round)) #false) deadline))
            (let before (host::now))
            (let woken (host::wait limit))
            (if (or (not (nil? woken)) (pr-any-mail? inboxes) (and limit (>= (- (host::now) before) limit)))
                (pr-loop round inboxes deadline)
                ()))))
```

`pr-limit` is the smaller of the round's idle threshold and the time to the deadline, or `#false` if there is neither: a wait is capped at the idle threshold so an idle process is reported at most that late.

**Section 10.3, System.** Replace "`host::wait` is the one host request that suspends the image. The CPI calls it when no process is `ready`." with "`host::wait` and `plan::run` are the host requests that suspend the image. A CPI without a plan calls `host::wait` when no process is `ready`."

**Example.** The gateway's supervisor loop (`examples/gateway/gateway.slight`):

```lisp
(defun gateway (w st ui events)
    (if (st-running? st)
        (do
            (let st1 (scale-hello w (read-served-log w (handle-inbox w (handle-events w st events)))))
            (let stepped ((car ui) (cdr ui) w st1 (host::now)))
            (let next (plan::run (st-plan (second stepped)) (third stepped)))
            (gateway w (second stepped) (cons (car ui) (car stepped)) next))
        st))
```

Its plan is `((round 200 2000) (inbox <inbox> <served log> <keys> <counter asleep> …))`. A counter's mailbox is in the inbox while the counter sleeps, so the first request for it wakes the CPI, which unparks that counter: no sleeping counter is polled.

Rationale:

- **Defined by a program the CPI could run.** As for `process::run-ready`: the policy stays in the language, and a recording of the program is a recording of the request.
- **Mail as the CPI's wake-up.** The CPI's own mailboxes are not processes, so no round can report them. An inbox node names them, and any other mailbox the CPI wants to know about.
- **Returning `()` when something arrives that wakes nobody.** The CPI may need to look, and a CPI that asked to wait forever when nothing can happen gets control back instead of hanging.

Implementation (ts-cpi):

- `Runtime.planRun` is the reference loop in TypeScript, built on the same `runRound` as `process::run-ready` and on `hostWait`, so the served log, reply expiry and input are handled exactly as in `host::wait`. The last plan value and what was read from it are kept; a call with the same value skips reading it.
- The headless HTTP backend records when each response was written (`at`, on `host::now`), so an exact trace includes timing. The runtime hands it the clock (`HttpBackend.setClock`, test backends only).
- The gateway keeps its plan in its state and builds it again only when a counter falls asleep or wakes. Its CPI work comes before `plan::run`, so everything it starts runs in the next call. Scaling the hello pool now happens once per wake, not once per round: in the test's burst, two workers where there were three.
- Tests: the round's events, across quotas; mail after the round's own events; the timeout; a sleeper woken inside the request; idle; no round; nothing can happen; malformed plans and timeouts. `tests/gateway.test.ts` runs a scenario under the builtin and under the reference program and requires identical output, responses with their times, and dead letters. Of four mutations of the reference program, two changed the gateway's trace and were caught (a 1 ms wait while processes are ready; half the quota); the other two (mail before the round's events; never returning early) do not change what this gateway does, and the unit tests cover them.

Found while building:

1. **The early return does not cover mail for a parked receiver.** A request for a sleeping counter reaches its mailbox from the counters process inside a round, not as an external event, so no wait ends early for it. Before counters' mailboxes were put in the inbox, such a request waited for the next timeout: 400 ms in the test scenario.
2. **Whole plans cost the size of the plan on every edit, in interpreted code.** With 500 counters asleep, each counter falling asleep rebuilds a 600-address inbox list in the CPI, and the host reads it again. Sleeping counters are voices, not the desk's setup: they belong in a watcher node's own state (`DESIGN-PLAN.md`, step 2), not in the plan.

### The hibernate node (2026-09-28)

*Status.* Agreed and implemented 2026-09-28. The host unparks, as DESIGN-001's mailbox watcher does ("the mailbox watcher resumes the actor, and the resume policy picks an environment"). A node that keeps state between calls has as its reference the CPI code it replaces, not a drop-in function (option B). Tests in `tests/runtime.test.ts` ("hibernate") and `tests/gateway.test.ts` ("hibernate: the gateway runs exactly as it does …").

*Motivation.* Step 2 of `DESIGN-PLAN.md`. After `plan::run`, the gateway put a sleeping counter's mailbox in the plan's inbox, so every counter falling asleep or waking rebuilt the plan in interpreted code, and the CPI did the parking and unparking itself.

*How a stateful node is checked.* `run-ready` and `plan::run` are stateless between calls, so their references are drop-in functions. A hibernate node remembers its sleepers, and CPI code can remember nothing between calls except what it passes along. The options were a reference that threads its state (`(ref plan timeout state)` returning `(events state)`), which makes the program calling it carry the state, or **the CPI code the node replaces** (chosen): the test runs the example both ways and compares the exact trace.

**Section 10.6, Plans.** Add a node:

> | `(hibernate env idle)` | A process running with env ref `env`, receiving on a durable mailbox, that has waited in `(recv)` for `idle` milliseconds is parked at the end of the round, if it is still waiting then, and kept by the node: `(pid (hibernated addr))`. The first message to `addr` unparks it with `env`, as a new process, reported as `(new-pid (resumed addr))` with the inbox's mail. One node per env ref. The round never reports a member idle. |

and to the reference behaviour: "A wait inside `plan::run` is capped at the smallest idle threshold in the plan."

The reference is `tests/programs/gateway-hibernate-reference.slight`: the gateway's `gateway-plan`, `on-mail` and `sleep-idle` as they were before the node, parking a counter reported `(idle)` and unparking it on mail in the inbox.

Rationale:

- **Voices in the node, not the plan.** The plan names the members by their env ref, so it does not change as counters sleep and wake, and the CPI builds nothing per counter.
- **The host resumes.** A sleeping actor is woken by the message that needs it, with no trip through the CPI; the CPI hears of it as an event, to keep its books.
- **Durable mailboxes only.** A parked receiver does not keep a non-durable mailbox open (section 10.2), so parking one would lose its messages; such a process is left to the round.
- **Parking at the end of the round.** A message sent later in the round may wake a member reported idle at its turn; parking then would fail. The gateway's CPI code had the same race (`process::park` on a woken process throws `bad-state`), fixed by checking that the process still waits.

Implementation (ts-cpi):

- `runRound` collects members idle long enough and parks those still in `recv` after the round; the parked data, env ref and address are kept in `hibernated`, in the order they were parked. A message queued for a hibernated address (in `deliverNow` or `flushOutbox`) marks it; `plan::run` unparks marked ones in parked order where it reports inbox mail.
- The gateway: counters asleep are `(name address)`; `handle-event` keeps its books on `hibernated` and `resumed`; `gateway-plan`, `on-mail` and `sleep-idle` are what the reference replaces.
- `settle` (inside every wait) found the receivers a delivery woke by checking every process waiting in `recv`; it now records them as deliveries wake them. It cost 10% of the CPU with 150 counters awake.
- Tests: park and resume, with the continuation intact (the checkpoint shows the count went on); non-members reported idle by the round; a member woken later in the round not parked; malformed nodes. The exact-trace test catches parking at twice the idle time and resuming after a wait instead of at once.

Found while building:

1. **The CPI's lists are now the cost of each event.** Each hibernate event walks the process list twice (`find-proc`, `remove-proc`) and appends to the list of sleepers: about 25,000 ticks with 700 counters. Per event, not per round, but it grows with the processes. A new counter costs 5.6 ms with one client (0.6 ms for an existing one), and the counters endpoint's own `find-child` is linear too. This is the prompt's question about data structures in CPI code.
2. **Every round walks every live process** to find the ready ones and check idle times, in the host: cheap per process, but it grows with blocked processes, as `settle` did. *Resolved Sep 29, 2026:* a round starts from the processes that are ready and the waits in `recv` long enough for the shortest threshold in use (the round's idle, a pool's or a hibernate node's), sorted by PID, and a process woken during the round joins it if the round has not reached its PID. `setStatus` keeps the ready processes in an array in which each knows its place, and, from the first round with a threshold, the waits in the order they began; a wait already reported idle stays indexed only on a durable mailbox, where a later hibernate node can still park it. The turns, events and results are the old walk's, and the tests pin them down, three new ones among them that pass on the old walk too. On the ring benchmark's VM, a ring with PIDs falling round 100,000 processes took 115 s under `process::run-ready` and now takes about 1.8 s (`PERFORMANCE.md`, "A round visits only what can act").

### The monitor node (2026-09-28)

*Status.* Agreed and implemented 2026-09-28, as part 3a of `DESIGN-PLAN.md` step 3: aggregation in the host, the view still built by the CPI from a summary each second; part 3b (the view as a template the node draws) is next. A faux actor is checked against a real actor given the same messages (option A), not by a whole-gateway trace. Tests in `tests/monitor.test.ts`; `tests/gateway.test.ts` updated.

*Motivation.* After step 2, metrics were about 70% of the gateway's CPU: every served request was aggregated in interpreted CPI code, and the served log woke the CPI in every wait.

*How a faux actor is checked.* The old CPI metrics sampled queues whenever the CPI woke, and the node samples every round and no longer wakes the CPI for metrics at all, so no reference could reproduce the old timing. The options were **A. a real actor running the same aggregation, sent the same messages, with identical summaries required** (chosen), and B. a whole-gateway trace against a second gateway loop built on `process::run-ready` only for the test. A checks the node where it can be observed: its messages in, its summaries out.

**Section 10.6, Plans.** Add a node:

> | `(monitor self to (rows name …) (routes name …) (bins ms …) (history n) (ticks (row env …) …) (queues (row addr) …))` | A **faux actor**: the host takes every message sent to `self` as it is delivered (nothing queues there while the node is in the plan), and counts. Its messages are `(served …)` (a served-log entry, SPEC-HTTP section 6), `(sample (row n) …)`, `(ticks row n)` and `(second s)`; the host also sends it, itself, a sample of the named queues after every round, the ticks each row's processes used (found by their env refs) and each new second of `host::now`. It sends `to` a summary when installed and at each new second: `(metrics second status endpoints)`. One node per `self`. |

and to the reference behaviour: "A wait inside `plan::run` is also capped at the next second, while the plan has a monitor node."

The meaning of every number in a summary is written down, as a program, in `tests/programs/monitor-reference.slight`: it is the gateway's former metrics code as an actor. In short: a request counts in the row its first path segment names if that is one of `routes`, else in `"other"`, and always in `"total"`; each row keeps request counts, wait, work and total-time histograms with bounds `bins`, and ticks, for the current second, a summary of each of the last `history` seconds (requests, p50 and p95 bins of wait and work, p95 of total, ticks), and running min, max, sum and count of wait, work, queue length per sample and requests per second.

Rationale:

- **Per-request work in the host.** The CPI now sees one summary a second, whatever the load.
- **An actor from the outside.** Anything can send it messages, the served log goes to its address like any subscriber's, and a real actor is its reference. Facts the CPI knows (the hello pool's size, events) will reach it the same way in part 3b.
- **Ticks by environment.** Each kind of process in the gateway runs in its own environment, so the host can charge a batch's ticks to a row with no CPI bookkeeping. The counters endpoint and the counters share the `counter` row.

Implementation (ts-cpi):

- `src/monitor.ts` holds the aggregate and makes summaries; `Runtime` installs a node when a plan names it (sending the first summary and handling any messages already in the mailbox), gives the mailbox a `faux` handler that `deliverNow` and `flushOutbox` call instead of queueing, counts ticks by env ref in `runRound`, samples the queues after each round, and sends `(second s)` at the top of each `plan::run` loop once `host::now` reaches a new second.
- The gateway: the plan has a monitor node; the served log goes to its address; the CPI keeps the last summary (`take-summary`) for `/system/metrics` and the monitor's view; the metrics code, the served-log reading and the per-process tick charging are gone, and so are the loop-phase metrics. The monitor draws when there is a new summary or event, with no frame rate or `f` key.
- Tests: the node and the reference actor, given requests on every route, refusals, a client that went away, 503, 504, 500 and 404, samples, ticks, a repeated second, a gap longer than the history and an unknown message, send the same five summaries (four mutations of the node were each caught); in a plan, the host feeds ticks by env ref, samples queues each round, rolls seconds on the clock, and hands the node messages that arrived before it was installed.

Found while building:

1. **The hello pool rarely scales now.** The CPI adds a worker only when it is woken while requests wait, and nothing wakes it during a burst: in the test's burst one worker drained six requests. On one thread more workers add no throughput, so it matters for the pool node (step 4) and for parallel schedulers.
2. **The `plan::run` trace test runs without the monitor node,** which its reference program does not know; the node is checked against its own reference instead.

### The pool node (2026-09-28)

*Status.* Implemented 2026-09-28 as step 4 of `DESIGN-PLAN.md`, taken before step 3b because after 3a the CPI, woken about once a second, barely scaled the hello pool. Checked as the hibernate node was: against the CPI code it replaces, here a whole supervisor loop run on a small scenario. Tests in `tests/pool.test.ts`; `tests/gateway.test.ts` updated.

**Section 10.6, Plans.** Add a node:

> | `(pool name template env min max idle)` | Workers unparked from the parked data `template` with env ref `env`, receiving on the template's address. When the node is installed, workers are added from the template until there are `min`; `plan::run` returns their events before running anything. After each round: a member that has waited in `(recv)` for `idle` milliseconds, considered once per wait and still waiting, is parked into the pool's cold storage while there are more than `min`, reported as `(pid (left name))`; then, if the template's mailbox holds a message and there are fewer than `max`, one worker is added, from cold storage (the most recently parked first) or else from the template, reported as `(pid (joined name from))` where `from` is `cold` or `template`. A member that ends leaves the pool. The round never reports a member idle. One node per name; its members and cold storage outlive plan edits, so `max` can be changed by giving a new plan. |

and to the reference behaviour: waits inside `plan::run` are also capped at each pool's idle threshold.

The reference is `tests/programs/pool-reference.slight`: `(ref-run quota template env min max idle deadline)`, a CPI loop over `process::run-ready` that keeps the members and cold storage in its arguments and prints each event at the time `plan::run` would return it.

Rationale:

- **Scaling is per round again,** as it was when the CPI ran every round, without the CPI running every round: in the gateway test's burst the pool again grows to three workers, and every log line, answer and monitor row that depended on it is back to its original value.
- **The pool is the node's.** Its members and cold storage live in the host, so the plan does not change as workers come and go; the CPI keeps a count of each for its stats.
- **Considered once per wait,** like the round's own `(idle)`: with one shared queue a member left at `min` cannot be reconsidered without having run, because a backlog would wake it first, so this only makes the rule easy to state.

Implementation (ts-cpi):

- `Runtime` keeps pools by name, each with its members (a set of process entries) and cold storage (parked data, newest first), and `poolOf` from process to pool. `runRound` collects members idle long enough; `tendPools` parks them and adds a worker after the hibernate node has parked its members; `setStatus` drops a member that ends or is parked by anyone. Installing a plan fills pools to their minimum and returns those events first.
- The gateway: its hello pool is `(pool "hello" template hello-env hello-min hello-max idle-ms)`; the monitor's `+` and `-` keys change `hello-max` and build the plan again; `scale-hello`, `add-hello` and `sleep-hello` are gone; `cold` is a count kept from `joined` and `left`.
- Tests: the node and the reference loop run a scenario (the pool filled, grown under a burst, parked when idle, taken back from cold storage twice, workers counting their work so a worker back from cold storage shows which one it was) and must print the same events at the same times and do the same work in the same order; malformed pool nodes. Of four mutations, growing by two a round, parking below `min` and taking cold storage oldest first were caught; considering idle members every round cannot be observed, for the reason above.

Found while building:

1. **Within a round, hibernate members are parked before pools are tended,** so in the gateway test "counter ada asleep" now comes before "hello -1": both happen at 2150 ms.
2. **An expired reply is answered at the host's next wait,** not at its deadline, on the virtual clock: with no hello pool, the `plan::run` trace test's first hello request times out at 2100 ms and is answered 504 at 2150 ms, when the wait capped by the idle threshold ends.

### View templates: the monitor node draws (2026-09-28)

*Status.* Agreed and implemented 2026-09-28, as part 3b of `DESIGN-PLAN.md` step 3, with the smaller of the vocabularies proposed (option B): placeholders give raw values, and formatting is what components already do. Tests in `tests/monitor.test.ts` ("with a view"); `tests/gateway.test.ts` updated.

*Motivation.* After step 3a the CPI still built the whole monitor view in interpreted code once a second. The measured cost was small (the gateway ran at 18,000 requests a second under the live monitor); the reason is the design: the display belongs to the host, and the CPI should only state what it knows.

*Options for the vocabulary.* A. Placeholders that format everything the old view did (colour thresholds for percentile labels, one mark per worker, tenths, offsets): the screen unchanged, but much of one monitor's taste moved into the host. **B. Raw values, formatted by what components already do** (chosen): a small, reusable vocabulary and a plainer screen (counts instead of marks, percentile labels uncoloured). C. Leave the view in the CPI.

**SPEC-TUI, a new section: view templates.** To fold in beside section 3:

> A **view template** is a view (section 3.1) that may contain placeholder elements, which a host node fills in before rendering. The plan's monitor node (SPEC-CPI section 10.6) takes one in a `(view template)` section. Each placeholder is replaced by a value:
>
> | Placeholder | Value |
> | --- | --- |
> | `(Metric row field)` | A number or text for `row` (one of the node's rows, or `"total"`). Fields: `requests` and `ticks` in the last full second; `wait-p50`, `wait-p95`, `work-p50`, `work-p95` and `total-p95`, the bin label of that percentile in the last full second (`"<1ms"` … `"<1s"`, `">=1s"`, or `"-"` with no requests); `total`, requests since the start; `queue`, the row's queue length now; `ready`, `waiting` and `parked`, how many of the row's processes (those running in the row's environments) are ready, not ready, or parked by the plan's pools and hibernate nodes; and `queue-`, `rate-`, `wait-` and `work-` with `min`, `avg` or `max`, the running summaries since the start, `avg` to one decimal place as text, `"-"` when there is nothing yet. |
> | `(Series row field)` | A list of numbers, one per second of history, oldest first: `requests` or `ticks`, or a percentile (`wait-p95`, `work-p95`, `total-p95`) as its bin counted from 1, 0 for a second without requests. For a chart's `data` prop. |
> | `(Status name)` | The count of requests by status: `"requests"`, `"2xx"` (all below 400), `"4xx"`, `"503"`, `"504"`, `"5xx"` (other 5xx), `"gone"`. |
> | `(Fact name)` | The value last sent to the node as `(set name value)`, or `"-"`. |
> | `(Uptime)` | How long the image has run, as `m:ss`. |
>
> A placeholder may stand wherever its value may: a number or text wherever a `Text` child or table cell may be, a list as a chart's `data`. A template is checked when the plan is read, by filling it with zeros: a placeholder the node cannot fill, or a view that would not render, is a `type-error` from `plan::run`.
>
> The node draws when it is installed and whenever there is something new: its summary for a new second, a fact, or a worker added, parked or woken by a plan node. Drawing happens inside `plan::run`; the CPI does not draw.

Rationale:

- **The CPI states what it knows; the host draws.** The only fact in the gateway's view is the most hello workers, sent when it changes.
- **Workers counted from environments.** Each row's processes are those running in the row's environments (the node's `ticks` section), so the host counts them without the CPI's books.
- **Checked by rendering.** The node's frame must equal `tui::render` of the same template filled in by hand; the test does exactly that.

Implementation (ts-cpi):

- `Monitor.fill` replaces placeholders; the node keeps facts and a `dirty` flag, set by a summary, a fact, or `workersChanged` (a hibernate, resume, join or leave). `plan::run` draws dirty monitors at the top of each loop through the TUI backend. `readMonitor` checks the template, and now requires `bins`.
- The gateway: `monitor.slight` builds the template once and passes it through `start-gateway` to the monitor node; its UI step sends `(set "hello-max" n)` when that changes, and draws nothing. The gateway's view-only procedures are gone.

Found while building:

1. **Quitting waited for one more `plan::run`.** Since step 1, the gateway's loop handed the plan back once more after `/system/quit` before checking it should stop, so the image quit at the next event, up to a second later. The loop now checks first.
2. **A monitor without bins** drew `">=undefined"` for every percentile; bins are now required.
3. **The last frame can be stale by up to the idle threshold:** idle workers are noticed when the host next wakes, and if that is a quit, the CPI stops before the node draws again.

### Reclaiming what nothing can name (2026-09-29)

*Status.* Agreed and implemented 2026-09-29 (option B). Resolves the spec issue that nothing reclaims ended processes, for processes and mailboxes; the park table still only grows (see Rationale). Tests in `tests/reclaim.test.ts` (entries are collected once nothing names them, and kept while something does) and `tests/runtime.test.ts` (a PID watcher that has ended is still told; every PID value for a process is the one `process::spawn` returned). Measurements in `PERFORMANCE.md`.

*Motivation.* Every process and every mailbox stayed in the host's tables for the life of the image: about 1.2 KB for a ring process and its mailbox, measured with heap snapshots. The ring benchmark with a row of 100,000 × 10 in both tables made about 3 million of them and ran out of heap on a laptop (`examples/ring/README.md`, finding 7), and a CPI that runs for long, as the gateway does, making processes as clients come and go, grows without bound.

*Options.* A. Keep less for each ended process and closed mailbox: about 0.45 KB instead of 1.2, still growing. **B. Reclaim an ended or parked process, or a mailbox, once no value refers to its PID or its address** (chosen). No program can tell: only the host makes PIDs and addresses (the reader has no syntax for them, and no builtin makes one from a number or a string), and no builtin lists processes or mailboxes. C. A builtin to forget a process, `process::forget`: deterministic, but every CPI has to call it.

**Section 10.1, Processes.** Add:

> The host may reclaim a process that has ended or been parked once no value refers to its PID, and a mailbox once no value refers to its address. No program can observe it: PIDs and addresses are made only by the host, and nothing lists them. A process that is still running, trapped or waiting keeps its address, and so its mailbox, as does parked data kept for `process::unpark`.

Rationale:

- **Nothing observable changes,** so no program changes: a program can ask about a process only through its PID, and send to a mailbox only through its address. Memory follows what the program holds, as it does for its own lists.
- **The park table still only grows.** Parked data is a plain list whose key is an integer, so a CPI can write it by hand and unpark it; reachability says nothing about when that can no longer happen. That stays an open issue.

Implementation (ts-cpi):

- Each process has one PID value, made with it and kept on its entry. `values.ts` no longer interns PIDs in a global table, which kept every PID alive; `eq?` still holds, because the host hands out only that value.
- `procs` holds the processes that have neither ended nor been parked. The others are in a `WeakMap` keyed by their PID value, so an entry lives as long as its PID does.
- `mailboxes` is a `WeakMap` keyed by the address value. A process's entry holds its address and its mailbox's entry, and the park table, hibernated processes, pools, listeners, monitors and open HTTP replies hold the addresses they need.
- A watcher given as a PID is recorded by its address when `process::watch` is called, not looked up when the signal is sent. It is the same address: a process's address never changes.
- The processes waiting in `recv` on a mailbox are kept on its entry, so they go with it; they were in a map by address that kept an empty set for every mailbox ever waited on. The map of processes waiting in `join` drops a target's set when it empties.
- `live` is gone: it held what `procs` now holds.

Found while building:

1. **A first version cost 11% on the ring.** It dropped a mailbox's set of waiters when the set emptied, which meant a new set for every message. Keeping the waiters on the mailbox's entry, and each process's mailbox entry on the process, left no difference that runs could measure.
2. **The dead-letter list keeps what it records,** addresses included: it is for tests, and nothing in the language reads it, but a program that keeps sending to closed mailboxes still grows it.

### `fold` (2026-10-02)

*Status.* Agreed and implemented 2026-10-02 (option A). Tests in `tests/fold.test.ts`.

*Motivation.* A walk over a list cost whatever the program's own loop happened to cost. `fold` was defined four times (`examples/life/lib/lists.slight`, the gateway, the ring and `tests/programs/monitor-reference.slight`), and the ticks per element of the list procedures depended on how each one was written: 31 for a fold of `+`, 20 for the Life library's `length` and 31 for the gateway's, 27 for `map`, 48 for `filter`. ts-slight's evaluator has `fold/l` and `fold/r` as continuations, so a fold there costs one step per element besides the procedure's own.

*Options.*

- **A. `fold`, a left fold, as a core operation the machine handles** (recommended, and chosen), as it handles `apply`. `map`, `filter`, `length` and `reverse` stay library code, written on it.
- B. A and `fold-right`, as in ts-slight. `map` and `filter` keep order without a `reverse` (about 11 ticks per element plus `f`'s for `map`, against 16), at the cost of a second frame and a continuation as deep as the list, which is also an error trace as long as the list.
- C. No change, and one shared list library: the same cost in every program, but not a lower one.

**Section 5.5, Pairs.** Add a row:

| Signature | Result | Errors |
| --- | --- | --- |
| `(fold f acc xs)` | `acc` if `xs` is `()`. Otherwise `f` applied to `acc` and the first element, then to that result and the second, and so on, left to right: `(fold f a '(x y))` is `(f (f a x) y)`. | `type-error` unless `f` is a procedure and `xs` a proper list. An improper tail is found when the fold reaches it, after `f` has been applied to the elements before it. |

**Section 7.1, Frames.** Add `FoldK(f, xs, L)`: a fold waiting for `f` to return. `xs` holds the elements not yet folded; `L` is the local scope of the `fold` application, for trace entries and pads like any other frame.

**Section 7.3, Applying.** Add:

| State | Top of K | Next |
| --- | --- | --- |
| Applying `fold` to `f`, `acc`, `()` | | `Ret(acc)` |
| Applying `fold` to `f`, `acc`, `(x . xs)` | | Apply `f` to `(acc x)`, with `FoldK(f, xs, L)` pushed |
| `Ret(v)` | `FoldK(f, (), L)` | `Ret(v)`, the frame popped |
| `Ret(v)` | `FoldK(f, (x . xs), L)` | Apply `f` to `(v x)`, with `FoldK(f, xs, L)` in place of the frame |

**Section 11.** Add: "A `fold` over n elements takes one step for its application, like any core operation, and n more besides the steps of `f`."

Rationale:

- **A cost the spec states.** One tick per element plus `f`'s, in any implementation. It holds however literally the rest of section 7.3 is counted (see the spec issue on canonical step counts), since it counts only the frame's own steps.
- **Each step is still bounded.** `append` and `list` do linear work in one tick; `fold` is charged per element, so a quota still bounds the work between two steps.
- **A frame, not a loop in the host.** `f` is CPI code: it may make host requests, be trapped, throw or be parked in the middle of a fold, and a frame on `K` handles all of these as any continuation does. An error in `f` has a trace entry at the `fold`.
- **Built anew for each element.** ts-slight updates its fold frame in place. Here a parked continuation may be unparked more than once, so the frame is never updated.
- **Left only.** Every walk over a whole list in the examples is a left fold or a `map` or `filter`, which are a left fold and a `reverse`. Walks that stop early (`any?`, `all?`, `member?`, `list-ref`) stay recursion.
- **`(f acc xs)`,** the order every example already used, so no call changed. ts-slight has `(fold/l acc f xs)`.

Implementation (ts-cpi):

- `fold` is in `CORE_ARITY` with arity 3, and in `CORE` as a placeholder, like `apply`. `applyHead` hands it to `foldNext`, which `stepRet` also calls for a `fold` frame. The frame holds `f`, the rest of the list, and the scope and site of the application.
- `fold` is now reserved, so the four definitions are gone, and `17-amb` and `19-tick-economy` no longer `require` it. `examples/life/lib/lists.slight` writes `length`, `reverse-onto`, `map`, `for-each` and `filter` on it. The gateway's and the ring's `length` and `reverse` already were; their `map` and `for-each` are unchanged.
- No reference output changed, and the gateway test's ticks per endpoint are the same.

Measured (ticks per element by counting steps; wall time for a list of 1,000, before and after):

| Procedure | Ticks per element | Wall time |
| --- | --- | --- |
| `(fold + 0 xs)` | 31 → 6 | |
| `length` | 20 → 6 | |
| `reverse` | 22 → 6 | 2.9 → 0.9 ms |
| `for-each` | 26 → 7 (identity `f`) | |
| `map` | 27 → 17 (identity `f`) | 4.0 → 3.0 ms (`(+ x 1)`) |
| `filter` | 48 → 24 | 5.5 → 3.0 ms |

`map` now makes two folds and a call to `reverse`, so its fixed cost rose from about 12 ticks to 31: it costs more for a list of one element and less from two on. `filter` already reversed, and costs less for any list.

## Spec issues

- A library that the CPI and its processes both use cannot be a role, because the CPI's environment comes from its files and a role's procedures resolve their globals through the environment of whoever runs them. Processes that need such a library get a role composed onto `environment::self`: they can see every CPI definition, and the host actions the library uses are neither declared nor checked by `environment::resolve`. Two ways to close it, both spec changes: read each loaded file as a role (open question 5 above), so the CPI's environment is a composition of library roles it can also give to processes; or add a projection, `(environment::select e names)`, so a process takes exactly the names its role requires. Found by migrating the examples (the CPI-Roles field notes). A plain projection was tried on Sep 27, 2026 and reverted (commit `d9d1cbf` and its revert): because library procedures call each other by name, every role had to list what its library calls reach in turn (18 names for version 08's universe), and a forgotten one surfaced only at run time, once as a supervisor restarting a failing worker forever.
- A library that is a role declares its host actions, and they carry through composition: `examples/actors/actors.slight`'s `actor-library` requires `actor::send`, `actor::self` and `actor::recv`, so resolving an actor's environment checks the `actor` grant. The CPI still cannot call the library's procedures; version 02 reads a report's body itself.

- SPEC-CPI section 1 says the CPI "is granted the privileged namespaces in section 8"; they are listed in section 10. Editorial.
- SPEC-CPI section 2.3 calls tag, message, payload and cause "three visible fields". There are four. Editorial.
- SPEC-CPI section 10.1 says `process::park` returns "plain data: its continuation…", but no value type in section 2.1 can hold a continuation or frame. The prototype keeps the continuation in a runtime table and returns a key (see Prototype decisions). DESIGN-001 section 6 (frames are plain, content-addressed data) suggests frames should become values, or be stored in the store and referenced by hash.
- SPEC-CPI section 8 says each namespace declares actions "and their arities", and a mismatched count is an `arity-error`. `IO::print` is used with any number of arguments (prototype choices), so the prototype allows a variadic arity for it alone.
- SPEC-CPI section 10.1 describes `process::state` as "the state as a symbol, plus detail" without fixing the shape of states that have no detail. The prototype always returns a list.
- SPEC-CPI section 7.5 records one trace entry per frame in `K`. Two frames can wait on the same expression, for example `(let r (catch …))`, where the `let` frame and the `catch` frame both sit at the `catch`. The trace then shows the same entry twice. This follows the spec literally; the spec may want entries collapsed, or per-procedure entries only.
- An ordinary process cannot read the time: `host::now` is in the privileged `host::` namespace, and `timer::` has only `sleep` in the prototype. SPEC-CPI section 10.5 leaves other namespaces to their subsystems, so this is a gap rather than a contradiction.
- SPEC-CPI section 11 counts every `step` as a tick, and section 7.3's `Eval((do rest …))` transitions make tick counts depend on how literally the table is read. Quotas are therefore implementation-defined until the spec fixes a canonical step count per form.
- The language cannot build an environment with a new or replaced binding: every env ref derives from `environment::self`. `process::set-env`, and the hot reload of SPEC-CPI section 6 and DESIGN-001 section 8, therefore can't be driven from control plane code (`examples/life/20-rule-swap.slight`). DESIGN-001 has patches come from the pipeline, which is not specified yet. *Resolved Sep 27, 2026:* building environments from roles (see Spec changes). `examples/life/20-rule-swap.slight` still records the old finding.
- DESIGN-001 section 3 says what a `BEGIN` phaser adds "is a patch, composed onto the environment with the module rule: a conflict is an error", and that "a hot reload is simply a patch going through its phases". Section 8 says a hot reload's `Conflicted` slots "record what was replaced". Read together, replacing a name in a hot reload is an error. A reading that fits both: the module rule applies within a load, and a finished patch is composed onto a running environment with whatever strategy the control plane chooses.
- DESIGN-001's primitive table lists "Compose slots; resolve; swap" for environments, but SPEC-CPI section 10.4 has no resolve, so `Conflicted` history can only grow.
- DESIGN-001's appendix "Reference implementations" cites more-roles for the slot algebra but not the prototypes that build environments from it. Proposed row: | Environment construction | p5-MXCL, Term-Roles, p5-slight | `__older_prototypes__/MXCLs/p5-MXCL` (`lib/MXCL/Allocator/Roles.pm`, `Term/Role*.pm`, `Context.pm` base-scope layers, `Machine.pm` Define and Capture, `Runtime/Primitives.pm` `Role::*`, `Debugger/Scope.pm`); `__older_prototypes__/misc-experiments/Term-Roles`, commit `be6c0ba` (`src/Term.ts`); `__older_prototypes__/p5-slight` (`lib/Slight/Term.pm` `Partial`, `Compiler.pm`) | Environments as first-class, content-addressed slot maps; a base environment built in composed layers; `require` as `Required` slots; difference as the diff between environments; lambdas without an environment as the unit of content hashing | Global environments only; patches from definitions, not captured as a difference (MXCL's `make-role` carries the replaced binding inside a `Conflicted` slot); value identity by core hash; late binding instead of capturing the environment; a resolve step |
- SPEC-CPI does not say what happens when several live processes receive on one address (spawning onto a live process's mailbox, or unparking one parked value twice). The prototype let the newest process own it, and a non-durable mailbox dead-lettered sends once that owner ended, even if others still waited on it. *Resolved Sep 28, 2026:* several receivers on one mailbox (see Spec changes).
- The CPI has no way to wait for a particular process: `actor::join` and `actor::recv` are not available to it (SPEC-CPI section 1), and `host::wait` reports which PIDs woke but not why.
- Nothing in SPEC-CPI reclaims ended processes or parked state: the process table and the park table only grow. *Resolved Sep 29, 2026, for processes and mailboxes:* the host reclaims what nothing can name (see Spec changes). The park table still only grows, since parked data can be written by hand.
- Views can show only strings and numbers. *Resolved Sep 26, 2026:* the `value->string` core operation (see Spec changes) turns any value into the text `IO::print` shows.
