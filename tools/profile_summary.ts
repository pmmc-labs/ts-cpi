// Summarizes a V8 CPU profile (node --cpu-prof) of the CPI: where the time
// went by layer, on whose behalf (a process's batch or the CPI's own code),
// and the functions that used the most.
//
//   node tools/profile_summary.ts PROFILE.cpuprofile [top]

import fs from 'node:fs';
import path from 'node:path';

type Node = {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
};
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] };

const [file, topArg = '25'] = process.argv.slice(2);
if (file === undefined) throw new Error('usage: node tools/profile_summary.ts PROFILE.cpuprofile [top]');
const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

// The layer a function belongs to, from its file.
function layer(n: Node): string {
    const { url, functionName } = n.callFrame;
    if (functionName === '(garbage collector)') return 'gc';
    if (functionName === '(idle)') return 'idle';
    if (functionName === '(program)' || functionName === '(root)') return 'program';
    const f = url.replace(/^file:\/\//, '');
    if (/\/src\/(machine|core|env|values|role|names)\.ts$/.test(f)) return 'interpreter';
    if (/\/src\/(runtime|builtins)\.ts$/.test(f)) return 'runtime';
    if (/\/src\/http\//.test(f) || /^node:(_http|http|net|stream|internal\/(http|streams|net|stream_base))/.test(url)) return 'http';
    if (/\/src\/tui\//.test(f) || /node_modules\/(ink|react|react-reconciler|yoga|@pppp606|string-width|chalk|wrap-ansi|slice-ansi|cli-truncate|ansi|widest-line)/.test(f)) return 'tui';
    if (/\/src\/(printer|reader|expander|loader)\.ts$/.test(f)) return 'other src';
    if (url.startsWith('node:')) return 'node';
    return 'other';
}

// Whose behalf: the nearest ancestor that is a process batch or the CPI loop.
const behalfCache = new Map<number, string>();
function behalf(id: number): string {
    const cached = behalfCache.get(id);
    if (cached !== undefined) return cached;
    const n = byId.get(id)!;
    const fn = n.callFrame.functionName;
    let who: string;
    if (fn === 'runBatch') who = 'process batches';
    else if (fn === 'runCpi') who = 'the CPI';
    else {
        const p = parent.get(id);
        who = p === undefined ? 'outside the CPI' : behalf(p);
    }
    behalfCache.set(id, who);
    return who;
}

const self = new Map<number, number>();
let total = 0;
profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    self.set(id, (self.get(id) ?? 0) + dt);
    total += dt;
});

function table(title: string, key: (n: Node, id: number) => string, top = 100): void {
    const sums = new Map<string, number>();
    for (const [id, us] of self) {
        const k = key(byId.get(id)!, id);
        sums.set(k, (sums.get(k) ?? 0) + us);
    }
    console.log(`\n${title}`);
    for (const [k, us] of [...sums].sort((a, b) => b[1] - a[1]).slice(0, top)) {
        console.log(`  ${(us / 1000).toFixed(0).padStart(7)} ms  ${((us * 100) / total).toFixed(1).padStart(5)}%  ${k}`);
    }
}

console.log(`${(total / 1e6).toFixed(1)} s sampled`);
table('By layer', (n) => layer(n));
const busy = (n: Node) => !['idle', 'program'].includes(layer(n));
table('On whose behalf (busy time only)', (n, id) => (busy(n) ? behalf(id) : '(idle)'));
table('Layer on behalf of', (n, id) => (busy(n) ? `${behalf(id).padEnd(16)} ${layer(n)}` : '(idle)'));
table(`Top ${topArg} functions (self time)`, (n) => {
    const f = n.callFrame;
    return `${f.functionName || '(anonymous)'}  ${path.basename(f.url)}:${f.lineNumber + 1}`;
}, Number(topArg));
