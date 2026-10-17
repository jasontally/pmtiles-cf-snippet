import assert from "node:assert/strict";
import vm from "node:vm";

const module = await import("./preload-snippet.js");
const bucket = module.bucket;
const parseTable = module.parseTable;

assert.equal(bucket(48.85, 2.35), "16_11", "Paris lands on its zoom-five tile");
assert.equal(bucket(28.2, -80.68), "8_13", "Miami lands on its zoom-five tile");
assert.equal(bucket(-33.86, 151.21), "29_19", "Sydney lands south of the equator");
assert.equal(bucket(90, 0), "16_0", "the pole clamps to the top row");
assert.equal(bucket(-90, 0), "16_31", "the south pole clamps to the bottom row");
assert.equal(bucket(NaN, 0), null, "invalid lat rejected");
assert.equal(bucket(0, 200), null, "invalid lon rejected");

// The table is a format number, then one range per zoom-five tile in grid order.
const parsed = parseTable("1;2.10;0;14.8");
assert.equal(parsed.length, 3, "one entry per chunk after the format number");
assert.deepEqual(parsed[0], [2, 36], "offset then length, both base 36");
assert.equal(parsed[1], null, "a bare 0 is a tile with no data");
assert.deepEqual(parsed[2], [40, 8], "a later entry parses");

assert.deepEqual(parseTable("1"), [], "a table with no entries has no tiles");
assert.deepEqual(parseTable("__PRELOAD_TABLE__"), [], "an unreplaced marker yields no tiles");
assert.deepEqual(parseTable("5059;8_13:12"), [], "a table from the older format yields no tiles");
assert.deepEqual(parseTable("2;2.10"), [], "a table from a newer format yields no tiles");

const parseMeta = module.parseMeta;
const headInjection = module.headInjection;
const runtime = module.runtime;

const meta = parseMeta(JSON.stringify({
  url: "https://tiles.example.com/basemap.pmtiles",
  total: 5000,
  ranges: [[0, 16], [900, 8]],
  links: ['<link rel="preload" as="fetch" href="/styles/index.json" crossorigin>'],
  sprite: "https://tiles.example.com/sprites/v4/light",
}));
assert.ok(meta, "a complete meta blob parses");
assert.deepEqual(meta.ranges, [[0, 16], [900, 8]], "the fixed ranges survive the parse");
assert.equal(meta.sprite, "https://tiles.example.com/sprites/v4/light", "the sprite survives the parse");
assert.equal(
  parseMeta('{"url":"u","total":1,"ranges":[[0,8]]}').sprite,
  "",
  "meta without a sprite yields no sprite rather than a bad URL"
);
assert.equal(parseMeta("__PRELOAD_META__"), null, "an unreplaced marker is not meta");
assert.equal(
  parseMeta('{"url":"u","total":1}'),
  null,
  "meta without ranges is rejected"
);
assert.equal(
  parseMeta('{"url":"u","total":1,"ranges":[[0,0]]}'),
  null,
  "a zero length range is rejected"
);
assert.equal(
  parseMeta('{"total":1,"ranges":[[0,8]]}'),
  null,
  "meta without an archive URL is rejected"
);
assert.equal(parseMeta('{"url":"u","ranges":[[0,8]]}'), null, "meta without an archive size is rejected");

// A table that gives every zoom-five tile the same range, so a viewer's ring is
// easy to read back from the injected head.
const tiles = new Array(1024).fill([100, 20]);
const injected = headInjection(28.2061, -80.685, { meta, tiles });
assert.ok(
  injected.startsWith('<meta name="tiles-latlon" content="28.2061,-80.6850">'),
  "the location tag carries the request coordinates"
);
assert.ok(injected.includes(meta.links[0]), "the asset links are injected");
assert.ok(injected.includes(`"sprite":"${meta.sprite}"`), "the sprite reaches the script");
assert.ok(
  injected.includes('<script type="module">('),
  "the preload script is injected as a module, so it defers instead of blocking the first paint"
);
assert.ok(
  !injected.includes(`<link rel="preload" as="fetch" href="${meta.url}"`),
  "the archive is not link-preloaded: a link cannot carry a byte range, so the script fetches the ranges"
);
assert.ok(!injected.includes("preconnect"), "no shard host needs connecting: the ranges come from this host");
assert.ok(
  !/s\.tiles\d+\.jasontally/.test(injected),
  "the injected head names no shard host"
);

const groupOf = (html) => {
  const at = html.indexOf('"tiles":"') + 9;
  return html.slice(at, html.indexOf('"', at));
};
const group = groupOf(injected);
const keys = group.split(",").map((entry) => entry.split(":")[0]);
assert.deepEqual(
  keys.sort(),
  ["7_12", "7_13", "7_14", "8_12", "8_13", "8_14", "9_12", "9_13", "9_14"],
  "the ring of nine tiles around the viewer is injected once each"
);
assert.ok(group.includes("8_13:2s.k"), "the viewer's own tile carries its byte range");

