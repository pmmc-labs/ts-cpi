// Drives examples/runner/runner.slight headless with scripted input and
// prints the last frames. Each argument is an event; "N*event" repeats it.
//   node spike/tui/probe/runner-headless.ts '(key up ())' '5*(resize 0 0)' ...
import { readdirSync } from 'node:fs';
import { loadFiles } from '../../../src/loader.ts';
import { Runtime } from '../../../src/runtime.ts';
import { HeadlessTui } from '../../../src/tui/headless.ts';
import { read } from '../../../src/reader.ts';
import { print } from '../../../src/printer.ts';

const events = process.argv.slice(2).flatMap((arg) => {
    const m = arg.match(/^(\d+)\*(.*)$/);
    return m ? Array(Number(m[1])).fill(m[2]) : [arg];
}).map((e) => read(e, 'event')[0]!);
const engines = readdirSync('examples/runner/engines').filter((f) => f.endsWith('.slight')).map((f) => `examples/runner/engines/${f}`);
const tui = new HeadlessTui({ columns: 120, rows: 40, input: events });
const output: string[] = [];
const rt = new Runtime({ out: (l) => output.push(l), clock: 'virtual', tui: () => tui });
const result = await rt.boot(loadFiles(['examples/life/lib/lists.slight', 'examples/runner/lib/board.slight', ...engines,
    'examples/runner/engines.slight', 'examples/runner/runner.slight']));
console.log(result.ok ? 'ok' : `failed: ${print(result.e)}`);
const show = Number(process.env.SHOW ?? 2);
for (const f of tui.frames.slice(-show)) console.log(f + '\n----');
console.log(`${tui.frames.length} frames`);
