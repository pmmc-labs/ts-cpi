# Tools

Small helpers used while building the prototype.

| Tool | Use |
| --- | --- |
| `build_tutorial.py` | Builds the HTML page of `TUTORIAL.md` that is published as an artifact. `python3 tools/build_tutorial.py TUTORIAL.md out.html`. |
| `pty_run.py` | Runs a command on a real pseudo-terminal until it exits, optionally pressing keys, and saves the last frame it drew and whatever it printed after. `examples/gateway/scenarios/compare.sh` runs the gateway's monitor with it. |
| `load.ts` | A closed-loop HTTP load generator: N keep-alive clients, each sending its next request as soon as the last is answered. `node tools/load.ts http://127.0.0.1:8080/hello/x 32 10`. |
| `profile_summary.ts` | Summarizes a `node --cpu-prof` profile of the CPI by layer (interpreter, runtime, HTTP, TUI, GC, idle) and by whose behalf (a process's batch or the CPI's own code). |
| `profile_gateway.sh` | Profiles the gateway under one scenario (`hello`, `counters`, `slow`) with the two tools above. See `PERFORMANCE.md`. |
| `bench/` | Interpreter micro-benchmarks (`interpreter.slight`) and the same work in JavaScript (`native.js`). |
| `drive_runner.py` | Drives the Life runner on a real pseudo-terminal and reports each engine's timings and key latency. `python3 tools/drive_runner.py 2 5` measures every engine at 64×32 for 5 seconds. |
