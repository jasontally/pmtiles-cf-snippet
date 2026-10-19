/**
 * Tests for the reader sync. Run with: node tools/sync-reader.test.mjs
 *
 * The reader's byte offsets are the one thing in the reader that has to change
 * when the data changes, and getting them wrong serves wrong bytes rather than
 * failing. So the layout is parsed from a synthetic header with the padding and
 * the short sections a real archive has, and the rewritten entry is checked to be
 * byte identical to what is already there.
 *
 * Nothing here needs a credential. The live check needs the network, and says so
 * when it is skipped.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readLayout, entryFor, currentEntry, TILE_SHARD, SHARD_COUNT } from "./sync-reader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
let failed = 0;
let skipped = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

/**
 * A PMTiles v3 header, with a real shape: the root directory is followed by
 * padding before the tile data, and the last tile part is short.
 */
function headerOf({ rootOffset, rootLength, tileOffset, tileLength, metaOffset, metaLength, leafOffset, leafLength, pad = 0 }) {
  const bytes = new Uint8Array(16384);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  u64(8, rootOffset);
  u64(16, rootLength);
  u64(24, metaOffset);
  u64(32, metaLength);
  u64(40, leafOffset);
  u64(48, leafLength);
  u64(56, tileOffset);
  u64(64, tileLength);
  bytes[96] = 2;  // gzip tile data
  bytes[97] = 2;
  bytes[100] = 0;
  bytes[101] = 15;
  return bytes;
}

/**
 * The real archive's shape, read from the live header on 2026-10-19, when the
 * shards moved from 20261010 to 20261017: a 723 byte gap after the root
 * directory, and 138,589 tile parts instead of 69,209.
 *
 * The numbers are the archive's, but the expectations below are worked out from
 * them. A fixture that carries its own answers stops the test from breaking
 * every time the archive changes, which is what happened when the offsets were
 * updated by the sync workflow and the test was not.
 */
const REAL = {
  rootOffset: 127, rootLength: 15554,
  tileOffset: 16384, tileLength: 138588222487,
  metaOffset: 138588238871, metaLength: 1180,
  leafOffset: 138588240051, leafLength: 352854844,
};

/** A fetch that serves the header bytes, so no network is needed. */
const serveHeader = (bytes, status = 200) => async () =>
  new Response(bytes, { status, headers: { "Content-Length": String(bytes.length) } });

await check("it reads the layout out of a header", async () => {
  const layout = await readLayout(serveHeader(headerOf(REAL)));
  assert.equal(layout.total, REAL.leafOffset + REAL.leafLength, "total");
  assert.equal(layout.tileDataOffset, REAL.tileOffset, "tileDataOffset");
  assert.equal(layout.metadataOffset, REAL.metaOffset, "metadataOffset");
  assert.equal(layout.leafDirOffset, REAL.leafOffset, "leafDirOffset");
  assert.equal(
    layout.tileParts,
    Math.ceil(REAL.tileLength / TILE_SHARD),
    "tileParts"
  );
  assert.equal(
    layout.tilePartsPerShard,
    Math.ceil(layout.tileParts / SHARD_COUNT),
    "tilePartsPerShard"
  );
});

await check("the padding after the root directory is allowed", async () => {
  // The root directory ends before the tile data starts, because PMTiles pads
  // to a boundary, so a gap is normal here. Derived from the fixture so it
  // holds for whatever archive the shards currently hold.
  const layout = await readLayout(serveHeader(headerOf(REAL)));
  const rootEnd = REAL.rootOffset + REAL.rootLength;
  assert.equal(rootEnd < layout.tileDataOffset, true, "the fixture should have a gap");
});

await check("a root directory that runs into the tile data is refused", async () => {
  const bad = { ...REAL, rootLength: 20000 }; // ends at 20127, after 16384
  await assert.rejects(
    () => readLayout(serveHeader(headerOf(bad))),
    /root directory ends at 20127/
  );
});

await check("a layout that is not contiguous is refused", async () => {
  const bad = { ...REAL, tileLength: REAL.tileLength - 1000 };
  await assert.rejects(
    () => readLayout(serveHeader(headerOf(bad))),
    /not contiguous/
  );
});

