# Performance

A baseline, taken Sep 28, 2026 on an Apple M2 Max (12 cores) with Node
26.9, to inform the choice of parallelism features. Nothing here has been
optimised yet.

## The interpreter

`tools/bench/interpreter.slight` against the same work in plain JavaScript
(`tools/bench/native.js`):

| Work | Interpreter | Ticks per operation | JavaScript | Slower by |
| --- | --- | --- | --- | --- |
| counting loop | 1.08 M iterations/s | 18 | 2,456 M/s | 2,300× |
| `fib 22` | 0.47 M calls/s | 37 | 238 M/s | 500× |
| map over a list | 0.58 M elements/s | 31 | 93 M/s | 160× |
| make and call a closure | 0.66 M/s | 29 | 177 M/s | 270× |
| `string-append` | 0.82 M/s | 24 | 64 M/s | 78× |
| `vector-set` (copies 16) | 0.65 M/s | 30 | 94 M/s | 143× |
| message to self and back | 0.24 M/s | 30 | | |

- **About 18 to 20 million ticks a second, whatever the work.** A basic operation costs 18 to 37 ticks, so the interpreter does 0.5 to 1 million operations a second. The gap to JavaScript is smallest where JavaScript itself allocates (strings, vectors) and largest in tight arithmetic.
- **A message round trip costs about 4.1 µs,** of which the process's own 30 ticks are 1.6 µs. The rest is a batch: the CPI's call to `process::run`, the host request, and delivering the message at the batch's end.
- **Where the time goes** (from the gateway profiles below): the stepping functions (`stepEval`, `stepRet`, `step`, `applyHead`) about 35%; `listToArray` 11 to 13%, because code lists are turned into arrays each time they are evaluated; garbage collection 4 to 5%, as every step allocates a new state.

## The gateway

`tools/profile_gateway.sh` runs the plain gateway under `node --cpu-prof`
and plays load with `tools/load.ts` (keep-alive clients, each sending its
next request as soon as the last is answered). `tools/profile_summary.ts`
splits the profile by layer and by whose behalf the time was spent: a
process's batch, or the CPI's own code.

### Where it tops out

| hello load | With the monitor's metrics | Metrics stubbed out |
| --- | --- | --- |
| 1 client | 890/s, p50 1.1 ms | 2,066/s, p50 0.5 ms |
| 8 clients | 1,627/s, p50 5.0 ms | 3,272/s, p50 2.4 ms |
| 32 clients | 1,570/s, p50 20 ms | 3,213/s, p50 9.9 ms |
| 128 clients | queues full: 503s | queues full: 26,639 answers/s, mostly 503 |
| CPU: the CPI / process batches | 79% / 4.5% | 63% / 11% |

- **The CPI is the bottleneck, not the processes.** A hello request costs about 430 ticks in the router and a worker (25 µs). With metrics, the CPI spends about 500 µs per request; without them, about 200 µs.
- **The metrics cost half the capacity.** Recording each served request (histograms, running summaries, two endpoint updates) and sampling queues every loop is per-request and per-loop arithmetic in interpreted code.
- **HTTP is not the limit.** The host answered 26,000 requests a second when it could refuse them itself.

### Where it falls down

| Scenario | What happens | Why |
| --- | --- | --- |
| New counters, 8 clients | 23 requests/s, p50 374 ms | Each new name is a round trip through the CPI, a mailbox and a spawn. |
| hello after 150 counters exist | 889/s instead of 1,600 | The CPI's loop walks every process every time round: `process::state` for each, lists rebuilt with `append`, parked counters polled with `mailbox::size`. |
| `/slow` beside hello | slow: 176,000 ticks/s of 17 M, every request 504; hello: 1,526/s | Each ready process gets 200 ticks per round, and a round is expensive, so one process's throughput is 200 × the loop rate. |
| overload, 128 clients | 503 in under 1 ms | Backpressure works: the host refuses at the full mailbox. |
| the monitor | 13 to 25 ms a frame, on the same thread | Drawing blocks everything (SPEC-TUI sections 15 and 16). |

## What this says

