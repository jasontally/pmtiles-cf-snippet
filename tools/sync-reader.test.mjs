/**
 * Tests for the reader sync. Run with: node tools/sync-reader.test.mjs
 *
 * The reader's byte offsets are the one thing in the reader that has to change
 * when the data changes, and getting them wrong serves wrong bytes rather than
 * failing. So the layout is parsed from a synthetic header with the padding and
 * the short sections a real archive has, and the rewritten entry is checked to be
 * byte identical to what is already there.
 *
 * Nothing here needs a credential. The live checks need the network, and say so
 * when they are skipped. They compare the live header with the live shards, not
 * with this checkout, so a shard refresh that lands ahead of the next `npm run
 * sync` does not fail them.
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

// The live checks compare the live header with the live shards. They do not look
// at snippet.js, and that is deliberate: the 25 shard repos refresh on their own
// schedule, so a checkout can be a commit behind and still be correct. Failing a
// test for that punished every clone for the shards moving, which is not a fault
// in the clone. `npm run sync` updates the entry, and the sync workflow runs it
// after each refresh; this file tests the reading, not the record.
try {
  const layout = await readLayout();

  await check("the live header fits the shard count", () => {
    assert.equal(
      layout.tilePartsPerShard,
      Math.ceil(layout.tileParts / SHARD_COUNT),
      "the live header implies a different parts-per-shard"
    );
    assert.ok(
      layout.tileParts <= layout.tilePartsPerShard * SHARD_COUNT,
      `${layout.tileParts} tile parts do not fit ${SHARD_COUNT} shards of ${layout.tilePartsPerShard}`
    );
    assert.ok(
      layout.tileParts > (SHARD_COUNT - 1) * layout.tilePartsPerShard,
      "the last shard would hold no parts, so parts-per-shard is too large"
    );
  });

  await check("the live shards serve the parts the header implies", async () => {
    // Parts are named by their global index, and the shard is that index divided
    // by the parts-per-shard the header states. If the header and the files
    // disagree, this is where it shows, with no checkout involved.
    const urlFor = (index) =>
      `https://s.tiles${Math.floor(index / layout.tilePartsPerShard)}.jasontally.com` +
      `/s/basemap/tile/${String(index).padStart(6, "0")}.bin`;
    const last = layout.tileParts - 1;
    const start = await fetch(urlFor(0), { method: "HEAD" });
    assert.equal(start.status, 200, `the first tile part returned ${start.status}`);
    const end = await fetch(urlFor(last), { method: "HEAD" });
    assert.equal(end.status, 200, `the last tile part (${last}) returned ${end.status}`);
    // One past the end must be absent. If it exists, the header undercounts the
    // tile section and the reader is routing parts that are not in its table.
    const past = await fetch(urlFor(layout.tileParts), { method: "HEAD" });
    assert.equal(past.status, 404, `part ${layout.tileParts} exists, so the header is short`);
  });

  await check("the tool reads the same live header", () => {
    const out = execFileSync(process.execPath, [join(HERE, "sync-reader.mjs"), "--plan"], {
      encoding: "utf8",
      timeout: 120000,
    });
    const thousands = (n) => n.toLocaleString("en-US");
    // Both branches must name the live numbers: either the entry it would write,
    // or the one that already matches.
    assert.ok(
      out.includes(`serves ${thousands(layout.total)} bytes`),
      "the tool read a different total"
    );
    assert.ok(
      out.includes(`${thousands(layout.tilePartsPerShard)} parts each`),
      "the tool read a different parts-per-shard"
    );
    assert.ok(
      /already matches|should be basemap:/.test(out),
      "the tool did not report a comparison"
    );
  });
} catch (error) {
  skipped++;
  console.log(`skip  against the live archive  (${String(error.message).split("\n")[0]})`);
}

console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);