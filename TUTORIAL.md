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
    (IO::print :list (cons 1 (cons "two" (cons :three ())))))
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
- **Only `#false` is false.** `()`, `0` and `""` are all true.
- **Integers and floats don't mix.** `(+ 1 2.0)` is a `type-error`; convert
  with `integer->float` or `float->integer`. Integers are 64-bit, and overflow
  throws.
- **Core operations can't be rebound.** Names like `+`, `car` and `throw` are
  fixed, so a file `bad.slight` containing `(defun main () (let + 1) +)` fails
  at load time:

  ```
  #<error load-error "bad.slight:1:1: '+' is reserved and cannot be used as a let name">
  ```

  Core operations can still be passed as values: `(twice car x)` works.

## 3. Errors

Errors are values with a tag, a message, a payload and an optional cause. The
runtime records where an error was thrown. An error is thrown **at most
once**: to pass one on, wrap it in a new error with `wrap-error`.

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

Throwing the same error twice gives `already-thrown` instead. See
`tests/programs/errors.slight`, which also uses `environment::error-pad` to read
the local variables that were live where an error was thrown.

## 4. Processes

The CPI is the image's main loop. It spawns processes, runs them in batches, and
decides what to do with what they report. Nothing runs unless the CPI runs it.

```lisp
; examples/processes.slight
(defun greeter (name)
    (let msg (actor::recv))
    (IO::print name :got msg)
    (greeter name))

(defun sneaky ()
    (host::now))

(defun main ()
    (let p (process::spawn greeter (cons :g ()) (environment::self) '(actor IO) #false))
    (IO::print :state (process::state p))
    (IO::print :run1 (process::run p 50))
    (IO::print :state (process::state p))
    (mailbox::send (process::address p) :hello)
    (IO::print :state (process::state p))
    (IO::print :run2 (process::run p 3))
    (IO::print :run3 (process::run p 50))
    (IO::print :checkpoint (process::checkpoint p))
    (let q (process::spawn sneaky () (environment::self) '(actor) #false))
    (let r (process::run q 50))
    (IO::print :sneaky (car r) (error-tag (car (cdr r)))))
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
sneaky failed not-granted
```

Step by step:

1. **`process::spawn f args env grants mailbox`** creates a `ready` process that
   will apply `greeter` to `(:g)`. It resolves global names through `env`, here
   the CPI's own environment. It may use only the namespaces in `grants`, and
   receives on `mailbox` (`#false` makes a fresh one).
2. **`process::run p n`** runs the process for at most `n` ticks, one tick per
   evaluator step. It returns a **stop reason** saying why it stopped. The first
   run ends with `(blocked recv)`, because the mailbox is empty.
3. **`mailbox::send`** from the CPI delivers at once, and the process becomes
   `ready` again.
4. With a quota of 3, the process runs out of ticks before printing: `(quota)`.
   It is preempted, not failed, and the next `run` continues where it stopped.
5. **`process::checkpoint`** returns the arguments of the most recent call to
   the procedure the process was spawned with: here `(g)`. This is how you
   restart an actor (section 5).
6. `sneaky` was granted only `actor`, and `host::` is a privileged namespace,
   so its request throws `not-granted` inside the process. It isn't caught
   there, so the run reports `(failed e)`.

All the stop reasons are `(quota)`, `(blocked recv)`, `(blocked join <pid>)`,
`(blocked host)`, `(exited v)`, `(failed e)` and `(trap <effect> <args>)`.

An **actor** is a process whose long-lived state lives in the arguments of a
tail-recursive loop, like `greeter` above. A message it sends from inside a
batch reaches the receiver when that batch ends.

## 5. Restarting a failed actor

`tests/programs/restart.slight` shows the recovery pattern:

```lisp
(defun counter (n)
    (let msg (actor::recv))
    (case msg
        (:boom (throw (make-error :boom "boom!" n)))
        (:inc  (do (IO::print :count (+ n 1)) (counter (+ n 1))))
        (else  (counter n))))

(defun main ()
    (let mbox (mailbox::create #true 100))
    (let p1 (process::spawn counter (cons 0 ()) (environment::self) '(actor IO) mbox))

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

    (let p2 (process::spawn counter checkpoint (environment::self) '(actor IO) mbox))
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

The counter's state is its argument `n`. Each `(counter (+ n 1))` call updates
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
`host::wait` suspends the image until something completes, which in this
prototype means a timer. Changing the policy means changing this loop: give
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
(let p2 (process::unpark parked (environment::self)))  ; new PID, same address
(mailbox::send addr :hello)
(process::run p2 100)                                  ; → prints "got hello"
```

The unparked process continues inside the same `recv` it was waiting in, and
`unpark` chooses which environment it resumes with.

**Timers** (`tests/programs/timers.slight`) use virtual time.
`(timer::sleep ms)` blocks a process with `(blocked host)`. `host::wait`
advances the clock to the earliest deadline and returns the PIDs that woke,
and `host::now` reads the clock. Actors sleeping 100 and 50 ms wake in the
order `b` then `a`, at times 50 and 100, and the result is the same on every
run.

## 8. Common mistakes

| Symptom | Cause |
| --- | --- |
| `let may appear only as an element of a body` | A `let` inside an argument or `if` test. Move it into the enclosing body, or wrap it in `(do …)`. |
| `top-level form must be (defun ...) or (const ...)` | A bare expression at file level. Put it in `main`. |
| `not-granted` in a process | The namespace isn't in the spawn's `grants`, or it's privileged (`process`, `mailbox`, `host`, `environment`), which processes can never have. |
| `bad-state` from `process::run` | The process isn't `ready`. Check `process::state` first. |
| A process never sees a message | Messages sent during a batch arrive when that batch ends, and a blocked process must be `run` again to receive. |
| `(quota)` on a loop you expected to finish | Quotas count evaluator steps, about 18 per iteration of a simple loop, not calls. |

For the full semantics, see `../../design-xxx/SPEC-CPI.md`. For the choices
this prototype made where the spec is open, see `DECISIONS.md`.
