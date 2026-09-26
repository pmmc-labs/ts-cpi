// How much of the runner's draw time is Ink? Renders a view shaped like the
// runner's run screen (a bordered board of half-block lines plus a stats
// column) with renderToString, for two board sizes.
import { renderToString } from 'ink';
import { read } from '../../../src/reader.ts';
import { toElement } from '../../../src/tui/views.ts';

for (const [w, h] of [[64, 32], [128, 64]] as const) {
    const lines = Array.from({ length: h / 2 }, (_, i) =>
        `(Text (@ (color yellow)) "${Array.from({ length: w }, (_, j) => ((i * 7 + j * 3) % 5 === 0 ? '█' : (i + j) % 3 === 0 ? '▀' : ' ')).join('')}")`);
    const stats = Array.from({ length: 10 }, (_, i) => `(Box (Box (@ (width 16)) (Text "label ${i}")) (Text "12345"))`);
    const src = `(Box (@ (flexDirection column)) (Text "title") (Box (@ (flexWrap wrap) (columnGap 2))
        (Box (@ (borderStyle round) (flexShrink 0)) (Box (@ (flexDirection column)) ${lines.join(' ')}))
        (Box (@ (flexDirection column) (width 40)) ${stats.join(' ')})) (Text "keys"))`;
    const view = read(src, 'view')[0]!;
    const t0 = performance.now();
    const runs = 20;
    for (let i = 0; i < runs; i++) renderToString(toElement(view), { columns: 200 });
    console.log(`${w}x${h}: convert + Ink layout and render ${((performance.now() - t0) / runs).toFixed(1)} ms per frame`);
}
