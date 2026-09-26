# Tools

Small helpers used while building the prototype.

| Tool | Use |
| --- | --- |
| `reindent.ts` | Re-indents to the project's 4-space style: TypeScript (template strings left alone, CPI source inside them re-indented), `.slight` (4 spaces per open parenthesis), Lisp blocks in Markdown, JSON. `node tools/reindent.ts <files>`. |
| `build_tutorial.py` | Builds the HTML page of `TUTORIAL.md` that is published as an artifact. `python3 tools/build_tutorial.py TUTORIAL.md out.html`. |
| `drive_runner.py` | Drives the Life runner on a real pseudo-terminal and reports each engine's timings and key latency. `python3 tools/drive_runner.py 2 5` measures every engine at 64×32 for 5 seconds. |
