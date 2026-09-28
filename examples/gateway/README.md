# The gateway

An HTTP gateway written as control plane code (`SPEC-HTTP.md`). A router
actor forwards each request to the endpoint its first path segment names:

| Path | Endpoint |
| --- | --- |
| `/hello/<name>` | A pool of workers on one shared queue, unparked from a pre-warmed template, grown while requests wait and parked into cold storage when idle. |
| `/counter/<name>` | One counter per name, made the first time the name is used, parked when idle and woken when a request waits in its durable mailbox. |
| `/counter` | The names counted so far. |
| `/slow` | About half a second of ticks per request, on one worker. |
| `/system/stats`, `/system/metrics`, `/system/quit` | Answered by the CPI itself. |

## Files

| File | What it is |
| --- | --- |
| `gateway.slight` | The library: the processes' roles, the CPI's supervisor loop, and the metrics. It has no `main`. |
| `plain.slight` | Runs the gateway, printing each thing the CPI does. |
| `monitor.slight` | Runs it under a live terminal monitor. |
| `scenarios/` | curl scripts that play load against a running gateway, and `compare.sh`. |

```sh
node bin/cpi.ts examples/gateway/gateway.slight examples/gateway/plain.slight
node bin/cpi.ts examples/gateway/gateway.slight examples/gateway/monitor.slight   # q quits
```

`tests/gateway.test.ts` drives both with scripted requests on the virtual
clock.

## The monitor

```
╭────────────────────────────────────────────────────────────────────────────────────╮
│ gateway :8080 · up 0:05 · hello max 4 · 4 fps                                      │
│ requests 95 · 2xx 95 · 4xx 0 · 503 0 · 504 0 · 5xx 0 · gone 0                      │
│ loop 89/s · run 1% · other 4% · draw 7% · wait 86% · frame 18 ms, 8 building       │
╰────────────────────────────────────────────────────────────────────────────────────╯
 endpoint  workers               queue  req/s  wait p95  work p95  ticks/s  req/s, 20 s          p95, 20 s
 hello     ○ 1/4                 0      0      -         -         0
 counter   ○s0 ○s1 ○s2 ○s3 ○s4 … 0      30     <1ms      <50ms     18180                   █   ▄                ▅   ▄
 ...
```

- **Header.** Status counts, and the last second of the CPI's loop: how often it went round, and its time split into running processes (`run`), its own work (`other`: the served log, scaling, parking), drawing, and waiting in `host::wait`. A frame's cost is split into building the view in CPI code and the host painting it.
- **One row per endpoint.** Workers (● ready, ○ waiting in `recv`, ◌ parked), the queue in its mailbox, and the last full second: requests, 95th percentile of **wait** (arrival to delivery: time spent waiting for the CPI's loop) and of **work** (delivery to answer: the processes' time, queueing included), and ticks its processes used. The sparklines are the last 20 seconds of requests and of 95th percentile total time.
- **Where the numbers come from.** Request times come from the host's served log (`http::subscribe-log`), and ticks from `process::ticks`. Percentiles come from fixed-bin histograms (`<1ms`, `<2ms`, `<5ms` ...), so they cost the CPI no sorting.
- **Keys.** `q` quits, `+` and `-` change the most hello workers, `f` cycles the frame rate through 1, 2, 4, 10 and 30.

The monitor is one more step in the CPI's loop, and nothing else runs while
it draws. It draws on a timer, and its header shows what drawing costs.

## Scenarios

Each script plays load against a gateway already running on port 8080, then
prints what the clients saw (status counts, latency percentiles from curl)
beside the gateway's `/system/metrics`.

| Script | Load |
| --- | --- |
| `trickle.sh` | 10 hello requests a second for 15 s |
| `burst.sh` | 300 at once, then 5 quiet seconds |
| `ramp.sh` | 5 to 160 a second and back, 3 s a step |
| `fanout.sh` | 100 new counter names, twice each |
| `sleepers.sh` | 30 counters visited, visited again, left to sleep, and woken |
| `overload.sh` | 2000 requests, 250 at a time |
| `slow.sh` | hello at 20 a second beside 6 slow requests |
| `all.sh` | every scenario in turn, against one gateway |
| `compare.sh [scenario]` | starts the gateway three ways (plain, monitor at 4 fps, monitor at 30 fps) and runs the scenario against each |

`compare.sh` runs the monitor on a pseudo-terminal with `tools/pty_run.py`
and saves its last screen. `all.sh` runs everything against one gateway, so
state carries over: counters made by `fanout` are still there for `sleepers`.

## What the first measurements showed (Sep 28, 2026)

On a laptop, with the interpreter running about 17 million ticks a second in
200-tick turns.

**The processes are cheap.** A hello request costs about 307 ticks in its
worker and 120 in the router: about 25 µs.

**At 160 requests a second the CPI is 96% idle** (`ramp`, plain). The
server's p95 from arrival to answer is under 20 ms, most of it a burst
queueing in the pool. Clients saw a p50 of 41 ms: the rest is spent before
the host has the request, in curl and the connection, outside the CPI.

**The CPI's own work is the pressure, and it grows with the number of
processes.** Once `fanout` and `sleepers` had made 230 counters, `other`
took 80 to 90% of the loop, and requests to awake counters timed out
(`504`). Waking parked counters was faster than using awake ones, because
parked ones leave the process list. The causes are in the supervisor loop:

- **Readiness is polled.** It asks `process::state` about every process every time round, because nothing tells it which processes a message has woken. That's one host request per process per round.
- **Lists are rebuilt.** Keeping a process appends it to a new list, so rebuilding the process list each round is quadratic. Parking and waking walk the lists the same way.
- **The quota is fixed.** Each ready process gets 200 ticks per round, so a process's throughput is capped at 200 times the loop rate. `slow` got about 135,000 ticks a second of a possible 17 million, and every slow request timed out. Hello stayed fast beside it: preemption worked, but the slow worker starved.

**Backpressure works.** `overload` got 1672 immediate `503`s from the host
and 328 answers, with a p50 of 5.5 ms.

**The monitor costs 13 to 23 ms a frame,** 40 to 55% of it building the view
in CPI code and the rest painting. That's about 9% of the loop at 4 fps and
28% at 30 fps. At these loads the CPI had enough slack that clients barely
noticed.
