#!/usr/bin/env node
/**
 * Generate the per-tile preload table from a PMTiles archive.
 *
 * The table holds one archive byte range per zoom-five tile, so the preload
 * snippet can fetch the bytes the first map view draws instead of the whole
 * megabyte part that holds them.
 *
 * The archive is read with range requests only: the header, the root directory
 * and one leaf directory. A remote archive is never downloaded.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const tablePath = flag("--table", "dist/preload-table.txt");
const metaPath = flag("--meta", "dist/preload-meta.json");
const liveArchive = flag("--live-archive", "");
let archivePath = flag("--archive", "");

// The table has to describe the bytes the pmtiles snippet actually serves, or
// every preload warms the wrong span. The shards' archive.json is not a
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

function findTile(entries, tileId) {
  return (pm.findTile ? pm.findTile(entries, tileId) : entries.find((e) => e.tileId <= tileId && tileId < e.tileId + e.runLength));
}

// The first map view asks for a small window of zoom-five tiles: the viewer's
// own tile plus at most one tile on each side, because the map opens centred on
// the request coordinates. This resolves one tile's archive byte range, which is
// what the preload snippet fetches instead of the whole megabyte part that holds
// it. Reading the range costs nothing here: the leaf directory below is the one
// the snippet already preloads, and it was read for the fixed ranges anyway.
async function tileRange(z, x, y) {
  const tileId = pm.zxyToTileId(z, x, y);
  const rootEntry = findTile(rootDirectory, tileId);
  if (!rootEntry) return null;
  let entry = rootEntry;
  if (rootEntry.runLength === 0) {
    const leaf = await directoryAt(header.leafDirectoryOffset + rootEntry.offset, rootEntry.length);
    entry = findTile(leaf, tileId);
  }
  return entry && entry.runLength > 0 ? entry : null;
}

const PRELOAD_ZOOM = 5;
const PRELOAD_SIDE = 1 << PRELOAD_ZOOM;

// Three archive reads happen at the same offsets on every first view: the head,
// which carries the header and the root directory; the JSON metadata the page
// reads for its layer table; and one leaf directory, which the whole zoom-five
// tile range falls into. preload-snippet.js carries them so the first view needs
// no serial directory round trips. Every zoom-five tile has to share that one
// leaf directory, so this fails the build rather than emit a range that only
// some viewers would hit.
const HEAD_LENGTH = 16384; // pmtiles 3.x reads getBytes(0, 16384) for header and root

function fixedRanges() {
  const ranges = [
    [0, HEAD_LENGTH],
    [header.jsonMetadataOffset, header.jsonMetadataLength],
  ];
  let leaf = null;
  for (let x = 0; x < PRELOAD_SIDE; x++) {
    for (let y = 0; y < PRELOAD_SIDE; y++) {
      const entry = findTile(rootDirectory, pm.zxyToTileId(PRELOAD_ZOOM, x, y));
      if (!entry || entry.runLength !== 0) {
        throw new Error(`zoom-five tile ${x}_${y} is not behind a leaf directory`);
      }
      const range = [header.leafDirectoryOffset + entry.offset, entry.length];
      if (leaf === null) leaf = range;
      else if (leaf[0] !== range[0] || leaf[1] !== range[1]) {
        throw new Error("zoom-five tiles fall in more than one leaf directory");
      }
    }
  }
  ranges.push(leaf);
  return ranges;
}

// One entry per zoom-five tile in grid order, index x * 32 + y. The entry is the
// byte range of that tile's data in base 36: offset then length, absolute, so a
// reader needs no running state to decode it. A missing tile is a bare "0", a
// range no tile can have. The snippet reads nine of these per request, for the
// window around the viewer.
const tableRows = [];
let missing = 0;
for (let x = 0; x < PRELOAD_SIDE; x++) {
  for (let y = 0; y < PRELOAD_SIDE; y++) {
    const entry = await tileRange(PRELOAD_ZOOM, x, y);
    if (!entry) {
      missing++;
      tableRows.push("0");
      continue;
    }
    tableRows.push(`${(header.tileDataOffset + entry.offset).toString(36)}.${entry.length.toString(36)}`);
  }
}

mkdirSync(dirname(tablePath), { recursive: true });
// The leading "1" is the table format. A snippet that meets anything else reads
// no tile at all and preloads only the fixed ranges, which is the safe outcome
// for a snippet deployed beside a table from another version.
writeFileSync(tablePath, `1;${tableRows.join(";")}`);
console.log(`wrote ${tableRows.length} tile ranges to ${tablePath} (${missing} tiles without data)`);

mkdirSync(dirname(metaPath), { recursive: true });
writeFileSync(metaPath, JSON.stringify({
  // The archive size, for the Content-Range of a served range, and the fixed
  // ranges themselves.
  total: header.leafDirectoryOffset + header.leafDirectoryLength,
  ranges: fixedRanges(),
}));
console.log(`wrote fixed ranges to ${metaPath}`);
