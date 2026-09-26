// Prints the counter example's frame after three presses of up.
import { loadFiles } from '../../../src/loader.ts';
import { Runtime } from '../../../src/runtime.ts';
import { HeadlessTui } from '../../../src/tui/headless.ts';
import { read } from '../../../src/reader.ts';

const tui = new HeadlessTui({ input: ['(key up ())', '(key up ())', '(key up ())', '(key "q" ())'].map((s) => read(s, 'k')[0]!) });
const output: string[] = [];
await new Runtime({ out: (l) => output.push(l), clock: 'virtual', tui: () => tui }).boot(loadFiles(['examples/tui/counter.slight']));
console.log(tui.frames.at(-1));
console.log(output.join('\n'));
