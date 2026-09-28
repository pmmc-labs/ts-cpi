# Tools

Small helpers used while building the prototype.

| Tool | Use |
| --- | --- |
| `build_tutorial.py` | Builds the HTML page of `TUTORIAL.md` that is published as an artifact. `python3 tools/build_tutorial.py TUTORIAL.md out.html`. |
| `pty_run.py` | Runs a command on a real pseudo-terminal until it exits, optionally pressing keys, and saves the last frame it drew and whatever it printed after. `examples/gateway/scenarios/compare.sh` runs the gateway's monitor with it. |
| `drive_runner.py` | Drives the Life runner on a real pseudo-terminal and reports each engine's timings and key latency. `python3 tools/drive_runner.py 2 5` measures every engine at 64×32 for 5 seconds. |
