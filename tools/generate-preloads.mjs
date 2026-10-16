#!/usr/bin/env node
/**
 * Generate per-tile preload lists from a PMTiles archive.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const pmtilesCode = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "vendor", "pmtiles.js"), "utf8");
const sandbox = { console, fetch, URL, Headers };
vm.createContext(sandbox);
vm.runInContext(pmtilesCode, sandbox);
const pm = sandbox.pmtiles;

function flag(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
}
const args = process.argv.slice(2);
const outDir = flag("--out", "public");
const tileShard = Number(flag("--tile-shard", "1000000"));
const shardCount = Number(flag("--shards", "25"));
// Optional override. When it is absent the count is derived from the archive
// header, so it cannot disagree with the shard build.
const explicitParts = flag("--parts", "");
const tablePath = flag("--table", "dist/preload-table.txt");
const limit = Number(flag("--limit", "Infinity"));
const liveArchive = flag("--live-archive", "");
let archivePath = flag("--archive", "");

// The table has to describe the bytes the pmtiles snippet actually serves, or
// every preload warms the wrong part. The shards' archive.json is not a
// reliable signal: each shard repo commits its own copy, and this repo only
// holds the seed. So probe the served archive first. A build that has a local
// archive uses that instead: it is about to publish those bytes.
if (archivePath === "" && !args.includes("--archive") && liveArchive) {
  let reachable = false;
  try {
    const probe = await fetch(liveArchive, { headers: { Range: "bytes=0-99" } });
    reachable = probe.ok;
    if (!reachable) console.log(`served archive ${liveArchive} returned ${probe.status}`);
  } catch (error) {
    console.log(`served archive ${liveArchive} is unreachable: ${error.message}`);
  }
  if (reachable) {
    archivePath = liveArchive;
    console.log(`using the served archive ${liveArchive}`);
  }
}

if (archivePath === "" && !args.includes("--archive")) {
  // Fallback for a host that serves nothing yet: pick the same Protomaps
  // build the shards refresh to, without downloading it.
  const buildsResp = await fetch("https://build-metadata.protomaps.dev/builds.json");
  const builds = await buildsResp.json();
  const now = new Date();
  const open = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 30, 0));
  open.setUTCDate(open.getUTCDate() - open.getUTCDay());
  if (open.getTime() > now.getTime()) open.setUTCDate(open.getUTCDate() - 7);
  const eligible = builds
    .filter((b) => +new Date(b.uploaded) < open.getTime())
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!eligible.length) throw new Error("no eligible Protomaps build");
  const target = eligible[eligible.length - 1];
  const base = target.key.endsWith(".pmtiles") ? target.key : `${target.key}.pmtiles`;
  archivePath = `https://build.protomaps.com/${base}`;
  console.log(`using Protomaps build ${target.key}`);
}

const isRemote = /^https?:\/\//.test(archivePath);
let bytes = null;
async function getBytes(offset, length) {
  if (!isRemote) {
    if (!bytes) bytes = readFileSync(archivePath);
    return bytes.subarray(offset, offset + length);
  }
  const resp = await fetch(archivePath, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (!resp.ok) throw new Error(`fetch ${offset} returned ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

function decompress(data, code) {
  if (code === 1 || code === "none") return data;
  if (code === 2 || code === "gzip") return gunzipSync(data);
  throw new Error(`unsupported internal compression ${code}`);
}

function deserializeIndex(buffer) {
  const p = { buf: buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), pos: 0 };
  const readVarint = () => pm.readVarint(p);
  const numEntries = readVarint();
  const entries = [];
  let lastId = 0;
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint();
    entries.push({ tileId: lastId + v, offset: 0, length: 0, runLength: 1 });
    lastId += v;
  }
  for (let i = 0; i < numEntries; i++) entries[i].runLength = readVarint();
  for (let i = 0; i < numEntries; i++) entries[i].length = readVarint();
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint();
    if (v === 0 && i > 0) {
      entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    } else {
      entries[i].offset = v - 1;
    }
  }
  return entries;
}

const directoryCache = new Map();
async function directoryAt(offset, length) {
  const key = `${offset}:${length}`;
  if (directoryCache.has(key)) return directoryCache.get(key);
  const slice = await getBytes(offset, length);
  const data = decompress(slice, header.internalCompression);
  const result = deserializeIndex(data);
  directoryCache.set(key, result);
  return result;
}

const headerBytes = await getBytes(0, pm.HEADER_SIZE_BYTES || 127);
const header = pm.bytesToHeader(headerBytes instanceof Uint8Array ? headerBytes.buffer : headerBytes, null);
const rootDirectory = await directoryAt(header.rootDirectoryOffset, header.rootDirectoryLength);

const tilePartCount = Math.ceil(header.tileDataLength / tileShard);
const shardPartsPerShard = explicitParts
  ? Number(explicitParts)
  : Math.ceil(tilePartCount / shardCount);
if (!Number.isInteger(shardPartsPerShard) || shardPartsPerShard <= 0) {
  throw new Error(`bad shard size: ${shardPartsPerShard}`);
}

function findTile(entries, tileId) {
  return (pm.findTile ? pm.findTile(entries, tileId) : entries.find((e) => e.tileId <= tileId && tileId < e.tileId + e.runLength));
}

async function tilePartNumber(z, x, y) {
  const tileId = pm.zxyToTileId(z, x, y);
  const rootEntry = findTile(rootDirectory, tileId);
  if (!rootEntry) return null;
  let entry = rootEntry;
  if (rootEntry.runLength === 0) {
    const leaf = await directoryAt(header.leafDirectoryOffset + rootEntry.offset, rootEntry.length);
    entry = findTile(leaf, tileId);
    if (!entry || entry.runLength === 0) return null;
  }
  return Math.floor(entry.offset / tileShard);
}

// The keys are the zoom-five tiles the first map view asks for. The map window
// covers two tiles wide and at most three tall, and the viewer can sit anywhere
// inside the keyed tile, so one tile of margin on each side covers every
// position. preload-snippet.js builds the same key from the request
// coordinates, and the two must stay in step or every preload warms nothing.
const PRELOAD_ZOOM = 5;
const PRELOAD_SPAN = 1;
const PRELOAD_SIDE = 1 << PRELOAD_ZOOM;

const outBase = join(outDir, "preload");
// The key space follows the scheme above, so clear the last run. A stale bucket
// would sit in the asset tree under a key the snippet can never build.
rmSync(outBase, { recursive: true, force: true });
mkdirSync(outBase, { recursive: true });

let tiles = [];
for (let x = 0; x < PRELOAD_SIDE; x++) {
  for (let y = 0; y < PRELOAD_SIDE; y++) {
    tiles.push({ x, y });
  }
}
if (limit < tiles.length) tiles = tiles.slice(0, limit);

const tableRows = [];
let written = 0;
for (const tile of tiles) {
  const parts = new Set();
  for (let dx = -PRELOAD_SPAN; dx <= PRELOAD_SPAN; dx++) {
    for (let dy = -PRELOAD_SPAN; dy <= PRELOAD_SPAN; dy++) {
      const x = Math.max(0, Math.min(PRELOAD_SIDE - 1, tile.x + dx));
      const y = Math.max(0, Math.min(PRELOAD_SIDE - 1, tile.y + dy));
      const part = await tilePartNumber(PRELOAD_ZOOM, x, y);
      if (part !== null) parts.add(part);
    }
  }
  if (!parts.size) continue;
  const sorted = [...parts].sort((a, b) => a - b);
  const urls = sorted.map((part) => {
    const host = Math.floor(part / shardPartsPerShard);
    return `https://s.tiles${host}.jasontally.com/s/basemap/tile/${String(part).padStart(6, "0")}.bin`;
  });
  const key = `${tile.x}_${tile.y}`;
  writeFileSync(join(outBase, `${key}.json`), JSON.stringify(urls));
  tableRows.push(`${key}:${sorted.join(",")}`);
  written++;
  console.log(`wrote ${written}: ${key} (${parts.size} parts)`);
}

mkdirSync(dirname(tablePath), { recursive: true });
// Parts per shard goes first, then one "key:parts" entry per tile. The snippet
// splits on semicolons and reads the count from the first chunk.
writeFileSync(tablePath, `${shardPartsPerShard};${tableRows.join(";")}`);
console.log(`wrote ${tableRows.length} table entries to ${tablePath}`);

console.log(`wrote ${written} preload buckets to ${outBase}`);