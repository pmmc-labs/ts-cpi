// Spike: CPI code builds views, and Ink animates them in the terminal.
//   node spike/tui/live.ts
// The CPI computes every frame of the Life reference run as a view value;
// this script renders the first and then calls Ink's rerender for each
// next one. React works out what changed on screen.

import { render } from 'ink';
import { loadFiles } from '../../src/loader.ts';
import { read } from '../../src/reader.ts';
import { expand } from '../../src/expander.ts';
import { startExpr, run } from '../../src/machine.ts';
import { listToArray } from '../../src/values.ts';
import type { State, Value } from '../../src/types.ts';
import { print } from '../../src/printer.ts';
import { traceEntries } from '../../src/core.ts';
import { toElement } from '../../src/tui/views.ts';

function evaluate(source: string, files: string[]): Value {
    const [x] = expand(read(source, 'live'), 'expr');
    let s: State = startExpr(x!, loadFiles(files));
    while (s.mode.m !== 'done' && s.mode.m !== 'failed' && s.mode.m !== 'host') s = run(s, 1_000_000);
    if (s.mode.m === 'failed') throw new Error(`evaluation failed: ${print(s.mode.e)} ${print(traceEntries(s.mode.e))}`);
    if (s.mode.m !== 'done') throw new Error(`evaluation stopped in ${s.mode.m}`);
    return s.mode.v;
}

const views = listToArray(evaluate('(lv-views)', [
    'examples/life/lib/lists.slight',
    'examples/life/lib/life.slight',
    'spike/tui/life-view.slight',
]))!;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const app = render(toElement(views[0]!));
for (const view of views.slice(1)) {
    await sleep(400);
    app.rerender(toElement(view));
}
await sleep(400);
app.unmount();