// A viewer on the top row has no ring above it, so the row repeats and the
// repeated tile must appear once.
const clamped = headInjection(89.9, 0, { meta, tiles });
const clampedKeys = groupOf(clamped).split(",");
assert.equal(new Set(clampedKeys).size, clampedKeys.length, "a clamped ring repeats no tile");

assert.ok(
  !headInjection(NaN, 0, { meta, tiles }).includes("tiles-latlon"),
  "no coordinates means no location tag"
);
assert.ok(
  headInjection(NaN, 0, { meta, tiles }).includes('"centre":null'),
  "no coordinates means no centre to measure a window around"
);
assert.ok(
  !headInjection(28.2061, -80.685, { meta: null, tiles }).includes("<script"),
  "no meta means no script"
);
assert.ok(
  headInjection(28.2061, -80.685, { meta, tiles: null }).includes('<script type="module">'),
  "a missing table still preloads the fixed ranges"
);

// The runtime is the page half of the preload: it fetches the fixed ranges and
// the tiles the first view covers, and answers the reader's range reads from the
// bytes it got back.
const config = {
  url: "https://tiles.example.com/basemap.pmtiles",
  total: 5000,
  ranges: [[0, 16], [900, 8]],
  centre: [0, 0],
  zoom: 5,
  tiles: [
    `15_15:${(1000).toString(36)}.${(20).toString(36)}`,
    `16_15:${(1200).toString(36)}.${(20).toString(36)}`,
    `15_16:${(1600).toString(36)}.${(20).toString(36)}`,
    `16_16:${(1400).toString(36)}.${(20).toString(36)}`,
  ].join(","),
};
const sequence = (length, from) => new Uint8Array(length).map((_, i) => (from + i) % 251);
const served = [];
const frames = [];
const page = {
  fetch: (url, init) => {
    const range = (init && init.headers && init.headers.Range) || "";
    served.push(range);
    const [start, end] = range.replace("bytes=", "").split("-").map(Number);
    return Promise.resolve(new Response(sequence(end - start + 1, start), { status: 206 }));
  },
  innerWidth: 4000,
  innerHeight: 4000,
};
const element = { getBoundingClientRect: () => ({ width: 512, height: 512 }) };
const context = {
  window: page,
  Headers,
  Response,
  document: {
    readyState: "loading",
    getElementById: (id) => (id === "map" ? element : null),
    addEventListener: () => {},
  },
  requestAnimationFrame: (fn) => frames.push(fn),
};
vm.runInContext(`(${runtime})(${JSON.stringify(config)})`, vm.createContext(context));

// The centre of the world at zoom 5, in a 512 pixel box: the window is the four
// tiles around the point, and only those four are fetched.
assert.deepEqual(
  served.map((range) => range.replace("bytes=", "").split("-")[0]).sort(),
  ["1200", "1400", "1600", "1000", "0", "900"].sort(),
  "the fixed ranges and the four window tiles are fetched once each"
);

const covered = await page.fetch(config.url, { headers: { Range: "bytes=4-9" } });
assert.equal(covered.status, 206, "a covered fixed range is answered from memory");
assert.equal(covered.headers.get("Content-Range"), "bytes 4-9/5000", "the content range names the archive");
assert.deepEqual(
  [...new Uint8Array(await covered.arrayBuffer())],
  [4, 5, 6, 7, 8, 9],
  "the bytes are the slice the page asked for"
);

const tile = await page.fetch(config.url, { headers: { range: "bytes=1004-1009" } });
assert.deepEqual(
  [...new Uint8Array(await tile.arrayBuffer())],
  [...sequence(6, 1004)],
  "a tile read inside a preloaded range is answered from those bytes"
);
assert.equal(served.length, 6, "a covered read spends no request");

const missed = await page.fetch(config.url, { headers: { Range: "bytes=2000-2003" } });
assert.equal(missed.status, 206, "an uncovered range falls through to the network");
assert.equal(served.length, 7, "the fallback spends one request");

await page.fetch("https://tiles.example.com/styles/index.json");
assert.equal(served.length, 8, "a fetch outside the archive passes through untouched");

