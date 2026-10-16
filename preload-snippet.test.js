import assert from "node:assert/strict";
import vm from "node:vm";

const module = await import("./preload-snippet.js");
const bucket = module.bucket;
const bucketFile = module.bucketFile;
const parseTable = module.parseTable;

assert.equal(bucket(48.85, 2.35), "16_11", "Paris lands on its zoom-five tile");
assert.equal(bucket(28.2, -80.68), "8_13", "Miami lands on its zoom-five tile");
assert.equal(bucket(-33.86, 151.21), "29_19", "Sydney lands south of the equator");
assert.equal(bucket(90, 0), "16_0", "the pole clamps to the top row");
assert.equal(bucket(-90, 0), "16_31", "the south pole clamps to the bottom row");
assert.equal(bucket(NaN, 0), null, "invalid lat rejected");
assert.equal(bucket(0, 200), null, "invalid lon rejected");
assert.equal(bucketFile(48.85, 2.35), "/preload/16_11.json", "bucket file path");
assert.equal(bucketFile(NaN, 0), null, "no file for invalid coords");

const parsed = parseTable("5059;8_13:12;16_11:6,12");
assert.equal(parsed.partsPerShard, 5059, "the first chunk is the parts per shard");
assert.deepEqual(parsed.buckets.get("8_13"), [12], "parts split on commas");
assert.deepEqual(parsed.buckets.get("16_11"), [6, 12], "a later entry parses");
assert.equal(parsed.buckets.size, 2, "no extra entries");

const empty = parseTable("__PRELOAD_TABLE__");
assert.equal(empty.partsPerShard, 0, "the marker yields no parts per shard");
assert.equal(empty.buckets.size, 0, "the marker yields no buckets");

const parseMeta = module.parseMeta;
const headInjection = module.headInjection;
const runtime = module.runtime;

const meta = parseMeta(JSON.stringify({
  url: "https://tiles.example.com/basemap.pmtiles",
  total: 5000,
  tileOffset: 16,
  partSize: 100,
  ranges: [[0, 16], [900, 8]],
  links: ['<link rel="preload" as="fetch" href="/styles/index.json" crossorigin>'],
}));
assert.ok(meta, "a complete meta blob parses");
assert.deepEqual(meta.ranges, [[0, 16], [900, 8]], "the fixed ranges survive the parse");
assert.equal(parseMeta("__PRELOAD_META__"), null, "an unreplaced marker is not meta");
assert.equal(
  parseMeta('{"url":"u","total":1,"tileOffset":1,"partSize":1}'),
  null,
  "meta without ranges is rejected"
);
assert.equal(
  parseMeta('{"url":"u","total":1,"tileOffset":1,"partSize":1,"ranges":[[0,0]]}'),
  null,
  "a zero length range is rejected"
);
assert.equal(
  parseMeta('{"total":1,"tileOffset":1,"partSize":1,"ranges":[[0,8]]}'),
  null,
  "meta without an archive URL is rejected"
);