1. **The control plane is where the time goes.** CPI code is interpreted, 100 to 2,000 times slower than host code, so anything the CPI does per request, per message or per turn outweighs the work it manages. The CPI should act per event it needs to decide on, not per turn: the host should run the turns, and do per-request arithmetic like histograms. The charts and tables showed the same division of labour for drawing.
2. **Parallelism for processes alone would not help the gateway today.** Process batches are 5 to 11% of the CPU. If a single CPI still had to start every turn, more threads running turns would wait on it. Parallelism pays once the CPI is out of the per-turn path, or when the work itself is heavy (`/slow`).
3. **Two single-thread fixes change the balance first.** A host builtin that runs every ready process for a round and returns only the stop reasons the CPI must act on (no polling, no per-turn interpretation), and code converted to arrays once at load instead of on every evaluation.

## Where the CPI's own ticks go

A probe (not kept: a copy of `runCpi` counting each step against the CPI
procedures on the continuation) split the CPI's ticks by what they were
for. Hello at 8 clients, before `process::run-ready`:

| | CPI ticks per request | Where they go |
| --- | --- | --- |
| The gateway | 9,400 | about 75% metrics: the served log 31%, sampling queues 30%, charging each turn's ticks 12%, all through `update-endpoint`, which rebuilds the endpoint list with `map` |
| Metrics stubbed | 1,700 | scheduling: the round 41%, the idle check 15 to 26%, keeping processes with `append` 11 to 15%, 9 `process::state` calls a round |

A process needs about 430 ticks for the same request.

## After `process::run-ready` (Sep 28, 2026)

The host runs the round and reports only processes that ended, trapped or
went idle (`DECISIONS.md`, Spec changes). Same machine and tools as the
baseline, `tools/profile_gateway.sh`:

| hello load | Before | After | Metrics stubbed, before | Metrics stubbed, after |
| --- | --- | --- | --- | --- |
| 1 client | 890/s, p50 1.1 ms | 1,263/s, p50 0.8 ms | 3,218/s | 7,062/s, p50 0.1 ms |
| 8 clients | 1,627/s, p50 5.0 ms | 2,606/s, p50 3.0 ms | 5,941/s | 13,602/s, p50 0.6 ms |
| 32 clients | 1,570/s, p50 20 ms | 2,491/s, p50 12.7 ms | 5,811/s | 13,040/s, p50 2.3 ms |
| CPU: the CPI / process batches | 79% / 4.5% | 76% / 5.4% | 57% / 13% | 25% / 26% |

The "metrics stubbed" columns replace `record-served`, `add-ticks`,
`sample-queues`, `roll-second` and `add-phases` with procedures that return
the state unchanged, so they stub more than the baseline's 3,300/s run did.

| Scenario | Before | After |
| --- | --- | --- |
| New counters, 8 clients | 23/s, p50 374 ms | 32/s, p50 130 ms |
| hello after the counters (8 clients) | 889/s with 150 counters | 854/s with 219 (202 asleep); 2,505/s with 292 when the sleeping counters are not polled |
| `/slow` beside hello | 176,000 ticks/s, every request 504; hello 1,526/s | 308,000 ticks/s, every request 504; hello 2,501/s |

- **Scheduling left the CPI.** With metrics stubbed, the CPI's share of the CPU fell from 57% to 25%, and throughput rose 2.3×. The CPI, the processes, and HTTP and Node outside the CPI now take about a quarter each.
- **The metrics are now nearly all of the CPI's work:** 5,800 ticks per hello request, 90% of them metrics (the served log about 49%, sampling queues about 40%). They cost 80% of the capacity.
- **Many processes still hurt, for one reason:** the CPI polls the mailbox of every parked counter every loop to know when to wake it, and rebuilds that list with `append`. Stubbing it restored hello to its speed without counters.
- **`/slow` is a capacity problem, not a scheduling one.** A request needs about 9 million ticks, half a second of the whole CPU. With four clients queued on one worker and a 2 s timeout it cannot keep up at any quota: at a quota of 4,000 (probe) it took a quarter of the CPU from hello and still timed out. That is what `parallel::` is for.

**The interpreter, probed.** Converting code lists to arrays once, instead of
at every evaluation (a probe caching the array on the pair), made
`tools/bench/interpreter.slight` 10 to 14% faster, which matches
`listToArray`'s share of the profile. With the CPI out of the per-turn path,
process batches are a quarter of the CPU, so the interpreter's speed now
sets throughput directly.

## After `plan::run` (Sep 28, 2026)

The host runs rounds and waits until the CPI is needed; the gateway's CPI
runs once per batch of events, and a sleeping counter's mailbox is in the
plan's inbox, so nothing is polled (`DECISIONS.md`, Spec changes).

