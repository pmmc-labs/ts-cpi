# Making the single thread efficient

This session is a **discussion**, and its outcome is an agreed plan. We are
deciding how to make one CPI thread do more useful work before adding any
parallelism. Don't build or refactor anything until we have agreed on what to
change. Small measured probes, like stubbing something out in a copy of a file
to see what it costs, are welcome, and so are numbers.

## Read first

- `PERFORMANCE.md`: the baseline from Sep 28, 2026. It is the reason for this session.
- `CLAUDE.md`, and the project memories, for how we work: spec first, evidence first, 4-space indents.
- `examples/gateway/README.md` and `examples/gateway/gateway.slight`: the workload. The supervisor loop is `gateway`, near the end of the file.
- `src/machine.ts` (the evaluator), `src/runtime.ts` (`runBatch`, `dispatchHost`, `host::wait`) and `src/values.ts`.
- `../../design-xxx/SPEC-CPI.md` sections 7, 10 and 11, for what the machine and `process::run` promise.

## The problem, in numbers

- **The interpreter** runs 18 to 20 million ticks a second. A basic operation costs 18 to 37 ticks, so it manages 0.5 to 1 million operations a second, 78 to 2,300 times slower than JavaScript. A message round trip costs about 4.1 µs, of which about 2.5 µs is the batch that delivers it.
- **The gateway peaks at 1,600 requests a second,** or 3,300 with the monitor's metrics stubbed out. **The CPI's own code uses 63 to 79% of the CPU; process batches use 5 to 11%.** A request is about 25 µs of process work and 200 to 500 µs of CPI work.
- **It falls down with many processes:** hello throughput halves with 150 counters around. It also falls down with CPU-heavy work: `/slow` gets 1% of the ticks and every request times out.
- **Profile hot spots:** the stepping functions take about 35%, `listToArray` 11 to 13% (code lists are converted to arrays on every evaluation), and GC 4 to 5% (every step allocates a new state).

The principle we arrived at: the CPI is interpreted, so it should act per
**event it must decide on**, while the host does per-turn, per-request and
per-frame work. Charts and tables already moved drawing into the host.
Remember the lesson from tables, too: moving work into the host only helps if
the host does it cheaply, so measure both sides.

## Candidates to discuss

For each candidate, say what it would win, measure or estimate it where you
can, and say whether it is a spec change. My first ideas are below; add your
own and challenge mine.

**The CPI's loop and the host interface (the biggest lever)**

- **Readiness from the runtime.** The loop calls `process::state` on every process every round, because nothing tells it which processes a message woke. The runtime already knows. The options range from a `process::ready` that returns the ready PIDs, to stop reasons and `host::wait` reporting every wake, to a host-driven round.
- **A host-driven round.** One builtin runs every ready process, or a given group, with a quota policy given as data, and returns only the stop reasons the CPI must act on: exits, failures, traps, perhaps "idle for N ms". How does that fit SPEC-CPI section 11, and the rationale that scheduling is control plane code? What does the CPI give up, and how is policy still expressed in the language?
- **Quotas.** A fixed 200-tick quota times a slow loop rate starved `/slow`. Adaptive quotas, per-group budgets, or ticks per second as the policy?
- **Per-request metrics in the host.** The served log made the CPI do histogram arithmetic per request, which cost half the capacity. Host-side aggregation (a `metrics::` namespace, or aggregates on the served log) against events the CPI samples.
- **Data structures in CPI code.** Rebuilding process lists with `append` is quadratic. Is the answer a persistent map or vector in the language, roles used as maps, or keeping the lists small by design?

**The interpreter (independent of the spec, mostly)**

- Converting code to arrays, or to a compiled form, once at load instead of calling `listToArray` on every evaluation.
- Fewer allocations per step: mutating within a batch while keeping frames plain data where a process can park (`recv`, `join`).
- Resolving names at load: `isCoreName` and `isHostName` run on every evaluation.
- What SPEC-CPI section 7 allows, given tick counts and traces. Tick counts are already implementation-defined (DECISIONS.md).

## How to measure

- `tools/profile_gateway.sh hello|counters|slow` profiles a fresh gateway and splits the CPU between the CPI's code and process batches. `GW=variant.slight` runs a modified copy of `gateway.slight`, which is how the metrics were costed.
- `tools/bench/interpreter.slight` and `tools/bench/native.js` for the interpreter alone.
- `tools/load.ts URL clients seconds` for throughput and latency.
- Compare against the tables in `PERFORMANCE.md`, and add new numbers there.

## Out of scope for this session

- `parallel::`, worker threads and multiple images. They come next, designed against what this session learns. Keep them in mind: anything we add should still make sense when schedulers run on several threads and the CPI supervises them.
- Tapes, beyond noting where a design choice would help or hurt recording and replay.
- More Game of Life. Use the gateway.

## Outcome

An ordered list of changes we agree on. Each should have what it wins (measured or estimated), whether it is a spec change (with the proposed text to follow in `DECISIONS.md` or a SPEC file, as before), and how we will measure it. We then build them one at a time, measuring before and after each.
