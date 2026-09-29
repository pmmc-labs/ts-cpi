# The ring benchmark

The exercise from Joe Armstrong's *Programming Erlang*:

> Write a ring benchmark. Create N processes in a ring. Send a message round
> the ring M times so that a total of N * M messages get sent. Time how long
> this takes for different values of N and M.

```sh
node bin/cpi.ts examples/ring/ring.slight examples/ring/bench.slight   # about 30 s on the VM below
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

Two runs of the benchmark on Sep 29, 2026, both after that day's changes
to the interpreter and to the round (`PERFORMANCE.md`, "Actor requests and
code lists" and "A round visits only what can act"): on the cloud VM this
example was written on, and on a laptop. The runs from before the changes
are in this file's history.

### Cloud VM

A 4-core Intel Xeon at 2.1 GHz with Node 22.22. This machine ran
`tools/bench/interpreter.slight` at about half the speed of the M2 Max in
`PERFORMANCE.md`: 9.7 million ticks a second on the counting loop before
the changes, 13.7 million after. The benchmark took 32 seconds and peaked
at 800 MB.

```
The ring benchmark: N processes in a ring, and a message sent round it
M times, N × M messages in all. Each ring is timed three ways, by how much
of the running the CPI hands to the host. Times are in milliseconds, each
the fastest of 3 runs:

    process::run         the CPI runs each turn: one process, until it blocks
    process::run-ready   the host runs each round: every ready process, once
    plan::run            the host runs rounds until a process ends

      N       M   messages  spawn ms  process::run  process::run-ready  plan::run
     10  10,000    100,000         0           721                 380        394
    100   1,000    100,000         1           866                 403        406
  1,000     100    100,000        13           896                 431        433
 10,000      10    100,000       142         1,048                 633        607

process::run-ready's round runs processes in PID order. With PIDs falling
round the ring, every hop but one a lap waits for the next round. The CPI's
own round (process::run) goes in ring order, whichever way the PIDs go:

                                 run-ready       run-ready    process::run
                               PIDs rising    PIDs falling    PIDs falling
       N       M  messages   rounds     ms   rounds     ms   rounds     ms
      10   1,000    10,000    1,001     41    9,001     78    1,001     72
     100     100    10,000      101     42    9,901    101      101     86
   1,000      10    10,000       11     43    9,991    100       11     84
  10,000       1    10,000        2     46   10,000    150        2    111
```

Every ring sent exactly N × M messages. This machine is noisy: over three
runs of the benchmark, figures in the first table moved by up to 22%, and
in the second by up to two thirds. Read the tables for their factors of two
and more, which held in every run, not for their last digits.

### Laptop

The same benchmark, one run, with a row of 100,000 processes added to each
table (the sizes are at the top of `bench.slight`; the first table's new
row alone takes about six minutes).

```
The ring benchmark: N processes in a ring, and a message sent round it
M times, N × M messages in all. Each ring is timed three ways, by how much
of the running the CPI hands to the host. Times are in milliseconds, each
the fastest of 3 runs:

    process::run         the CPI runs each turn: one process, until it blocks
    process::run-ready   the host runs each round: every ready process, once
    plan::run            the host runs rounds until a process ends

      N       M   messages  spawn ms  process::run  process::run-ready  plan::run
     10  10,000    100,000         0           419                 231        338
    100   1,000    100,000         0           394                 199        209
  1,000     100    100,000         8           444                 217        221
 10,000      10    100,000        83           499                 266        269
100,000     100 10,000,000       917        56,225              32,746     34,849

process::run-ready's round runs processes in PID order. With PIDs falling
round the ring, every hop but one a lap waits for the next round. The CPI's
own round (process::run) goes in ring order, whichever way the PIDs go:

                                 run-ready       run-ready    process::run
                               PIDs rising    PIDs falling    PIDs falling
       N       M  messages   rounds     ms   rounds     ms   rounds     ms
      10   1,000    10,000    1,001     24    9,001     48    1,001     45
     100     100    10,000      101     21    9,901     55      101     46
   1,000      10    10,000       11     24    9,991     68       11     54
  10,000       1    10,000        2     27   10,000     77        2     70
 100,000       1   100,000        2    275  100,000    782        2    678
```

And a second run with only 100,000 × 1 in the first table:

```
      N       M   messages  spawn ms  process::run  process::run-ready  plan::run