| hello, 8 clients | After `run-ready` | After `plan::run` |
| --- | --- | --- |
| The gateway | 2,606/s, p50 3.0 ms | 3,075/s, p50 2.4 ms |
| Metrics stubbed (the served log still wakes the CPI) | 13,602/s | 13,651/s |
| No served log: the CPI wakes only on events | | 17,416/s, p50 0.4 ms |
| CPU with no served log: the CPI / process batches / outside the CPI | | 0.1% / 42% / 29% |

| Scenario | After `run-ready` | After `plan::run` |
| --- | --- | --- |
| New counters, 8 clients | 32/s, p50 130 ms | 100/s, p50 72 ms |
| hello after the counters | 854/s with 219 (202 asleep) | 2,520/s with 609 (477 asleep) |
| `/slow` beside hello | hello 2,501/s; every slow request 504 | hello 3,050/s; every slow request 504 |

- **With nothing to meter, the CPI is idle.** Without the served log it used 18 ms of CPU in a 25-second run, and the gateway did 17,416 requests a second: processes (42%) and HTTP and Node outside the CPI (29%) are the limit now.
- **The served log is what still wakes the CPI.** It is delivered in every wait, so the CPI wakes about as often as before, and metrics are still most of its work: the monitor faux actor (`DESIGN-PLAN.md`, step 3) is the next large gain.
- **Many processes no longer cost.** hello with 477 counters asleep runs at the speed it has with none, now that no sleeping counter is polled. A first version walked the whole list of sleeping counters for each mail event, including mail in the CPI's own inbox, which cost 36% of the CPI's ticks (a CPI tick profile found it).

## After the hibernate node (Sep 28, 2026)

Counters sleep in the plan's hibernate node: the host parks a counter idle
for two seconds and unparks it at its first request, and the plan no longer
changes as they come and go. `settle`, inside every wait, found the
receivers a delivery woke by checking every process waiting in `recv` (10%
of the CPU with 150 counters awake); it now records them as they wake.

| Scenario | After `plan::run` | After the hibernate node |
| --- | --- | --- |
| hello, 8 clients | 3,075/s | 3,220/s |
| New counters, 8 clients | 100/s, p50 72 ms | 118/s, p50 70 ms |
| hello after the counters | 2,520/s with 477 asleep | 2,904/s with 555 asleep |

- **A new counter costs 5.6 ms** with one client, against 0.6 ms for one that exists, and eight clients queue behind each other. The CPI's books are lists: each hibernate event walks the process list twice and appends to the list of sleepers, about 25,000 ticks with 700 counters, and the counters endpoint looks names up in a list too.
- **Every round walks every live process** in the host to find the ready ones; cheap per process, but it grows with the blocked ones.

## After the monitor node (Sep 28, 2026)

Metrics are counted in the host by the plan's monitor node, a faux actor:
the served log goes to its address, it counts ticks by environment and
queue lengths after every round, and sends the CPI one summary a second.
The monitor draws when there is a new summary or event.

| Scenario | After the hibernate node | After the monitor node |
| --- | --- | --- |
| hello, 1 client | 1,698/s, p50 0.6 ms | 10,199/s, p50 0.1 ms |
| hello, 8 clients | 3,220/s, p50 2.3 ms | 17,878/s, p50 0.4 ms |
| hello, 32 clients | 3,028/s, p50 10.6 ms | 16,894/s, p50 1.7 ms |
| CPU: the CPI / process batches / outside the CPI | 69.5% / 7.8% / 11.1% | 0.1% / 44% / 30% |
| New counters, 8 clients | 118/s, p50 70 ms | 131/s, p50 61 ms |
| hello after the counters | 2,904/s with 555 asleep | 17,463/s with 628 asleep |
| `/slow` beside hello | hello 3,220/s | hello 15,090/s; every slow request still 504 |
| hello under the live monitor, 8 clients | | 16,527/s |

- **The CPI is out of the per-request path.** At 17,878 requests a second it used 15 ms of CPU in a 25-second run. The gateway is now five to eleven times faster than at the start of the day (1,627/s), and the limit is the processes (44%) and HTTP and Node (30%).
- **Metrics in the host cost about nothing:** throughput with the monitor node is what it was with no served log at all (17,416/s).
- **Many processes no longer matter for hello:** 17,463/s with 628 counters asleep and 169 awake.
- **What is left:** new counters (the CPI's list bookkeeping and the counters endpoint's linear lookups, 5 to 6 ms each), `/slow` (capacity, for `parallel::`), and the interpreter itself, which now sets the speed of everything.

