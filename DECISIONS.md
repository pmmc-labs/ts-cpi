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
- PIDs are interned like symbols, so every PID value for one process is the same object and `eq?` holds (before, PIDs returned by `host::wait` were fresh objects).
- `tui::` follows SPEC-TUI, accepted Sep 26, 2026 with every recommended decision (D1 to D8). The terminal backend is Ink (`src/tui/terminal.ts`); tests use the headless backend (`src/tui/headless.ts`), whose scripted input arrives in place of time passing under the virtual clock.
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
- Nothing in SPEC-CPI reclaims ended processes or parked state: the process table and the park table only grow.
- Views can show only strings and numbers. *Resolved Sep 26, 2026:* the `value->string` core operation (see Spec changes) turns any value into the text `IO::print` shows.