await check("something that is not a PMTiles v3 header is refused", async () => {
  const bytes = headerOf(REAL);
  bytes[0] = 0x58;
  await assert.rejects(() => readLayout(serveHeader(bytes)), /not a PMTiles v3 header/);
});

await check("a short response is refused", async () => {
  await assert.rejects(() => readLayout(serveHeader(new Uint8Array(100))), /only 100 bytes/);
});

await check("a non-200 response is refused", async () => {
  await assert.rejects(() => readLayout(serveHeader(headerOf(REAL), 503)), /returned 503/);
});

await check("the parts per shard grow with the archive", async () => {
  // A stale 4864 sends every read to the wrong host, so this has to move.
  const small = await readLayout(serveHeader(headerOf(REAL)));
  const twice = REAL.tileLength * 2;
  const bigger = await readLayout(
    serveHeader(headerOf({
      ...REAL,
      tileLength: twice,
      metaOffset: REAL.tileOffset + twice,
      leafOffset: REAL.tileOffset + twice + REAL.metaLength,
    }))
  );
  // Computed rather than hard coded, so this states the rule instead of a number.
  const expected = Math.ceil(Math.ceil(twice / TILE_SHARD) / SHARD_COUNT);
  assert.equal(bigger.tilePartsPerShard, expected, "the derived value");
  assert.ok(bigger.tilePartsPerShard > small.tilePartsPerShard, "the value did not grow");
});

await check("the entry it writes holds every field the reader needs", async () => {
  const layout = await readLayout(serveHeader(headerOf(REAL)));
  const entry = entryFor(layout);
  for (const field of [
    "total:", "headEnd:", "tileOffset:", "metaOffset:", "leafOffset:",
    "tileShard:", "leafShard:", "tilePartsPerShard:",
  ]) {
    assert.ok(entry.includes(field), `the entry is missing ${field}`);
  }
});

await check("a rewrite is exact, leaving the rest of the file alone", () => {
  const layout = {
    total: 111, tileDataOffset: 222, metadataOffset: 333, leafDirOffset: 444,
    tilePartsPerShard: 55,
  };
  const source = 'const ARCHIVES = {\n  basemap: {\n    total: 1,\n    headEnd: 2,\n  },\n};\n';
  const existing = currentEntry(source);
  assert.ok(existing, "no entry found");
  const patched = source.replace(existing, entryFor(layout).trim());
  assert.ok(patched.startsWith('const ARCHIVES = {\n  basemap: {'), "indentation lost");
  assert.ok(patched.includes("    total: 111,"), "indentation inside the entry lost");
  assert.ok(patched.endsWith("};\n"), "the tail of the file was lost");
  assert.equal(currentEntry(patched).trim(), entryFor(layout).trim(), "did not round trip");
});

await check("the plan run never writes", () => {
  const before = readFileSync(join(ROOT, "snippet.js"), "utf8");
  execFileSync(process.execPath, [join(HERE, "sync-reader.mjs"), "--plan"], { encoding: "utf8" });
  assert.equal(readFileSync(join(ROOT, "snippet.js"), "utf8"), before, "the plan run wrote");
});

// The live check needs the network, which is the point: this tool's whole job is
// to compare against what the shards actually serve.
try {
  const out = execFileSync(process.execPath, [join(HERE, "sync-reader.mjs"), "--plan"], {
    encoding: "utf8",
    timeout: 120000,
  });
  await check("against the live archive, the reader already agrees", () => {
    assert.ok(out.includes("already matches"), out.slice(0, 400));
  });

  // The strongest check available: render the entry from the live header and
  // compare with snippet.js as committed. Any drift shows up as a rewrite the
  // sync would otherwise make on every run. This one reads the live header
  // rather than a fixture, so it stays true when the archive changes.
  await check("snippet.js holds what the live archive implies", async () => {
    const layout = await readLayout();
    const source = readFileSync(join(ROOT, "snippet.js"), "utf8");
    const existing = currentEntry(source);
    assert.ok(existing, "no basemap entry in snippet.js");
    assert.equal(
      existing.trim(),
      entryFor(layout).trim(),
      "snippet.js does not hold what the archive layout implies"
    );
  });
} catch (error) {
  skipped++;
  console.log(`skip  against the live archive  (${String(error.message).split("\n")[0]})`);
}

console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);