## After the pool node (Sep 28, 2026)

The hello pool is the plan's pool node, grown each round while requests
wait. Throughput is unchanged, since more workers on one thread share the
same interpreter; what changed is that the pool scales again.

| Scenario | After the monitor node | After the pool node |
| --- | --- | --- |
| hello, 8 clients | 17,878/s, 1 worker | 17,476/s, 4 workers (the maximum) |
| hello after the counters | 17,463/s | 17,169/s |
| `/slow` beside hello | hello 15,090/s | hello 15,364/s |
| The CPI's share of the CPU, hello | 0.1% | 0.1% |

## After view templates (Sep 28, 2026)

The monitor node draws the view itself, from a template the CPI gives it
once; the CPI builds no frames. Live on a terminal, the gateway served
17,625 hello requests a second at 8 clients under the monitor, the same as
without it within noise (17,476/s): the CPI's share of the CPU stays 0.1%.

## The ring benchmark (Sep 29, 2026)

`examples/ring/` times the ring benchmark from *Programming Erlang*, N
processes passing a message round M times, run by `process::run`,
`process::run-ready` and `plan::run`, on a cloud VM at about half the M2
Max's speed and on a laptop; its README has the tables. In short, on the
laptop: a message costs 2.5 µs when the host runs the rounds, and about
twice that when the CPI runs every turn. Spawning a process costs 8.4 µs,
most of it the CPI's own code. Because a round runs processes in PID
order, a ring whose PIDs fall round it waits a round at all but one hop a
lap: 10,000 messages round 10,000 processes took 404 ms instead of 22. And
`plan::run` paid about 12 µs a round when rounds were short, which the
VM's noise had hidden.

## Actor requests and code lists (Sep 29, 2026)

Two changes that leave behavior and tick counts alone, measured on the
ring benchmark's cloud VM:

- **Actor requests without the table lookup.** A process's `actor::`
  requests go straight to their handlers, the request context is made once
  per batch instead of once per request, and `actor::send` checks capacity
  from a count kept on the mailbox instead of scanning the batch's outbox,
  which made k sends in one batch cost O(k²).
- **Code lists kept as arrays.** The machine turned each code list into an
  array every time it evaluated it. The array is now made once and kept on
  the list's first pair, as probed above ("The interpreter, probed").

| CPU time, median of five interleaved runs | Before | Actor requests | And code lists |
| --- | --- | --- | --- |
| The ring: 600,000 messages under `process::run-ready` | 3,764 ms | 3,329 ms (−12%) | 3,098 ms (−18%) |
| `tools/bench/interpreter.slight`, all of it | 6,711 ms | 6,546 ms (−2%) | 5,422 ms (−19%) |

- **Each change pays where its work is.** A ring message is three host
  requests around about 32 ticks of short code, so the actor requests gave
  the ring most of its gain; the interpreter benchmarks make few host
  requests and gained from the code lists.
- **The code lists gained more than the probe's 10 to 14%**, and their runs
  (5,361 to 5,761 ms) did not overlap those of either other build (6,124 to
  7,285 ms). The ring's runs of one build varied by up to 23%, so its
  figures are rougher.

## A round visits only what can act (Sep 29, 2026)

A round walked every live process to find the ready ones and check idle
times ("After the hibernate node" found it growing with the blocked ones).
The ring benchmark shows what that costs. With PIDs falling round the ring,
a message wakes a process the round has passed, so each hop takes a round
of its own, and each round walked the whole ring: on the laptop, 100,000
messages round 100,000 processes took 55,849 ms, against 271 with PIDs
rising.

A round now starts from the processes that are ready and those whose wait
in `recv` is long enough for the shortest threshold in use, sorted by PID,
and a process woken during the round joins it if the round has not reached
its PID. The turns, events and results are the old walk's (`DECISIONS.md`,
the hibernate node's "Found while building", item 2).

| The ring on its cloud VM, PIDs falling, wall time | Before | After |
| --- | --- | --- |
| 10,000 × 1, `process::run-ready` | 871 to 1,104 ms | 122 to 182 ms |
| 10,000 × 1, `plan::run` | 992 to 1,072 ms | 127 to 150 ms |
| 100,000 × 1, `process::run-ready` | 114,994 ms | 1,716 to 1,908 ms |
| 100,000 × 1, `plan::run` | 118,123 ms | 2,169 to 2,248 ms |
| 100,000 × 1, `process::run`, which runs no rounds | 1,941 ms | 1,699 to 1,811 ms |

