// usage: node prof.mjs <inspectorPort> <seconds>  -> writes $TMPDIR/prof.cpuprofile and prints self-time by function
import fs from "node:fs";
const [port, secs] = [process.argv[2], +process.argv[3]];
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
console.log((await send("Profiler.enable")).error ?? "enabled");
await send("Profiler.setSamplingInterval", { interval: 50 });
console.log((await send("Profiler.start")).error ?? "started");
await new Promise((r) => setTimeout(r, secs * 1000));
const res = await send("Profiler.stop");
if (res.error) { console.log(res.error); process.exit(1); }
const prof = res.result.profile; fs.writeFileSync(`${process.env.TMPDIR || "/tmp"}/prof.cpuprofile`, JSON.stringify(prof));
const self = new Map(); const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const dt = prof.timeDeltas; let total = 0;
prof.samples.forEach((sid, i) => { const n = byId.get(sid); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + dt[i]); total += dt[i]; });
[...self].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log((v / total * 100).toFixed(1).padStart(5) + "%", k));
console.log("total sampled ms", (total / 1000).toFixed(0));
process.exit(0);
