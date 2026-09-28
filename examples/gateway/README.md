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
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ gateway :8080 · up 0:03 · hello max  5 ·  4 fps                                              │
│ requests       9 · 2xx       9 · 4xx     0 · 503     0 · 504     0 · 5xx     0 · gone     0  │
│ loop     6/s · run   0% · other   0% · draw   0% · wait 100% · frame   0 ms,   0 building    │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
 endpoint  workers                queue  req/s  wait p95  work p95    ticks/s req/s, 20 s           p95, 20 s
 hello     ○◌◌ 1/5                    0      1      <1ms      <1ms        307                   █▁                    ▁▁
 counter   ● 0  ○ 0  ◌ 2              0      0         -         -          0                   █                     ▁
 slow      ○                          0      0         -         -          0
 router    ○                          0      0         -         -        120
 system    the CPI                    0      0         -         -          0
 other                                0      0         -         -          0
 total     ● 0  ○ 4  ◌ 4              0      1      <1ms      <1ms        427                   █▁                    ▁▁

 since start  requests               queue               req/s             wait ms             work ms
                          min    avg   max    min    avg   max    min    avg   max    min    avg   max
 hello               7      0    0.1     2      0    2.3     6      0    0.0     0      0    0.0     0
 counter             2      0    0.0     1      0    0.6     2      0    0.0     0      0    0.0     0
 slow                0      0    0.0     0      0    0.0     0      -      -     -      -      -     -
 router              0      0    0.4     6      0    0.0     0      -      -     -      -      -     -
 system              0      0    0.0     0      0    0.0     0      -      -     -      -      -     -
 other               0      0    0.0     0      0    0.0     0      -      -     -      -      -     -
 total               9      0    0.6     6      0    3.0     8      0    0.0     0      0    0.0     0
```

(From `tests/gateway.test.ts`, on the virtual clock, where no time passes
while the CPI works.)

- **Header.** Status counts (2xx green, 4xx yellow, 5xx red, zero dimmed), and the last second of the CPI's loop: how often it went round, and its time split into running processes (`run`), its own work (`other`: the served log, scaling, parking), drawing, and waiting in `host::wait`, in numbers and as a stacked bar. A frame's cost is split into building the view in CPI code and the host painting it.
- **The last second, one row per endpoint.** Workers (● ready, ○ waiting in `recv`, ◌ parked; the hello pool shows a mark per worker and its maximum, the rest show counts), the queue in its mailbox, requests, the 95th percentile of **wait** (arrival to delivery: time spent waiting for the CPI's loop) and of **work** (delivery to answer: the processes' time, queueing included), coloured green under 5 ms, yellow under 50 ms and red above, and the ticks its processes used. The sparklines are the last 20 seconds of requests and of 95th percentile total time, underlined so an empty stretch still shows. They and the stacked bar are chart components (SPEC-TUI section 3.2): the CPI passes numbers and the host draws them. `total` is the whole gateway.
- **Since the start.** Min, average and max of each endpoint's queue (sampled every time round the loop), requests per second (every second), and wait and work (every request, in ms).
- **Where the numbers come from.** Request times come from the host's served log (`http::subscribe-log`), and ticks from `process::ticks`. Percentiles come from fixed-bin histograms (`<1ms`, `<2ms`, `<5ms` ...), so they cost the CPI no sorting.
- **Events are not shown.** The monitor sends each of the CPI's events to a mailbox whose only receiver has ended, so they collect in the host's dead-letter queue. `plain.slight` prints them.
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

**Charts drawn by the host save a fifth of the building** (SPEC-TUI
section 15.4). Moving the sparklines from text built in CPI code to the
`Sparkline` component cut building from 15.7 to 12.9 ms a frame at 4 fps,
and from 6.6 to 5.4 ms at 30 fps; painting rose by about 1 ms for the extra
components. The rest of the building is the tables.

**The monitor costs 13 to 23 ms a frame,** 40 to 55% of it building the view
in CPI code and the rest painting. That's about 9% of the loop at 4 fps and
28% at 30 fps. At these loads the CPI had enough slack that clients barely
noticed.
