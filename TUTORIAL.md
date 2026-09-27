# Tutorial: writing control plane code

This tutorial walks through the CPI prototype from the bottom up: the language,
errors, then processes and the builtins the control plane uses to run them. The
examples come from `examples/` and `tests/programs/`, and every output shown
here is what the prototype actually prints.

You need Node 22.6 or later. From this directory:

```sh
npm install
node bin/cpi.ts examples/hello.slight
```

## 1. Running a program

A program is one or more `.slight` files containing only `defun` and `const`
forms. The CLI loads them in order and evaluates `(main)`:

```lisp
; examples/hello.slight
(defun main ()
    (IO::print "hello," "world" 42))
```

```
$ node bin/cpi.ts examples/hello.slight
hello, world 42
```

`IO::print` prints its arguments separated by spaces, with strings shown
without quotes. The CLI exits with 0 when `main` returns, 1 when `main` throws,
and 2 when loading fails.

Names containing `::` are **host requests**: calls out of the language into the
host. The part before `::` is a namespace. The program running `main` is the
CPI, which is granted every namespace. Section 4 shows how ordinary processes
are restricted.

## 2. The language

```lisp
; examples/tour.slight
(const greeting "counting down")

(defun sum-to (n acc)
    (if (= n 0)
        acc
        (sum-to (- n 1) (+ acc n))))

(defun describe (x)
    (case x
        (:red   "warm")
        (:blue  "cool")
        (else   "unknown")))

(defun main ()
    (IO::print greeting)
    (let total (sum-to 100 0))
    (IO::print :sum total)
    (IO::print :red (describe :red) :green (describe :green))
    (let twice (lambda (f x) (f (f x))))
    (IO::print :twice (twice (lambda (n) (* n 3)) 5))
    (IO::print :list (list 1 "two" :three)))
```

```
counting down
sum 5050
red warm green unknown
twice 45
list (1 two three)
```

The things to notice:

- **`const`** is evaluated once at load time. It may use earlier definitions
  but may not make host requests: `(const t (host::now))` is a load error.
- **`let`** binds a name for the *rest of the body* it sits in. It is not a
  block with its own body, and it can appear only as an element of a body: a
  `defun`, `lambda`, `do`, or `cond`/`case` clause.
- **`:red`** is shorthand for `(quote red)`, a symbol. Symbols compare with
  `eq?`, which is what `case` uses.
- **Tail calls run in constant space.** `sum-to` calls itself in tail
  position, so it could count to a billion without growing the stack.
  `tests/programs/tailcalls.slight` runs a 1,000,000-iteration loop.
