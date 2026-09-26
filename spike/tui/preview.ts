// Renders views written in slight syntax to text, with no terminal session.
//   node spike/tui/preview.ts view.sxml [columns]
// Each top-level form in the file is one view.

import { readFileSync } from 'node:fs';
import { renderToString } from 'ink';
import { read } from '../../src/reader.ts';
import { toElement } from '../../src/tui/views.ts';

const [file, columns] = process.argv.slice(2);
if (file === undefined) {
    console.error('usage: node spike/tui/preview.ts view.sxml [columns]');
    process.exit(2);
}
for (const view of read(readFileSync(file, 'utf8'), file)) {
    console.log(renderToString(toElement(view), { columns: Number(columns ?? 60) }));
}
