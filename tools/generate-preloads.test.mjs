/**
 * Tests for the preload table generator. Run with: node tools/generate-preloads.test.mjs
 *
 * The generator reads the archive the reader serves, through the shards, and the
 * table it writes is what the first map view preloads. So the test builds a real
 * archive with a real directory structure, splits it with the real tool, serves
 * the parts the way Static Assets do, and checks the table that comes out.
 *
 * The leaf directory sits across the boundary between two leaf parts, because a
 * directory that fits inside one part is the easy case and the one that does
 * not is the one that can be wrong.
 *
 * Nothing here needs a credential and nothing reaches the network.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

import { checkLayout, generate, shardSource } from "./generate-preloads.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TOOL = join(ROOT, "shard-pmtiles.py");

const HEAD_BYTES = 16384;
const TILE_SHARD = 1000000;
const LEAF_SHARD = 160000;
const PRELOAD_ZOOM = 5;
const PRELOAD_SIDE = 1 << PRELOAD_ZOOM;

// The library the generator reads the archive with. The tile ids come from it,
// so the test does not number the tiles its own way.
const sandbox = { console, fetch, URL, Headers };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "assets", "vendor", "pmtiles.js"), "utf8"), sandbox);
const pm = sandbox.pmtiles;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** A varint, the way the directory format writes one. */
function varint(value) {
  const out = [];
  let n = value;
  while (n >= 128) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** A directory, the way the archive format writes one. */
function serializeIndex(entries) {
  const out = [];
  const push = (value) => out.push(...varint(value));
  push(entries.length);
  let last = 0;
  for (const entry of entries) {
    push(entry.tileId - last);
    last = entry.tileId;
  }
  for (const entry of entries) push(entry.runLength);
  for (const entry of entries) push(entry.length);
  // The offset is stored as offset plus one, because zero means "the same place
  // as the entry before".
  for (const entry of entries) push(entry.offset + 1);
  return new Uint8Array(out);
}

/**
 * A synthetic archive with a root directory that points at a leaf directory,
 * and a leaf directory that holds every zoom-five tile.
 *
 * The leaf directory is placed near the end of the first leaf part, so it
 * crosses into the second one. The reader serves such a directory in two reads,
 * and the generator has to do the same.
 */
function makeArchive() {
  const tileLength = 300000;
  const metaLength = 1180;
  const leafLength = 400000;
  const metaOffset = HEAD_BYTES + tileLength;
  const leafOffset = metaOffset + metaLength;
  const total = leafOffset + leafLength;

  const leafEntries = [];
  for (let x = 0; x < PRELOAD_SIDE; x++) {
    for (let y = 0; y < PRELOAD_SIDE; y++) {
      leafEntries.push({
        tileId: pm.zxyToTileId(PRELOAD_ZOOM, x, y),
        runLength: 1,
        length: 100,
        offset: (x * PRELOAD_SIDE + y) * 100,
      });
    }
  }
  // A directory is sorted by tile id, and the library numbers tiles along a
  // Hilbert curve, so the grid order is not the id order.
  leafEntries.sort((a, b) => a.tileId - b.tileId);
  const leafDirectory = gzipSync(serializeIndex(leafEntries));

  // The offset of the leaf directory inside the leaf section. It is placed so
  // that half of it is in the first leaf part and half in the second, which is
  // the case the reader answers with two reads.
  const leafDirectoryOffset = LEAF_SHARD - Math.floor(leafDirectory.length / 2);
  const rootDirectory = gzipSync(serializeIndex([{
    tileId: pm.zxyToTileId(PRELOAD_ZOOM, 0, 0),
    runLength: 0,
    length: leafDirectory.length,
    offset: leafDirectoryOffset,
  }]));

  const bytes = new Uint8Array(total);
  // A distinct byte per region, so a misrouted read is visible.
  for (let i = 0; i < total; i++) bytes[i] = i & 0xff;

  const header = new Uint8Array(127);
  header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
  header[7] = 3;
  const view = new DataView(header.buffer);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  u64(8, 127);                  // root directory offset
  u64(16, rootDirectory.length);
  u64(24, metaOffset);
  u64(32, metaLength);
  u64(40, leafOffset);
  u64(48, leafLength);
  u64(56, HEAD_BYTES);          // tile data offset
  u64(64, tileLength);
  u64(72, PRELOAD_SIDE * PRELOAD_SIDE);
  u64(80, PRELOAD_SIDE * PRELOAD_SIDE);
  u64(88, PRELOAD_SIDE * PRELOAD_SIDE);
  header[97] = 2;               // internal compression: gzip
  header[98] = 2;
  header[101] = PRELOAD_ZOOM;

  bytes.set(header, 0);
  bytes.set(rootDirectory, 127);
  bytes.set(leafDirectory, leafOffset + leafDirectoryOffset);

  const dir = mkdtempSync(join(tmpdir(), "pmt-"));
  const src = join(dir, "demo.pmtiles");
  writeFileSync(src, bytes);
  return { dir, src, total, metaOffset, metaLength, leafOffset, leafDirectoryOffset, leafDirectoryLength: leafDirectory.length };
}

/** Split the archive with the real tool, then read the parts back. */
function splitAndLoad(archive) {
  const out = join(archive.dir, "public");
  execFileSync("python3", [
    TOOL, archive.src, "--out", out, "--name", "basemap",
    "--tile-shard", String(TILE_SHARD), "--leaf-shard", String(LEAF_SHARD),
  ], { stdio: "pipe" });

  const assets = {};
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else assets[`${prefix}${entry.name}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(join(out, "s", "basemap"), "");
  return assets;
}

/**
 * Serve the parts the way Static Assets do: no Range support, the whole file
 * every time.
 */
function makeFetch(assets, seen) {
  return async (target) => {
    const key = new URL(target).pathname.replace(/^\/s\/basemap\//, "");
    seen.push(key);
    if (assets[key] === undefined) return new Response("missing", { status: 404 });
    return new Response(assets[key], {
      status: 200,
      headers: { "Content-Length": String(assets[key].length) },
    });
  };
}

/** The reader constants for the synthetic archive. */
function readerFor(archive) {
  return {
    total: archive.total,
    headEnd: HEAD_BYTES,
    tileOffset: HEAD_BYTES,
    metaOffset: archive.metaOffset,
    leafOffset: archive.leafOffset,
    tileShard: TILE_SHARD,
    leafShard: LEAF_SHARD,
    tilePartsPerShard: 1,
  };
}

const archive = makeArchive();
const assets = splitAndLoad(archive);
const reader = readerFor(archive);
const tablePath = join(archive.dir, "preload-table.txt");
const metaPath = join(archive.dir, "preload-meta.json");

await check("the table describes every zoom-five tile", async () => {
  const seen = [];
  const source = shardSource("basemap", reader, makeFetch(assets, seen));
  const { table } = await generate({ reader, source, tablePath, metaPath });

  const rows = table.slice(table.indexOf(";") + 1).split(";");
  assert.equal(rows.length, PRELOAD_SIDE * PRELOAD_SIDE);
  assert.ok(!rows.includes("0"), "every zoom-five tile should have a range");

  for (const [x, y] of [[0, 0], [0, 31], [17, 9], [31, 31]]) {
    const offset = HEAD_BYTES + (x * PRELOAD_SIDE + y) * 100;
    assert.equal(rows[x * PRELOAD_SIDE + y], `${offset.toString(36)}.${(100).toString(36)}`);
  }
});

await check("the leaf directory is read across two parts", async () => {
  const seen = [];
  const source = shardSource("basemap", reader, makeFetch(assets, seen));
  await generate({ reader, source, tablePath, metaPath });
  assert.ok(seen.includes("leaf/000000.bin"), "the first leaf part should be read");
  assert.ok(seen.includes("leaf/000001.bin"), "the second leaf part should be read");
});

await check("the head is read once, and no tile part is read", async () => {
  const seen = [];
  const source = shardSource("basemap", reader, makeFetch(assets, seen));
  await generate({ reader, source, tablePath, metaPath });
  assert.equal(seen.filter((key) => key === "head.bin").length, 1);
  assert.equal(seen.filter((key) => key.startsWith("tile/")).length, 0);
});

await check("the meta holds the size and the fixed ranges", async () => {
  const seen = [];
  const source = shardSource("basemap", reader, makeFetch(assets, seen));
  await generate({ reader, source, tablePath, metaPath });
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  assert.equal(meta.total, archive.total);
  assert.deepEqual(meta.ranges, [
    [0, HEAD_BYTES],
    [archive.metaOffset, archive.metaLength],
    [archive.leafOffset + archive.leafDirectoryOffset, archive.leafDirectoryLength],
  ]);
});

await check("a reader that disagrees with the archive is refused", async () => {
  const stale = { ...reader, total: archive.total - 1, leafOffset: archive.leafOffset - 1 };
  const seen = [];
  const source = shardSource("basemap", stale, makeFetch(assets, seen));
  await assert.rejects(
    () => generate({ reader: stale, source, tablePath, metaPath }),
    /disagree about the leaf directory offset/
  );
});

await check("checkLayout names the offset that does not match", async () => {
  const header = {
    tileDataOffset: HEAD_BYTES,
    jsonMetadataOffset: archive.metaOffset,
    leafDirectoryOffset: archive.leafOffset,
    leafDirectoryLength: archive.total - archive.leafOffset,
  };
  assert.doesNotThrow(() => checkLayout(header, reader));
  assert.throws(
    () => checkLayout(header, { ...reader, total: reader.total + 1 }),
    /disagree about the total offset/
  );
});

rmSync(archive.dir, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