// A box the map reports that covers more than the centre tile widens the window.
const wide = {
  ...config,
  tiles: ["15_15:500", "16_15:520", "17_15:540", "14_14:560"]
    .map((entry) => {
      const [key, start] = entry.split(":");
      return `${key}:${Number(start).toString(36)}.${(20).toString(36)}`;
    })
    .join(","),
};
const wideServed = [];
const widePage = {
  fetch: (url, init) => {
    wideServed.push((init && init.headers && init.headers.Range) || "");
    return Promise.resolve(new Response(sequence(20, 0), { status: 206 }));
  },
  innerWidth: 4000,
  innerHeight: 4000,
};
vm.runInContext(
  `(${runtime})(${JSON.stringify(wide)})`,
  vm.createContext({
    window: widePage,
    Headers,
    Response,
    document: {
      readyState: "complete",
      getElementById: () => ({ getBoundingClientRect: () => ({ width: 1024, height: 200 }) }),
      addEventListener: () => {},
    },
    requestAnimationFrame: () => {},
  })
);
assert.deepEqual(
  wideServed.filter((range) => !range.startsWith("bytes=0-") && !range.startsWith("bytes=900-")),
  ["bytes=500-519", "bytes=520-539", "bytes=540-559"],
  "a box the map reports widens the window to every tile it covers, and no tile outside it"
);

// The sprite is preloaded at the variant the map will ask for, with the kind of
// request MapLibre makes, so its own load finds the bytes in the cache rather
// than on the network.
const spriteConfig = { ...config, sprite: "https://tiles.example.com/sprites/v4/light" };
const spriteRequests = [];
const images = [];
class FakeImage {
  set src(value) {
    images.push({ src: value, crossOrigin: this.crossOrigin });
  }
}
const runSprite = (devicePixelRatio, width = 4000, height = 4000) => {
  const spritePage = {
    fetch: (url) => {
      spriteRequests.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio,
  };
  vm.runInContext(
    `(${runtime})(${JSON.stringify(spriteConfig)})`,
    vm.createContext({
      window: spritePage,
      Headers,
      Response,
      Image: FakeImage,
      document: {
        readyState: "complete",
        getElementById: () => ({ getBoundingClientRect: () => ({ width: 512, height: 512 }) }),
        addEventListener: () => {},
      },
      requestAnimationFrame: () => {},
    })
  );
};
runSprite(2);
assert.deepEqual(
  images,
  [{ src: "https://tiles.example.com/sprites/v4/light@2x.png", crossOrigin: "anonymous" }],
  "a device ratio above one preloads the 2x sheet the way MapLibre loads it"
);
assert.ok(
  spriteRequests.includes("https://tiles.example.com/sprites/v4/light@2x.json"),
  "the sprite index is preloaded too, so the sheet is not behind a round trip for it"
);
runSprite(1);
assert.deepEqual(
  images[1],
  { src: "https://tiles.example.com/sprites/v4/light.png", crossOrigin: "anonymous" },
  "a device ratio of one preloads the 1x sheet"
);
// A phone is the case the device ratio alone gets wrong: the page draws it at a
// ratio of exactly one, so the warm must be the 1x sheet although the device
// ratio is 2.625. Warming the 2x sheet there costs 29 KiB and one request for a
// file the map never asks for, next to the 16 KiB sheet it does ask for.
runSprite(2.625, 412, 823);
assert.deepEqual(
  images[2],
  { src: "https://tiles.example.com/sprites/v4/light.png", crossOrigin: "anonymous" },
  "a phone preloads the 1x sheet, because the map draws a phone at a ratio of one"
);

// Before the map's element is in the document there is nothing to measure, so
// the script waits for a frame instead of guessing at the window.
const waiting = [];
vm.runInContext(
  `(${runtime})(${JSON.stringify(config)})`,
  vm.createContext({
    window: { fetch: () => Promise.resolve(new Response(sequence(4, 0), { status: 206 })), innerWidth: 0, innerHeight: 0 },
    Headers,
    Response,
    document: { readyState: "loading", getElementById: () => null, addEventListener: () => {} },
    requestAnimationFrame: (fn) => waiting.push(fn),
  })
);
assert.equal(waiting.length, 1, "an unmeasurable map waits for a frame");

const attempts = [];
const broken = {
  fetch: (url) => {
    attempts.push(url);
    return Promise.reject(new Error("offline"));
  },
  innerWidth: 4000,
  innerHeight: 4000,
};
vm.runInContext(
  `(${runtime})(${JSON.stringify(config)})`,
  vm.createContext({
    window: broken,
    Headers,
    Response,
    document: {
      readyState: "complete",
      getElementById: () => ({ getBoundingClientRect: () => ({ width: 512, height: 512 }) }),
      addEventListener: () => {},
    },
    requestAnimationFrame: () => {},
  })
);
await assert.rejects(
  () => broken.fetch(config.url, { headers: { Range: "bytes=0-3" } }),
  "a failed preload leaves the read to the network, which also fails"
);
assert.equal(attempts.length, 7, "the read retried on the network after the preload failed");

console.log("preload snippet smoke tests passed");
