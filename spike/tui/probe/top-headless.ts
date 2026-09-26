// Runs examples/tui/top.slight headless with scripted keys, printing the
// frames it draws. Used while writing the example and its test.
import { loadFiles } from '../../../src/loader.ts';
import { Runtime } from '../../../src/runtime.ts';
import { HeadlessTui } from '../../../src/tui/headless.ts';
import { read } from '../../../src/reader.ts';
import { print } from '../../../src/printer.ts';

const keys = process.argv.slice(2).map((k) => read(k, 'key')[0]!);
const tui = new HeadlessTui({ columns: 80, rows: 30, input: keys });
const output: string[] = [];
const rt = new Runtime({ out: (l) => output.push(l), clock: 'virtual', tui: () => tui });
const result = await rt.boot(loadFiles(['examples/life/lib/lists.slight', 'examples/tui/top.slight']));
console.log(result.ok ? 'ok' : `failed: ${print(result.e)}`);
console.log(`${tui.frames.length} frames; last:`);
console.log(tui.frames.at(-1));
console.log(output.join('\n'));
