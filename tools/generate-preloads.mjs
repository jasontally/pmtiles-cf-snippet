#!/usr/bin/env node
/**
 * Generate per-location preload lists from a PMTiles archive.
 *
 *   node tools/generate-preloads.mjs ARCHIVE.pmtiles PUBLIC_DIR
 *
 * The files are written below PUBLIC_DIR as preload/<bucket>.json, each a small
 * JSON array of part-file URLs. They are static assets, so Cloudflare serves them
 * with the normal asset cache.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const pmtilesCode = readFileSync(join(dirname(import.meta.url), "..", "assets", "vendor", "pmtiles.js"), "utf8");
const sandbox = { console, fetch, URL, Headers };
vm.createContext(sandbox);
vm.runInContext(pmtilesCode, sandbox);
const pm = sandbox.pmtiles;

const archivePath = process.argv[2];
const outDir = process.argv[3] || "public";
if (!archivePath) {
  console.error("usage: generate-preloads.mjs ARCHIVE.pmtiles [PUBLIC_DIR]");
  process.exit(1);
}

const bytes = readFileSync(archivePath);
const headerBytes = bytes.subarray(0, pm.HEADER_SIZE_BYTES || 127);
const header = pm.bytesToHeader(headerBytes, null);
const tileShard = Number(process.argv[4] || 1000000);
const shardPartsPerShard = Number(process.argv[5] || 5059);

function decompress(data, code) {
  // PMTiles internal compression codes: 1 = none, 2 = gzip.
  if (code === 1 || code === "none") return data;
  if (code === 2 || code === "gzip") return gunzipSync(data);
  throw new Error(`unsupported internal compression ${code}`);
}

function deserializeIndex(buffer) {
  const p = { buf: new Uint8Array(buffer), pos: 0 };
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

function directoryAt(offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  const data = decompress(slice, header.internalCompression);
  return deserializeIndex(data);
}

const rootDirectory = directoryAt(header.rootDirectoryOffset, header.rootDirectoryLength);

function findTile(entries, tileId) {
  return pm.findTile ? pm.findTile(entries, tileId) : entries.find((e) => e.tileId <= tileId && tileId < e.tileId + e.runLength);
}

function tilePartNumber(z, x, y) {
  const tileId = pm.zxyToTileId(z, x, y);
  const rootEntry = findTile(rootDirectory, tileId);
  if (!rootEntry) return null;
  let entry = rootEntry;
  let directory = rootDirectory;
  if (rootEntry.runLength === 0) {
    const leaf = directoryAt(header.leafDirectoryOffset + rootEntry.offset, rootEntry.length);
    entry = findTile(leaf, tileId);
    if (!entry || entry.runLength === 0) return null;
    directory = leaf;
  }
  const part = Math.floor(entry.offset / tileShard);
  return part;
}

function latLonToTile(lat, lon, zoom) {
  const n = 1 << zoom;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)), z: zoom };
}

const outBase = join(outDir, "preload");
mkdirSync(outBase, { recursive: true });
const cells = [];
for (let lat = -90; lat < 90; lat += 10) {
  for (let lon = -180; lon < 180; lon += 10) {
    cells.push({ lat, lon });
  }
}

let written = 0;
for (const cell of cells) {
  const centerLat = cell.lat + 5;
  const centerLon = cell.lon + 5;
  const tile = latLonToTile(centerLat, centerLon, 5);
  const parts = new Set();
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const part = tilePartNumber(tile.z, tile.x + dx, tile.y + dy);
      if (part !== null) parts.add(part);
    }
  }
  if (!parts.size) continue;
  const urls = [...parts].sort((a, b) => a - b).map((part) => {
    const host = Math.floor(part / shardPartsPerShard);
    return `https://s.tiles${host}.jasontally.com/s/basemap/tile/${String(part).padStart(6, "0")}.bin`;
  });
  const key = `${Math.floor(cell.lat / 10) * 10}:${Math.floor(cell.lon / 10) * 10}`;
  // Keep bucket naming identical to the snippet.
  writeFileSync(join(outBase, `${encodeURIComponent(key)}.json`), JSON.stringify(urls));
  written++;
}

console.log(`wrote ${written} preload buckets to ${outBase}`);
EOF
node tools/generate-preloads.mjs --help 2>&1 | head