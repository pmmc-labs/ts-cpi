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
