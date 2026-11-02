// usage: node bench.mjs <workerdPid> <n> <conc> <mode>   mode: tile | leaf | head | tile2
import http from "node:http";
import fs from "node:fs";
const [pid, n, conc, mode] = [process.argv[2], +process.argv[3], +process.argv[4], process.argv[5] || "tile"];
const agent = new http.Agent({ keepAlive: true, maxSockets: conc });
// run.sh reads LEAF_OFFSET out of the snippet's ARCHIVES table.
const tileOffset = 16384, leafOffset = Number(process.env.LEAF_OFFSET);
const word = (i) => (Math.imul(i, 2654435761) >>> 0);
const expect = (p, k, size) => { const i = (p % size); const w = word(i - (i % 4)); return (w >>> (8 * (i % 4))) & 255; };
const rnd = (k) => Math.floor(Math.random() * k);
function range() {
  if (mode === "tile") { const s = tileOffset + rnd(5552) * 1e6 + rnd(1e6 - 300); return [s, s + 199 + rnd(500)]; }
  if (mode === "tileend") { const s = tileOffset + rnd(5552) * 1e6 + 999000 - rnd(500); return [s, s + 199]; }
  if (mode === "tilestart") { const s = tileOffset + rnd(5552) * 1e6 + rnd(500); return [s, s + 199]; }
  if (mode === "tile2") { const s = tileOffset + (rnd(5000) + 1) * 1e6 - 100; return [s, s + 299]; } // straddles a part boundary: 2 reads
  if (mode === "leaf") { const s = leafOffset + rnd(800) * 160000 + rnd(100000); return [s, s + 49999]; }
  return [0, 16383];
}
const ticks = () => { let u = 0, k = 0; for (const d of fs.readdirSync(`/proc/${pid}/task`)) { const f = fs.readFileSync(`/proc/${pid}/task/${d}/stat`, "utf8"); const a = f.slice(f.lastIndexOf(")") + 2).split(" "); u += +a[11]; k += +a[12]; } return [u, k]; };
const cpuNs = () => { let t = 0; for (const d of fs.readdirSync(`/proc/${pid}/task`)) t += +fs.readFileSync(`/proc/${pid}/task/${d}/schedstat`, "utf8").split(" ")[0]; return t; };
function one() {
  const [a, b] = range();
  return new Promise((res, rej) => {
    const t0 = performance.now();
    http.get({ host: "127.0.0.1", port: 8787, path: "/basemap.pmtiles", agent, headers: { range: `bytes=${a}-${b}` } }, (r) => {
      let len = 0, wrong = 0; const base = mode.startsWith("tile") ? tileOffset : mode === "leaf" ? leafOffset : 0; const size = mode === "leaf" ? 160000 : mode === "head" ? 16384 : 1e6;
      r.on("data", (c) => { for (let q = 0; q < c.length; q += 37) if (c[q] !== expect(a - base + len + q, 0, size)) wrong++; len += c.length; }); r.on("end", () => res({ ms: performance.now() - t0, status: r.statusCode, len, want: b - a + 1, wrong }));
    }).on("error", rej);
  });
}
async function run(count) {
  const lat = []; let bad = 0, left = count;
  await Promise.all(Array.from({ length: conc }, async () => { while (left-- > 0) { const r = await one(); lat.push(r.ms); if (r.status !== 206 || r.len !== r.want || r.wrong) { bad++; if (bad < 4) console.error("BAD", r.status, r.len, r.want, r.wrong); } } }));
  return { lat, bad };
}
await run(Math.min(500, n));
const t0s = ticks(), c0 = cpuNs(), w0 = performance.now();
const { lat, bad } = await run(n);
const t1s = ticks(), c1 = cpuNs(), w1 = performance.now();
lat.sort((x, y) => x - y); const q = (p) => lat[Math.floor(p * (lat.length - 1))].toFixed(2);
console.log(JSON.stringify({ mode, n, conc, bad, cpu_us_per_req: +((c1 - c0) / 1000 / n).toFixed(1), user_us: +((t1s[0]-t0s[0])*1e4/n).toFixed(0), sys_us: +((t1s[1]-t0s[1])*1e4/n).toFixed(0), wall_ms_per_req: +((w1 - w0) / n).toFixed(3), p50: q(0.5), p99: q(0.99), max: q(1) }));