Three runs each at 10,000 processes; at 100,000, one before and two after.
In the benchmark's own second table (best of three, both builds in one
session), the falling `run-ready` column went from 73, 94, 169 and 816 ms
to 74, 89, 98 and 106 for N = 10, 100, 1,000 and 10,000.

- **A falling ring now pays for its rounds, not its size.** At 100,000
  processes `process::run-ready` takes as long as the CPI's own loop in
  ring order, where it took about 60 times as long. Each hop is still a
  round: about 18 µs with `process::run-ready`, which goes round the CPI's
  loop, and 22 µs with `plan::run`, against about 6 µs a message with PIDs
  rising. On the laptop the ring of 100,000 took 782 ms after the change,
  against 55,849 before, 678 under `process::run` and 275 with PIDs rising.
- **Messages cost what they did.** Every message changes a process's
  status twice, so what a status change costs shows in every ring. CPU
  time, medians of eight interleaved runs of each build: 4,114 ms against
  3,999 before for rings of 10 passing 600,000 messages, 200,000 under each
  scheduler, and 4,189 against 4,370 for 1,000 processes that are all
  ready in each of 721 rounds. The runs of the two builds overlap in both.
  On the laptop, no figure in the benchmark's first table moved by more
  than 4% between the runs before and after the change.
- **A first version cost about 13% on both.** It kept the ready processes
  and the waits in Sets, which hash on every status change and make
  garbage, and put every turn in a heap. Now the ready processes are an
  array in which each knows its place, the waits are kept only from the
  first round with a threshold, and a round sorts the processes it starts
  with once (they are mostly in PID order already), keeping a heap only for
  those woken during it.

## Reclaiming what nothing can name (Sep 29, 2026)

Every process and mailbox stayed in the host's tables for the life of the
image: about 1.2 KB for a ring process and its mailbox. A laptop run of the
ring benchmark with a row of 100,000 × 10 in both tables made about 3
million of them and ran out of heap. The host now drops an ended or parked
process once no value refers to its PID, and a mailbox once none refers to
its address (`DECISIONS.md`, "Reclaiming what nothing can name").

| On the ring benchmark's VM | Before | After |
| --- | --- | --- |
| Heap kept per ended ring process with its mailbox, from snapshots of 50,000 | 1,153 bytes; 1,309 after 10 laps | 42 and 15 bytes, in tables sized for the biggest ring |
| Rings of 100,000 processes in a 600 MB heap | out of heap after 300,000 to 400,000 processes | 3 million processes, peak 530 MB |
| The benchmark, peak memory | 741 to 804 MB | 353 MB |
| The benchmark with the laptop's extra rows, 100,000 × 1 and × 10 in both tables, in a 4 GB heap | out of heap on the laptop after about 3 million processes | all 3.8 million processes, peak 1,303 MB |

- **Messages cost what they did.** CPU time, medians of interleaved runs:
  3,684 ms against 3,671 before for rings of 10 passing 600,000 messages
  (eight runs each), and 4,209 against 4,143 for 1,000 processes all ready
  in each of 721 rounds (six runs each). The runs of the two builds overlap
  in both.
- **A first version cost 11% on the rings of 10.** It dropped a mailbox's
  set of waiters when the set emptied, so every message made a new set.
  The waiters now live on the mailbox's entry, and each process keeps its
  own mailbox's entry, so a message needs fewer table lookups than before.

## Fewer allocations per step (Oct 2, 2026)

Every step allocated more than it needed to. Four changes to the machine
cut that, and leave behavior and tick counts alone:

- **Frames keep an index, not a copy.** The frames for `do`, `cond`,
  `and`, `or`, `let` and arguments held the forms still to run as a new
  array, sliced from the last one at every step. They now hold the code
  array the forms are in and the index of the next one.
- **Arguments collect in a persistent list.** An argument frame copied the
  values so far into a new array for each argument, so a call with n
  arguments made n + 1 arrays, and a procedure call one more to drop the
  procedure. Each frame now adds one node to its predecessor's list, and
  the array is made once, when the head is applied. Frames still never
  change, because a parked continuation may be unparked more than once.
- **A symbol or literal shares its parent's site.** Its site was a new
  copy of the parent's, with the same procedure and position.