const buckets = new Map([["8_13", [12]], ["16_11", [6, 12]]]);
const injected = headInjection(28.2061, -80.685, { meta, partsPerShard: 5059, buckets });
assert.ok(
  injected.startsWith('<meta name="tiles-latlon" content="28.2061,-80.6850">'),
  "the location tag carries the request coordinates"
);
assert.ok(injected.includes(meta.links[0]), "the asset links are injected");
assert.ok(
  injected.includes(
    '<link rel="preload" as="fetch" href="https://s.tiles0.jasontally.com/s/basemap/tile/000012.bin" crossorigin>'
  ),
  "the tile part is preloaded and fetched by the script"
);
assert.ok(
  injected.includes("https://s.tiles0.jasontally.com/s/basemap/tile/000012.bin"),
  "the part URL matches the scheme the table uses"
);
assert.ok(
  injected.includes('<link rel="preconnect" href="https://s.tiles0.jasontally.com" crossorigin>'),
  "the part host is connected before its parts are asked for"
);
assert.ok(
  injected.indexOf('rel="preconnect"') < injected.indexOf('rel="preload"'),
  "the preconnect comes before every preload"
);
const twoHosts = headInjection(28.2061, -80.685, { meta, partsPerShard: 5059, buckets: new Map([["8_13", [12, 5071]]]) });
assert.equal(
  twoHosts.match(/rel="preconnect"/g).length,
  2,
  "one connection per host, however many parts come from it"
);
assert.ok(injected.includes("<script>("), "the preload script is injected");
assert.ok(
  !headInjection(NaN, 0, { meta, partsPerShard: 5059, buckets }).includes("tiles-latlon"),
  "no coordinates means no location tag"
);
assert.ok(
  !headInjection(28.2061, -80.685, { meta: null, partsPerShard: 5059, buckets }).includes("<script>"),
  "no meta means no script"
);

// The runtime is the page half of the preload: it has to answer the reader's
// range reads from the bytes it fetched, and leave every other read alone.
const config = {
  url: "https://tiles.example.com/basemap.pmtiles",
  total: 5000,
  tileOffset: 16,
  partSize: 100,
  ranges: [[0, 16], [900, 8]],
  parts: [[2, "https://s.tiles0.example.com/s/basemap/tile/000002.bin"]],
};
const sequence = (length, from) => new Uint8Array(length).map((_, i) => (from + i) % 251);
const served = [];
const page = {
  fetch: (url, init) => {
    served.push(url);
    const range = init && init.headers && init.headers.Range;
    if (range) {
      const [start, end] = range.replace("bytes=", "").split("-").map(Number);
      return Promise.resolve(new Response(sequence(end - start + 1, start), { status: 206 }));
    }
    return Promise.resolve(new Response(sequence(config.partSize, 200), { status: 200 }));
  },
};
vm.runInContext(`(${runtime})(${JSON.stringify(config)})`, vm.createContext({ window: page, Headers, Response }));
assert.deepEqual(
  served,
  [config.url, config.url, config.parts[0][1]],
  "the fixed ranges and the part are fetched once"
);

const covered = await page.fetch(config.url, { headers: { Range: "bytes=4-9" } });
assert.equal(covered.status, 206, "a covered range is answered from memory");
assert.equal(covered.headers.get("Content-Range"), "bytes 4-9/5000", "the content range names the archive");
assert.deepEqual(
  [...new Uint8Array(await covered.arrayBuffer())],
  [4, 5, 6, 7, 8, 9],
  "the bytes are the slice the page asked for"
);

const tile = await page.fetch(config.url, { headers: { range: "bytes=216-219" } });
assert.deepEqual(
  [...new Uint8Array(await tile.arrayBuffer())],
  [200, 201, 202, 203],
  "a tile read inside a preloaded part is answered from the part bytes"
);
assert.equal(served.length, 3, "a covered read spends no request");

const missed = await page.fetch(config.url, { headers: { Range: "bytes=2000-2003" } });
assert.equal(missed.status, 206, "an uncovered range falls through to the network");
assert.equal(served.length, 4, "the fallback spends one request");

await page.fetch("https://tiles.example.com/styles/index.json");
assert.equal(served.length, 5, "a fetch outside the archive passes through untouched");

const attempts = [];
const broken = {
  fetch: (url) => {
    attempts.push(url);
    return Promise.reject(new Error("offline"));
  },
};
vm.runInContext(`(${runtime})(${JSON.stringify(config)})`, vm.createContext({ window: broken, Headers, Response }));
await assert.rejects(
  () => broken.fetch(config.url, { headers: { Range: "bytes=0-3" } }),
  "a failed preload leaves the read to the network, which also fails"
);
assert.equal(attempts.length, 4, "the read retried on the network after the preload failed");

console.log("preload snippet smoke tests passed");
