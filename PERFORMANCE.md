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
