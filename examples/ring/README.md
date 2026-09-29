# The ring benchmark

The exercise from Joe Armstrong's *Programming Erlang*:

> Write a ring benchmark. Create N processes in a ring. Send a message round
> the ring M times so that a total of N * M messages get sent. Time how long
> this takes for different values of N and M.

```sh
node bin/cpi.ts examples/ring/ring.slight examples/ring/bench.slight   # about 45 seconds
node bin/cpi.ts examples/ring/ring.slight examples/ring/check.slight
```

| File | Contents |
| --- | --- |
| `ring.slight` | The ring, three ways to run it, and the timing and tables. A library: load it first. |
| `bench.slight` | Times rings of different sizes. The sizes and the number of runs are at the top. |
| `check.slight` | Checks that the three ways of running a ring agree, on small rings. `tests/ring.test.ts` runs it. |

## How it works

**The ring.** Each process is given the address of the next one round the
ring, and M. The message is a number, one more at every hop, so it counts
the messages sent. The head sends the first one and ends each lap; every
other process passes it on. After the last lap every process has exited,
the head with the count, which must be N × M: `time-ring` throws
`miscounted` if it isn't.

**Making it.** In Erlang each process could spawn the next, passing the
head's PID along for the last one. Here only the CPI can spawn, and a ring
is circular: whichever process it spawns first needs the address of one
that doesn't exist yet. But a mailbox can exist before its process. The CPI
makes every mailbox first, then spawns a process on each
(`process::spawn`'s last argument), giving it the next one's address. A
mailbox holds one message at most, since only one is ever in flight.

**Running it.** Nothing runs unless the CPI runs it, so each ring is run
three ways, from the CPI doing the most to the host doing the most:

| Scheduler | The CPI | The host |
| --- | --- | --- |
| `process::run` | runs each round itself: every process that is ready when its turn comes, in ring order | runs one turn, until the process blocks |
| `process::run-ready` | loops over rounds, M + 1 of them | runs the same round, in PID order |
| `plan::run` | wakes when processes end: once when the relays exit, on the last lap, and once when the head does | runs rounds until a process ends |

Those counts are for PIDs rising round the ring, as they do when the
processes are spawned in ring order; finding 6 is about the other way.
Every process runs until it blocks, so the turns are the same whichever
scheduler runs them. `check.slight` checks that: on each ring, every process
must end the same way and use the same ticks under all three. It prints the
head's count and how many times the CPI went round its loop with each
scheduler: rounds for the first two, calls for `plan::run`.

```
$ node bin/cpi.ts examples/ring/ring.slight examples/ring/check.slight
N 1 M 3 rising | 3 messages | loops (4 4 1) | agree
N 2 M 3 rising | 6 messages | loops (4 4 2) | agree
N 5 M 4 rising | 20 messages | loops (5 5 2) | agree
N 40 M 3 rising | 120 messages | loops (4 4 2) | agree
N 1 M 3 falling | 3 messages | loops (4 4 1) | agree
N 2 M 3 falling | 6 messages | loops (4 4 1) | agree
N 5 M 4 falling | 20 messages | loops (5 17 4) | agree
N 40 M 3 falling | 120 messages | loops (4 118 39) | agree
```

**Timing.** Times are milliseconds of real time, from `host::now`, each the
fastest of 3 runs. The schedulers take turns within each size, so each is
timed with the image in much the same state (finding 7).

## Results

*Sep 29, 2026*, on a 4-core Intel Xeon at 2.1 GHz (a cloud VM) with Node
22.22. This machine runs `tools/bench/interpreter.slight` at about half the
speed of the M2 Max in `PERFORMANCE.md`: 9.7 million ticks a second on the
counting loop. The benchmark took 47 seconds and peaked at 720 MB.

```
The ring benchmark: N processes in a ring, and a message sent round it
M times, N × M messages in all. Each ring is timed three ways, by how much
of the running the CPI hands to the host. Times are in milliseconds, each
the fastest of 3 runs:

    process::run         the CPI runs each turn: one process, until it blocks
    process::run-ready   the host runs each round: every ready process, once
    plan::run            the host runs rounds until a process ends

      N       M  messages  spawn ms  process::run  process::run-ready  plan::run
     10  10,000   100,000         0           971                 456        475
    100   1,000   100,000         1         1,200                 576        557
  1,000     100   100,000        16         1,270                 606        622
 10,000      10   100,000       169         1,499                 846        736

process::run-ready's round runs processes in PID order. With PIDs falling
round the ring, every hop but one a lap waits for the next round. The CPI's
own round (process::run) goes in ring order, whichever way the PIDs go:

                                 run-ready       run-ready    process::run
                               PIDs rising    PIDs falling    PIDs falling
       N       M  messages   rounds     ms   rounds     ms   rounds     ms
      10   1,000    10,000    1,001     48    9,001     92    1,001     86
     100     100    10,000      101     48    9,901    136      101     96
   1,000      10    10,000       11     59    9,991    229       11    139
  10,000       1    10,000        2     56   10,000    956        2    131
```

Every ring sent exactly N × M messages. This machine is noisy: over three
runs of the benchmark, figures in the first table moved by up to 25%, and
in the second by up to 50%. Read the tables for their factors of two and
more, which held in every run, not for their last digits.

## What it shows

1. **A message costs about 4.5 µs when the host runs the rounds:** 456 ms
   for 100,000 messages round 10 processes, 220,000 a second. About two
   thirds of that is the processes' own code, 31 ticks a message. The rest
   is the turn around it: two host requests, the message delivered when the
   batch ends, and the next process woken.
2. **When the CPI runs every turn, a message costs twice as much.**
   `process::run` took 971 ms where `process::run-ready` took 456. For every
   message the CPI asks for a process's state, runs it, and goes round its
   own loop in the interpreter: 5.2 µs, more than the message itself. This
   is `PERFORMANCE.md`'s lesson in miniature: work the CPI does per turn
   costs more than the turn.
3. **`process::run-ready` and `plan::run` are equally fast**, within the
   noise. What differs is how often the CPI wakes: M + 1 times with
   `run-ready` (10,001 for the ring of 10), twice with `plan::run`.
   `plan::run` gives the CPI its time back; it doesn't make the processes
   faster.
4. **Bigger rings cost more per message:** 1.5 to 1.9 times as much at
   10,000 processes as at 10, for the same ticks. It holds when the sizes
   take turns too, so it is not the heap growing from row to row. About
   half of it is garbage collection. A process's state is replaced at
   every turn, and in a ring of 10,000 each state lives for a whole round.
   In one run the young-generation collections took 180 ms at N = 10,000
   against 53 ms at N = 10, with a 22 ms full collection besides
   (`node --trace-gc`).
5. **Spawning a process costs almost as much as four messages:** 169 ms
   for 10,000, 17 µs each. `process::spawn` itself takes about 1.5 µs (a CPU
   profile). Most of the rest is the CPI's own code making the ring: for
   each process, in the interpreter, a mailbox, a procedure that spawns the
   process, and the call.
6. **Which way the message goes round matters to the host.** A round runs
   processes in PID order, and `DECISIONS.md` specifies what follows: a
   process woken by a message sent in a round runs in that round if its PID
   is higher than the sender's, and in the next round otherwise. With PIDs
   falling round the ring every hop but one a lap waits, so a ring takes
   (N − 1) × M + 1 rounds instead of M + 1, and each round walks every live
   process: the bigger the ring, the more a message costs. At N = 10,000
   and M = 1, 10,000 messages took 956 ms instead of 56. The CPI's own
   round goes in ring order whichever way the PIDs go, and took 131 ms:
   slower turns, but 2 rounds. `DECISIONS.md` gives this answer too: a CPI
   that needs a different loop writes it with `process::run`.

   Erlang's schedulers run processes in the order they became runnable, so
   there a ring runs the same either way. Doing that here would change what
   `process::run-ready` is specified to do, so it is a question for
   `DESIGN-PLAN.md`, not something this example changes.
7. **Nothing is reclaimed.** Ended processes stay in the process table
   (`examples/life/README.md`, finding 4), about 1.5 KB each after garbage
   collection. The benchmark spawns about 200,000 of them, so later rows run
   with a bigger heap than earlier ones. That is why the schedulers take
   turns within each size, rather than one scheduler timing every size and
   then the next.
