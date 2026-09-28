// The same work in plain JavaScript, for scale.
function time(label, ops, unit, f) {
    const t0 = performance.now();
    f();
    const ms = Math.max(0.01, performance.now() - t0);
    console.log(`${label} | ${ms.toFixed(1)} ms | ${Math.round(ops * 1000 / ms)} ${unit}/s`);
}
let sink;
function countDown(n) { while (n !== 0) n--; return true; }
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
class Pair { constructor(car, cdr) { this.car = car; this.cdr = cdr; } }
function build(n) { let acc = null; while (n) acc = new Pair(n--, acc); return acc; }
function map1(f, xs) { return xs === null ? null : new Pair(f(xs.car), map1(f, xs.cdr)); }
for (let i = 0; i < 3; i++) {
    time('loop        ', 2000000, 'iteration', () => { sink = countDown(2000000); });
    time('fib 22      ', 28657, 'call', () => { sink = fib(22); });
    const xs = build(1000);
    time('map 1000x200', 200000, 'element', () => { for (let t = 0; t < 200; t++) sink = map1((x) => x + 1, xs); });
    time('closures    ', 200000, 'closure', () => { let acc = 0; for (let n = 200000; n > 0; n--) acc = ((x) => x + n)(acc); sink = acc; });
    time('strings     ', 200000, 'append', () => { let s; for (let n = 0; n < 200000; n++) s = 'ab' + 'cd' + n; sink = s; });
    time('vectors     ', 200000, 'vector-set', () => { let v = new Array(16).fill(0); for (let n = 200000; n > 0; n--) { v = v.slice(); v[n % 16] = n; } sink = v; });
}