100,000       1    100,000       910           581                 215        229
```

A later run of the same code, with 100,000 × 1 in both tables, came within
8% of the first table's figures, most of them a little slower, except
`run-ready`'s 100,000 × 1 (246 ms against 215), and within 12% of the
second table's.

The laptop ran 1.5 to 2.4 times as fast as the VM, and the factors of two
and more held. Two things differed: a bigger ring cost it much less extra
per message (finding 4), and `plan::run` was slower than
`process::run-ready` when rounds were short (finding 3), so it gained
least there: 338 ms against the VM's 394 for the ring of 10.

## What it shows

1. **A message costs 2.3 µs on the laptop and 3.8 on the VM when the host
   runs the rounds:** 231 and 380 ms for 100,000 messages round 10
   processes, about 430,000 and 260,000 a second. On the VM, about three
   fifths of that is the processes' own code, 31 ticks a message. The rest
   is the turn around it: two host requests, the message delivered when the
   batch ends, and the next process woken.
2. **When the CPI runs every turn, a message costs nearly twice as much.**
   `process::run` took 419 ms where `process::run-ready` took 231 on the
   laptop, and 721 where it took 380 on the VM. For every message the CPI
   asks for a process's state, runs it, and goes round its own loop in the
   interpreter, which costs about as much as the message itself. This is
   `PERFORMANCE.md`'s lesson in miniature: work the CPI does per turn costs
   as much as the turn. With one lap there is more of it: the CPI's second
   round walks the whole ring, every process ended but the head, to find
   the one left to run. Round 100,000 processes a message cost the laptop
   5.8 µs against 4.2 round 10, and on the VM, timing each round, the walk
   took 314 ms of 1,616.
3. **`plan::run` gives the CPI its time back; it doesn't make the
   processes faster.** The CPI wakes M + 1 times with `run-ready` (10,001
   for the ring of 10), and twice with `plan::run`. On the VM the two ran
   equally fast, within the noise. On the laptop `plan::run` was slower
   when rounds were short: 338 ms against 231 for the ring of 10, whose
   10,001 rounds carry ten messages each, about 11 µs a round; 209 against
   199 with ten times fewer rounds; and 221 against 217 at 1,000
   processes. Four laptop runs, before the changes and after, found the
   same 10 to 12 µs a round. Between rounds `plan::run` waits 0 ms to take
   in input, which is the likeliest cost.
4. **Big rings cost more per message, mostly when they live long.** Under
   `process::run-ready`, a message cost the VM 1.7 times as much at 10,000
   processes as at 10 (633 ms against 380), for the same ticks, and the
   laptop 1.15 times (266 against 231). Sent round 100,000 processes 100
   times, a message cost the laptop 3.3 µs, 1.4 times as much as round 10;
   sent round them once, it cost 2.2 µs (215 ms for 100,000), no more than
   round 10. A process's state is replaced at every turn and lives until
   the process's next turn, a lap later. Round 10 processes it dies young;
   round 10,000 it lives through young-generation collections, which copy
   it and then promote it to the old generation. With `node --trace-gc`,
   each ring alone in a fresh process on the VM, the collections during the
   run took 0.17 µs a message round 10 processes, 0.84 µs round 100,000
   with one lap and 2.8 µs with ten, where a message cost 4.7, 6.5 and
   10.8 µs: about half of the extra with ten laps. With one lap the VM paid
   about another microsecond a message besides, which the laptop did not.
5. **Spawning a process costs as much as three or four messages:** 83 ms
   for 10,000 on the laptop and 142 on the VM, 8.3 and 14 µs each, and
   about 9 µs each for 100,000 on the laptop. `process::spawn` itself takes
   about 1.5 µs on the VM (a CPU profile). Most of the rest is the CPI's
   own code making the ring: for each process, in the interpreter, a
   mailbox, a procedure that spawns the process, and the call.
6. **Which way the message goes round matters to the host.** A round runs
   processes in PID order, and `DECISIONS.md` specifies what follows: a
   process woken by a message sent in a round runs in that round if its PID
   is higher than the sender's, and in the next round otherwise. With PIDs
   falling round the ring every hop but one a lap waits, so a ring takes
   (N − 1) × M + 1 rounds instead of M + 1, and each round is a trip round
   the CPI's loop. At N = 10,000 and M = 1, 10,000 messages took 77 ms
   instead of 27 on the laptop, and 150 instead of 46 on the VM: about 5
   and 10 µs more a hop. The CPI's own round goes in ring order whichever
   way the PIDs go, and took 70 and 111 ms: slower turns and a second walk
   of the ring (finding 2), but 2 rounds.
   `DECISIONS.md` gives this answer too: a CPI that needs a different loop
   writes it with `process::run`.

   Until the round change, a round also walked every live process, so a
   falling ring's time grew with the square of its size: at N = 10,000 the
   laptop took 404 ms instead of 22, and at N = 100,000, 55,849 ms instead
   of 271. It now takes 782 ms there, against 275 with PIDs rising and 678
   under `process::run` (`PERFORMANCE.md`, "A round visits only what can
   act").

   Erlang's schedulers run processes in the order they became runnable, so
   there a ring runs the same either way. Doing that here would change what
   `process::run-ready` is specified to do, so it is a question for
   `DESIGN-PLAN.md`, not something this example changes.
7. **Nothing is reclaimed.** Ended processes stay in the process table
   (`examples/life/README.md`, finding 4), about 1.5 KB each after garbage
   collection. The benchmark spawns about 200,000 of them, and the laptop's
   run with its extra rows about 2 million, so later rows run with a bigger
   heap than earlier ones. That is why the schedulers take turns within
   each size, rather than one scheduler timing every size and then the
   next.
