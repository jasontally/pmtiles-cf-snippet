// Mock shard origin: serves a fixed-size body for any GET, in CHUNK-byte writes.
// usage: node origin.mjs PORT SIZE CHUNK [failEvery]
import http from "node:http";
const [port, size, chunk, failEvery] = process.argv.slice(2).map(Number);
const body = Buffer.alloc(size);
for (let i = 0; i < size; i += 4) body.writeUInt32LE((i * 2654435761) >>> 0, i);
let n = 0;
http.createServer((req, res) => {
  n++;
  if (failEvery && n % failEvery === 0) { res.writeHead(503); res.end("boom"); return; }
  res.writeHead(200, { "content-length": size, "content-type": "application/octet-stream" });
  let off = 0;
  const pump = () => {
    while (off < size) {
      const end = Math.min(off + chunk, size);
      const ok = res.write(body.subarray(off, end));
      off = end;
      if (!ok) { res.once("drain", pump); return; }
    }
    res.end();
  };
  pump();
}).listen(port, "127.0.0.1");
