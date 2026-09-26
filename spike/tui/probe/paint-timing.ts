// Probe: when does Ink write frames to the terminal? A fake TTY stream counts
// writes; we rerender five times without yielding, then yield.
import { Writable } from 'node:stream';
import React from 'react';
import { render, Text } from 'ink';

const writes: string[] = [];
const stdout = new Writable({ write(chunk, _enc, done) { writes.push(String(chunk)); done(); } }) as unknown as NodeJS.WriteStream;
Object.assign(stdout, { isTTY: true, columns: 40, rows: 10 });

const frame = (n: number) => React.createElement(Text, null, `frame ${n}`);
const painted = () => writes.filter((w) => w.includes('frame')).map((w) => w.match(/frame \d+/)![0]);

const app = render(frame(0), { stdout, interactive: true, patchConsole: false, exitOnCtrlC: false });
console.log('after render, synchronously:        ', painted());
for (let i = 1; i <= 5; i++) app.rerender(frame(i));
console.log('after 5 rerenders, synchronously:   ', painted());
await new Promise((r) => setTimeout(r, 0));
console.log('after yielding once (setTimeout 0): ', painted());
await new Promise((r) => setTimeout(r, 50));
console.log('after yielding 50 ms:               ', painted());
app.unmount();

// Does waitUntilRenderFlush force the pending frame out, and how long does it take?
writes.length = 0;
const app2 = render(frame(10), { stdout, interactive: true, patchConsole: false, exitOnCtrlC: false });
for (let i = 11; i <= 15; i++) app2.rerender(frame(i));
const t0 = performance.now();
await app2.waitUntilRenderFlush();
console.log(`waitUntilRenderFlush took ${(performance.now() - t0).toFixed(1)} ms, painted:`, painted());
app2.unmount();