- **Quasiquote builds data.** `` `(a ,b ,@c) `` is a list with the value of
  `b` in place of `,b` and the elements of the list `c` spliced in place of
  `,@c`. Everything else in the template is taken literally:

  ```lisp
  (let gen 4)
  (let rows '((Text "a") (Text "b")))
  `(Box (Text "generation " ,gen) ,@rows)   ; (Box (Text "generation " 4) (Text "a") (Text "b"))
  ```

  A quasiquote inside another quasiquote is not supported.
- **Lists, strings and vectors.** `(list 1 2 3)` builds a list,
  `(string-append "a" "b" "c")` joins any number of strings, and
  `(string-join ", " parts)` joins a list of strings with a separator between
  them, like Perl's `join`. Both string operations take strings only; convert
  anything else with `value->string`. A vector is an immutable, fixed-length
  sequence, and `vector-ref` reaches any element in one step:

  ```lisp
  (let v (list->vector (list :a :b :c)))
  (vector-ref v 1)                    ; b
  (vector-set v 1 :x)                 ; #(a x c), a new vector: v is unchanged
  (vector-length (make-vector 4 0))   ; 4
  (vector->list v)                    ; (a b c)
  ```

  `vector-set` copies the whole vector, so build a list and convert it with
  `list->vector` rather than setting elements one at a time.
- **Only `#false` is false.** `()`, `0` and `""` are all true.
- **Indent 4 spaces per open parenthesis**, as every example here does. The
  reader ignores layout; the people reading your code don't.
- **Integers and floats don't mix.** `(+ 1 2.0)` is a `type-error`; convert
  with `integer->float` or `float->integer`. Integers are 64-bit, and overflow
  throws.
- **Core operations can't be rebound.** Names like `+`, `car` and `throw` are
  fixed, so a file `bad.slight` containing `(defun main () (let + 1) +)` fails
  at load time:

  ```
  #<error load-error "bad.slight:1:1: '+' is reserved and cannot be used as a let name">
  ```

  Core operations can still be passed as values: `(twice car x)` works. The
  exceptions are `list`, `string-append` and `vector`, which take any number of
  arguments and so can only be called; passing one is a load error.

## 3. Errors

Errors are values with a tag, a message, a payload and an optional cause. The
runtime records where an error was thrown, the first time it is thrown. To
pass a caught error on unchanged, use `rethrow`; to add to it, wrap it in a new
error with `wrap-error`.

```lisp
; examples/errors.slight
(defun parse-age (s)
    (if (string? s)
        (throw (make-error :bad-age "not a number" s))
        s))

(defun load-user (name age)
    (catch (parse-age age)
        e
        (throw (wrap-error e :bad-user "could not load user" name))))

(defun main ()
    (let e (catch (load-user "ada" "forty") err err))
    (IO::print :tag (error-tag e) :cause (error-tag (error-cause e)))
    (IO::print :trace (stack-trace-for (error-cause e)))
    (load-user "bob" "fifty"))
```

`(catch body name handler)` evaluates `body`; if it throws, it binds the error
to `name` and evaluates `handler` instead. The first call's error is caught and
inspected; the second is not, so `main` fails:

```
$ node bin/cpi.ts examples/errors.slight
tag bad-user cause bad-age
trace ((parse-age errors.slight 3 9) (load-user errors.slight 7 5) (main errors.slight 12 12) (main errors.slight 12 12))
#<error bad-user "could not load user">
  at load-user (errors.slight:9:9)
caused by:
#<error bad-age "not a number">
  at parse-age (errors.slight:3:9)
  at load-user (errors.slight:7:5)
```

The last five lines go to stderr, and the exit code is 1.

`stack-trace-for` returns the trace as data, innermost first, one
`(procedure file line column)` entry per waiting frame. Two things in these
traces are worth understanding:

- In the uncaught error, `main` does not appear: `(load-user "bob" "fifty")` is
  a tail call, so `main`'s frame was already gone. Traces show only frames
  still waiting for a value.
- In the caught one, `main` appears twice, because two frames wait at line 12:
  the `let` and the `catch`.

`throw` refuses an error that has already been thrown and throws
`already-thrown` instead, so passing an error on is always explicit. `rethrow`
is for cleanup that should leave the error alone:

```lisp
(catch (work)
    e
    (do
        (cleanup)
        (rethrow e)))
```

The caller sees the original error, with its tag and its trace from the first
throw. `rethrow` of an error that was never thrown is `bad-state`. See
`tests/programs/errors.slight`, which also uses `environment::error-pad` to read
the local variables that were live where an error was thrown.

## 4. Processes

The CPI is the image's main loop. It spawns processes, runs them in batches, and
decides what to do with what they report. Nothing runs unless the CPI runs it.

```lisp
; examples/processes.slight
; A process's code is a role: it captures nothing from where it is written,
; and names everything it uses from outside, host actions included.
(defun greeter-code ()
    (role
        (require actor::recv IO::print)
        (defun greeter (name)
            (let msg (actor::recv))
            (IO::print name :got msg)
            (greeter name))))

; This one asks for the time, which only the CPI may do.
(defun sneaky-code ()
    (role
        (require host::now)
        (defun sneaky ()
            (host::now))))

(defun main ()
    (let env (environment::resolve (greeter-code) '(actor IO)))
    (let p (process::spawn (environment::lookup env 'greeter) (list :g) env '(actor IO) #false))
    (IO::print :state (process::state p))
    (IO::print :run1 (process::run p 50))
    (IO::print :state (process::state p))
    (mailbox::send (process::address p) :hello)
    (IO::print :state (process::state p))
    (IO::print :run2 (process::run p 3))
    (IO::print :run3 (process::run p 50))
    (IO::print :checkpoint (process::checkpoint p))
    (let sneaky (sneaky-code))
    (IO::print :sneaky
        (catch (process::spawn (environment::lookup sneaky 'sneaky) () sneaky '(actor) #false)
            e
            (list (error-tag e) (error-payload e)))))
```

```
state (ready)
run1 (blocked recv)
state (blocked recv)
state (ready)
run2 (quota)
g got hello
run3 (blocked recv)
checkpoint (g)
sneaky (not-granted host)
```

Step by step:

1. **A process's code is a role.** `(role ...)` holds definitions and captures
   nothing from where it is written. Every name its code uses from outside must
   be named in a `require`, host actions included: `greeter` uses `actor::recv`
   and `IO::print` and requires both. Using a name without requiring it is a
   load error. Section 9 covers roles in full.
2. **`environment::resolve env grants`** checks that the role can run in a
   process granted `grants`, and returns it: every host action it requires must
   be in a granted namespace.
3. **`process::spawn f args env grants mailbox`** creates a `ready` process that
   will apply `f`, here `greeter` looked up in the role, to `(:g)`. Its global
   names resolve through `env`. It may use only the namespaces in `grants`, and
   receives on `mailbox` (`#false` makes a fresh one).
4. **`process::run p n`** runs the process for at most `n` ticks, one tick per
   evaluator step. It returns a **stop reason** saying why it stopped. The first
   run ends with `(blocked recv)`, because the mailbox is empty.
5. **`mailbox::send`** from the CPI delivers at once, and the process becomes
   `ready` again.
6. With a quota of 3, the process runs out of ticks before printing: `(quota)`.
   It is preempted, not failed, and the next `run` continues where it stopped.
7. **`process::checkpoint`** returns the arguments of the most recent call to
   the procedure the process was spawned with: here `(g)`. This is how you
   restart an actor (section 5).
8. `sneaky` requires `host::now`, and `host::` is a privileged namespace that no
   process can be granted. `process::spawn` checks an environment's
   requirements against the grants, so it throws `not-granted`, with the
   namespace as payload, and the process never starts.

A process can also run in `(environment::self)`, the CPI's own environment. It
can then call everything the CPI defines, and nothing is declared or checked
until it runs.

All the stop reasons are `(quota)`, `(blocked recv)`, `(blocked join <pid>)`,
`(blocked host)`, `(exited v)`, `(failed e)` and `(trap <effect> <args>)`.

An **actor** is a process whose long-lived state lives in the arguments of a
tail-recursive loop, like `greeter` above. A message it sends from inside a
batch reaches the receiver when that batch ends.

## 5. Restarting a failed actor

`tests/programs/restart.slight` shows the recovery pattern:

```lisp
(defun counter-code ()
    (role
        (require actor::recv IO::print)
        (defun counter (n)
            (let msg (actor::recv))
            (case msg
                (:boom (throw (make-error :boom "boom!" n)))
                (:inc  (do (IO::print :count (+ n 1)) (counter (+ n 1))))
                (else  (counter n))))))

(defun main ()
    (let mbox (mailbox::create #true 100))
    (let env (environment::resolve (counter-code) '(actor IO)))
    (let counter (environment::lookup env 'counter))
    (let p1 (process::spawn counter (list 0) env '(actor IO) mbox))

    (mailbox::send mbox :inc)
    (process::run p1 100)
    (mailbox::send mbox :inc)
    (process::run p1 100)

    (mailbox::send mbox :boom)
    (let r3 (process::run p1 100))
    (IO::print :stop (car r3))
    (IO::print :error-tag (error-tag (car (cdr r3))))

    (let checkpoint (process::checkpoint p1))
    (IO::print :checkpoint checkpoint)

    (let p2 (process::spawn counter checkpoint env '(actor IO) mbox))
    (mailbox::send mbox :inc)
    (let r4 (process::run p2 100))
    (IO::print :restarted-stop (car r4))
    :done)
```

```
count 1
count 2
stop failed
error-tag boom
checkpoint (2)
count 3
restarted-stop blocked
```

The counter's state is its argument `n`. Both runs use the same environment,
built once from the counter's role. Each `(counter (+ n 1))` call updates
the checkpoint slot, so after the failure `process::checkpoint` returns `(2)`,
the last good count. The CPI spawns a new run with those arguments **on the
same mailbox**, so the actor keeps its address and continues from 3.

The mailbox is created **durable** (`#true`). A non-durable mailbox whose
process has ended sends new messages to the dead-letter queue.

## 6. A scheduler in the language

Scheduling is control plane code: a loop over stop reasons.
`tests/programs/scheduler.slight` runs two ping-pong actors round robin:

```lisp
(defun run-round (pids)
    (if (nil? pids)
        ()
        (do
            (let p (car pids))
            (when (eq? (car (process::state p)) :ready)
                (do
                    (let r (process::run p 20))
                    (IO::print :stop r)))
            (run-round (cdr pids)))))

(defun scheduler (pids)
    (when (not (all-ended? pids))
        (do
            (run-round pids)
            (when (and (not (all-ended? pids)) (not (any-ready? pids)))
                (host::wait #false))
            (scheduler pids))))
```

Each round gives every `ready` process 20 ticks. When nothing is ready,
`host::wait` suspends the image until something happens: a timer fires, or a
key is pressed (section 8). Changing the policy means changing this loop: give
some processes bigger quotas, run the busiest first, or detect deadlock when
nothing is ready and nothing is pending.

## 7. Traps, parking and timers

These three are short; each has a test program you can run.

**Traps** (`tests/programs/traps.slight`) let the CPI take over an effect.
After `(host::set-traps '(send))`, an actor's `actor::send` stops the process
with `(trap send (<addr> <msg>))` instead of sending. The CPI can inspect,
change or drop the message, perform it with `mailbox::send`, and then
`(process::resume p #true)`, which hands `#true` back as the result of the
actor's `send`. `process::resume-throw` answers with an error instead.

**Parking** (`tests/programs/parking.slight`) sets aside a process blocked in
`recv` or `join`:

```lisp
(let addr (process::address p))
(let parked (process::park p))                        ; p's PID is now ended
(let p2 (process::unpark parked env))                 ; new PID, same address
(mailbox::send addr :hello)
(process::run p2 100)                                  ; → prints "got hello"
```

The unparked process continues inside the same `recv` it was waiting in, and
`unpark` chooses which environment it resumes with: here `env`, the one it ran
in before.

**Timers** (`tests/programs/timers.slight`) use the real clock.
`(timer::sleep ms)` blocks a process with `(blocked host)`. `host::wait` waits
until the earliest deadline and returns the PIDs that woke, and `host::now`
reads the clock: milliseconds since the image started. Actors sleeping 100
and 50 ms wake in the order `b` then `a`, at about 50 and 100 ms. Tests run
on a virtual clock instead, where time moves only when `host::wait` jumps it
to the next deadline, so they see exactly 50 and 100 on every run.

## 8. Drawing on the terminal

The CPI can draw on the terminal and read the keyboard with the privileged
`tui::` namespace (`SPEC-TUI.md`). A screen is a **view**: plain data shaped
like `(Tag (@ (prop value) ...) child ...)`, usually built with quasiquote.
Here is the smallest interactive program:

```lisp
; examples/tui/counter.slight
(defun view (n)
    `(Box
        (Box (@ (borderStyle round) (paddingX 1) (gap 2))
            (Text (@ (bold #true)) "count " ,n)
            (Text (@ (dimColor #true)) "↑/↓ change · q quit"))))

(defun loop (n inbox)
    (tui::render (view n))
    (host::wait #false)
    (let next (keys n inbox))
    (if (eq? next :quit) n (loop next inbox)))

(defun keys (n inbox)
    (let event (mailbox::take inbox))
    (cond
        ((eq? event #false) n)
        ((not (eq? (car event) :key)) (keys n inbox))
        (#true
            (case (car (cdr event))
                (:up (keys (+ n 1) inbox))
                (:down (keys (- n 1) inbox))
                ("q" :quit)
                (else (keys n inbox))))))

(defun main ()
    (tui::open 'inline)
    (let inbox (mailbox::create #true 16))
    (tui::subscribe inbox)
    (let final (loop 0 inbox))
    (tui::close)
    (IO::print "final count" final))
```

```
╭──────────────────────────────╮
│ count 3  ↑/↓ change · q quit │
╰──────────────────────────────╯
final count 3
```

- **Components** are `Box` (flexbox layout), `Text`, `Newline` (inside `Text` only) and `Spacer`. Props follow CSS flexbox (`flexDirection`, `gap`, `padding`, `width`, `borderStyle`, ...) and text styles (`color`, `bold`, `dimColor`, ...). An unknown component or prop is a `type-error` naming it.
- **`tui::render` draws before it returns.** Whatever you rendered is on screen, even if the CPI then gets busy. Render when something worth showing has changed.
- **Keys are messages.** `(tui::subscribe inbox)` sends `(key name modifiers)` and `(resize columns rows)` to a mailbox. They are delivered only inside `host::wait`, so a loop draws, waits, then reads its mailbox. A key name is a string for a printable key and a symbol like `up` or `return` otherwise.
- **`inline` or `fullscreen`.** Inline mode draws below your output, and `IO::print` lines appear above the view. Fullscreen mode takes the whole terminal and holds `IO::print` lines until `tui::close`.
- **Ctrl-C** is an ordinary key while you are subscribed. Otherwise it ends the program, after restoring the terminal.
- **A view shows strings and numbers.** To show any other value, turn it into text with `value->string`, which gives what `IO::print` would show: `(Text ,(value->string (process::state p)))` shows `(blocked recv)`.

`examples/tui/life.slight` animates the Game of Life with a population
sparkline, and `examples/tui/top.slight` is a live process monitor you can
pause, step and steer from the keyboard.

## 9. Building environments with roles

A process runs in an environment: the names its code calls resolve through
the env ref it was given. Section 4 built one from a single role. Roles also
compose, and a role can leave names for other roles to fill:

```lisp
; examples/roles.slight
(defun rule-code ()
    (role
        (require actor::recv actor::send born survives member?)
        (defun rule-server ()
            (let msg (actor::recv))
            (actor::send (car msg) (life-rule (car (cdr msg)) (car (cdr (cdr msg)))))
            (rule-server))
        (defun life-rule (alive n)
            (if (= alive 1)
                (if (member? n survives) 1 0)
                (if (member? n born) 1 0)))))

(defun lists ()
    (role
        (defun member? (x xs)
            (cond
                ((nil? xs) #false)
                ((eq? x (car xs)) #true)
                (#true (member? x (cdr xs)))))))

(defun conway ()
    (role
        (const born '(3))
        (const survives '(2 3))))

(defun seeds ()
    (role
        (const born '(2))
        (const survives ())))

(defun server-env (rule)
    (environment::resolve
        (environment::compose (environment::compose (lists) (rule-code)) rule)
        '(actor)))
```

- **A role captures nothing** from where it is written: not the local
  variables around it, and not the CPI's own environment. Every name its code
  uses from outside must be named in a `require`, host actions included, or
  loading fails. A role holds only `defun`s, `require`s, and `const`s whose
  value is a literal or quoted data.
- **A role with `Required` names is abstract.** Composing it with roles that
  define those names fills them. `rule-code` needs `member?`, which `lists`
  defines, and `born` and `survives`, which `conway` and `seeds` define: a
  required `const` works as a parameter.
- **`environment::resolve`** checks that an environment can run in a process
  granted the given namespaces: every other name is filled, and every host
  action it requires is in a granted namespace. It returns the environment,
  or throws `unbound` listing what is missing.
- **Composing never fails.** Two different definitions of one name become a
  conflict, which `environment::conflicts` lists, and lookup takes the newer
  one. Identical definitions, such as the same `defun` loaded twice, compose
  without a conflict.
- **Libraries can be roles.** `examples/actors/actors.slight` keeps the
  helpers actors use in a role, `actor-library`, which requires the host
  actions they call. `spawn-actor` composes it with the actor's own role, so an
  actor's environment holds its own code and the library and nothing else, and
  resolving it checks the library's host actions too.
- **Code the CPI also runs can't be a role.** A role's procedures resolve their
  global names through the environment of whoever runs them, and the CPI's
  environment comes from its files. So when a process needs a library the CPI
  also uses, it takes exactly the names it requires from the CPI's
  environment: `(environment::select e names)` keeps only the named slots, and
  `process-env` in `examples/life/lib/lists.slight` composes the role onto
  `(environment::select (environment::self) (environment::required code))`.
- **Require everything the process reaches.** A library procedure calls other
  procedures by name, and a closure sent to a process runs with the
  receiver's environment, so a role must require those names too: a role
  that calls `sum` also requires `fold`. A name it forgets is `unbound` when
  the process first reaches it, because `environment::resolve` only sees the
  names the role lists.

`main` asks the server about a dead cell, swaps the rule's parameters while
the server runs, and asks again:

```lisp
(defun ask (pid box alive n)
    (mailbox::send (process::address pid) (list box alive n))
    (process::run pid 1000)
    (mailbox::take box))

(defun main ()
    (IO::print :needs (environment::required (rule-code)))
    (IO::print :unfilled (catch (environment::resolve (rule-code) '(actor)) e (error-payload e)))
    (let box (mailbox::create #false 10))
    (let env (server-env (conway)))
    (let pid (process::spawn (environment::lookup env 'rule-server) () env '(actor) #false))
    (IO::print :conway (ask pid box 0 3) (ask pid box 0 2))
    (process::set-env pid (server-env (seeds)))
    (IO::print :seeds (ask pid box 0 3) (ask pid box 0 2))
    (IO::print :changed (environment::conflicts (environment::compose env (seeds)))))
```

```
needs (actor::recv actor::send born survives member?)
unfilled (born survives member?)
conway 1 0
seeds 0 1
changed (born survives)
```

The server calls `life-rule` and itself by name, and names resolve when they
are called, so after `process::set-env` its next message is answered by the
new rule. That is a hot reload: here it changes two parameters and no code.
`process::spawn`, `process::set-env` and `process::unpark` refuse an
environment that requires a host action the process isn't granted.

Roles can also hold state. `environment::define` adds one value, and
`environment::history` lists every value a conflicted name has had, oldest
first. `environment::accept` flattens the conflicts you no longer want to
keep, so a program decides for itself which names keep their history. The
`compose-with` procedure in `DECISIONS.md` ("Building environments from
roles") does this with a strategy you pass in, and `environment::difference`
shows what composing one environment onto another would change.

## 10. Common mistakes

| Symptom | Cause |
| --- | --- |
| `let may appear only as an element of a body` | A `let` inside an argument or `if` test. Move it into the enclosing body, or wrap it in `(do …)`. |
| `top-level form must be (defun ...) or (const ...)` | A bare expression at file level. Put it in `main`. |
| `'x' is used in a role but neither defined nor required there` | Add `x` to a `require`, or define it in the role. The local variables around a `role` form are not visible inside it. |
| `not-granted` from `process::spawn` | The environment requires a host action whose namespace the spawn doesn't grant, or one that is privileged (`process`, `mailbox`, `host`, `environment`), which processes can never have. |
| `not-granted` in a process | The process runs in `(environment::self)` or in library code from it, and used a namespace it wasn't granted. |
| `bad-state` from `process::run` | The process isn't `ready`. Check `process::state` first. |
| A process never sees a message | Messages sent during a batch arrive when that batch ends, and a blocked process must be `run` again to receive. |
| `bad-state: input is not a terminal` | `tui::subscribe` needs a real terminal; it fails when input is piped. |
| `(quota)` on a loop you expected to finish | Quotas count evaluator steps, about 18 per iteration of a simple loop, not calls. |

For the full semantics, see `../../design-xxx/SPEC-CPI.md`. For the choices
this prototype made where the spec is open, see `DECISIONS.md`.