- **Heads are made once.** Every application made a new `Head`, and a host
  request split its name into namespace and action again. There is now
  one head for calls and one per core operation, and a host name's head is
  made the first time the name is evaluated.

Measured on a cloud container with Node 22.22, in interleaved runs of main
(`18b7c33`, with `fold`) and the change:

| `tools/bench/interpreter.slight` | Before | After |
| --- | --- | --- |
| Allocated in the whole run, summed from `node --trace-gc` | 19,502 MB | 12,946 MB (−34%) |
| loop, median of three runs | 3,171 ms | 2,039 ms (−36%) |
| `fib 22` | 160 ms | 67 ms (−58%) |
| map 1000x200 | 613 ms | 365 ms (−40%) |
| closures | 539 ms | 322 ms (−40%) |
| strings | 456 ms | 256 ms (−44%) |
| vectors | 597 ms | 299 ms (−50%) |
| messages | 442 ms | 268 ms (−39%) |
| All of it | 5,978 ms | 3,616 ms (−40%) |

- **The short benchmarks vary most.** `fib 22` took 95 to 179 ms on main.
  An earlier set of runs, before the heads change, gave −33% for all of it
  (5,773 ms to 3,886).
- **Allocation fell by about a third everywhere.** Driving the machine
  directly, before the heads change, `fib 25` allocated 987 MB instead of
  1,446, a million turns of a tail-calling loop 3,783 MB instead of 5,531,
  and a non-tail recursion 100,000 deep 469 MB instead of 691.
- **A deep continuation keeps less alive:** 362 bytes per level of that
  recursion instead of 522, measured with a forced collection at its
  deepest point.
- **The heads are the smallest part:** 3% of the allocation (13,360 MB to
  12,946), and about 4% of the time in six interleaved runs of each build,
  within their spread.
- **Time fell more than garbage collection explains.** Collection itself
  took about 64 ms of `fib 25` instead of 75: a scavenge costs what
  survives, and about as much survives as before. Most of the gain is the
  copying the slices and argument arrays did.
- **What every step still allocates:** a new state and mode, and a site
  each time a list is evaluated. The next section measures why they stay.

## The state, mode and sites stay (Oct 2, 2026)

After the changes above, a step allocates about 203 bytes on `fib` and on
a tail-calling loop, counted with an instrumented copy of the machine and
V8's sampling heap profiler. Node does not compress pointers, so the state
(56 bytes) and its mode (40 to 56) are about half of that; frames with
their continuation nodes, 0.44 a step, about a quarter; sites, 0.28 a
step, about 5%. Three ways to make fewer of them were tried on copies of
the machine, run directly on `fib 25`, a million turns of the loop and a
non-tail recursion 100,000 deep, outside the runtime. None was kept.

- **One state and mode, overwritten by every step, is slower.** It halved
  what was allocated (`fib 25` 498 MB instead of 955, the loop 1,829
  instead of 3,669) and the time spent collecting, but `fib 25` took
  328 ms instead of 267 and the loop 1,162 instead of 888 (medians of six
  interleaved runs; the deep recursion took the same). The one state
  soon lives in the old generation, so every step's stores of new values
  into it go through V8's write barrier: `node --prof` puts 15.7% of the
  loop's ticks in `RecordWriteSaveFP`, against under 0.1% as kept, while
  collection fell only from 14.9% to 5.7% of them. A new state each step
  points only at older objects and dies young, which the young
  generation handles at almost no cost. Machine registers kept in an
  object, as in a mutable register machine, would pay the same.

The other two save allocation, not time:

| Median of six interleaved runs | Allocated, `fib 25` / loop | Time, `fib 25` / loop / deep |
| --- | --- | --- |
| As kept | 954 / 3,668 MB | 278 / 892 / 280 ms |
| The mode's fields in the state, one object a step | 814 / 3,109 MB (−15%) | 275 / 928 / 319 ms |
| Each list's site cached on its pair | 918 / 3,512 MB (−4%) | 273 / 927 / 248 ms |
| Both | 776 / 2,953 MB (−19%) | 253 / 849 / 245 ms |

- **None of those times is a gain.** The runs of each build overlap those
  of every other. Collection is about 15% of the loop's ticks as kept, so
  the 16% less collection time of both together is worth 2 to 3% of the
  whole.
- **And both cost.** Moving the mode's fields into the state changes the
  `State` type in the machine, the runtime, the loader and about 35 test
  lines, and the cache would be a second mutable field on code pairs,
  beside `elements`.
