#!/usr/bin/env node
/**
 * Bring the reader's byte offsets in line with whatever the shards now hold.
 *
 *   node tools/sync-reader.mjs           update snippet.js if it disagrees
 *   node tools/sync-reader.mjs --plan    print, change nothing
 *
 * This runs in GitHub Actions in this repo, after the shard refresh window. It
 * holds no credentials and needs none: the archive header is read over plain HTTP
 * from shard 0, which serves assets without a token.
 *
 * WHY THE READER NEEDS UPDATING AT ALL
 *
 * The reader answers a range request from one subrequest, and a second one is the
 * Pro plan limit, so it cannot spend a subrequest reading the header. The byte
 * offsets are therefore constants in snippet.js, and they change whenever the
 * archive changes, because the tile section changes length.
 *
 * WHY THIS IS SELF CORRECTING
 *
 * There is no state here and no knowledge of which Protomaps build was chosen. It
 * reads what shard 0 actually serves and compares. If they agree, there is nothing
 * to do. If they do not, it commits the difference, and the build for this repo
 * deploys the Snippet.
 *
 * That means a missed refresh, a failed shard, or a window that never ran all
 * leave the reader correct, because there is nothing to remember. It also means
 * this must not run until shard 0 has been rebuilt: until then shard 0 still
 * serves the old header, the offsets still agree, and this correctly does
 * nothing. It is safe to run often.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNIPPET = join(ROOT, "snippet.js");

/** Shard 0 serves the assets, and it is the one that holds head.bin. */
const HEAD_URL = "https://s.tiles0.jasontally.com/s/basemap/head.bin";
const ARCHIVE_NAME = "basemap";

const HEAD_BYTES = 16_384;
const TILE_SHARD = 2_000_000;
const LEAF_SHARD = 160_000;
const SHARD_COUNT = 13;

const planOnly = process.argv.includes("--plan");

/**
 * Read the live header and work out the layout the reader needs.
 *
 * The four sections sit back to back, so each must end where the next begins.
 * That is checked rather than assumed: a header that does not lay out that way
 * would produce offsets that look plausible and serve the wrong bytes.
 */
export async function readLayout(fetchImpl = fetch) {
  const response = await fetchImpl(HEAD_URL);
  if (!response.ok) throw new Error(`${HEAD_URL} returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < HEAD_BYTES) throw new Error(`the header is only ${bytes.length} bytes`);
  if (String.fromCharCode(...bytes.slice(0, 7)) !== "PMTiles" || bytes[7] !== 3) {
    throw new Error(`that is not a PMTiles v3 header: ${[...bytes.slice(0, 8)].join(",")}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (offset) => Number(view.getBigUint64(offset, true));

  const rootDirOffset = u64(8);
  const rootDirLength = u64(16);
  const metadataOffset = u64(24);
  const metadataLength = u64(32);
  const leafDirOffset = u64(40);
  const leafDirLength = u64(48);
  const tileDataOffset = u64(56);
  const tileDataLength = u64(64);

  // The tile, metadata and leaf sections are exactly contiguous. The root
  // directory is not: PMTiles pads it out to a boundary before the tile data, so
  // it may end short of tileDataOffset. In this archive it ends at 15,661 and the
  // tile data starts at 16,384, a gap of 723 bytes.
  if (rootDirOffset + rootDirLength > tileDataOffset) {
    throw new Error(
      `the root directory ends at ${rootDirOffset + rootDirLength}, after the tile ` +
        `data starts at ${tileDataOffset}`
    );
  }
  for (const [what, end, start] of [
    ["tile end to metadata start", tileDataOffset + tileDataLength, metadataOffset],
    ["metadata end to leaf start", metadataOffset + metadataLength, leafDirOffset],
  ]) {
    if (end !== start) throw new Error(`${what}: ${end} != ${start}, the layout is not contiguous`);
  }

  const tileParts = Math.ceil(tileDataLength / TILE_SHARD);
  return {
    total: leafDirOffset + leafDirLength,
    tileDataOffset,
    tileDataLength,
    metadataOffset,
    leafDirOffset,
    // A part number gives its shard with one division, and this has to equal what
    // the shard builds compute. It grows as the archive grows, so a stale value
    // sends every read to the wrong host.
    tilePartsPerShard: Math.ceil(tileParts / SHARD_COUNT),
    tileParts,
    leafParts: Math.ceil(leafDirLength / LEAF_SHARD),
    rootDirLength,
  };
}

/** The basemap entry as it should read, given a layout. */
export function entryFor(layout) {
  return [
    "  basemap: {",
    `    total: ${layout.total},`,
    // The head section runs to where the tile data starts. In this archive the two
    // are the same number, which is why the reader can treat them as adjacent.
    `    headEnd: ${layout.tileDataOffset},`,
    `    tileOffset: ${layout.tileDataOffset},`,
    `    metaOffset: ${layout.metadataOffset},`,
    `    leafOffset: ${layout.leafDirOffset},`,
    `    tileShard: ${TILE_SHARD},`,
    `    leafShard: ${LEAF_SHARD},`,
    `    tilePartsPerShard: ${layout.tilePartsPerShard},`,
    "  },",
  ].join("\n");
}

/** The layout the reader currently holds, or null if the entry is unreadable. */
export function currentEntry(source) {
  // The match starts at "basemap" and leaves the leading indentation in place, so
  // compare and replace on the trimmed form. Including the indent in the pattern
  // and then substituting it back in is how the two drift apart.
  const match = /basemap: \{[\s\S]*?\n  \},/.exec(source);
  return match ? match[0] : null;
}

async function main() {
  const layout = await readLayout();
  console.log(`shard 0   serves ${layout.total.toLocaleString()} bytes`);
  console.log(`tiles     ${layout.tileDataLength.toLocaleString()} bytes in ${layout.tileParts.toLocaleString()} parts`);
  console.log(`shard     ${layout.tilePartsPerShard.toLocaleString()} parts each, ` +
    `shard 0 holds about ${(layout.tilePartsPerShard + layout.leafParts + 2).toLocaleString()} files`);

  const source = readFileSync(SNIPPET, "utf8");
  const existing = currentEntry(source);
  if (!existing) fail("could not find the basemap entry in snippet.js");

  const wanted = entryFor(layout);
  if (existing.trim() === wanted.trim()) {
    console.log("reader    already matches, so nothing to commit");
    return;
  }

  console.log("reader    disagrees with what shard 0 serves");
  console.log(`holding   ${existing.split("\n").map((l) => l.trim()).join(" ")}`);
  console.log(`should be ${wanted.split("\n").map((l) => l.trim()).join(" ")}`);
  if (planOnly) {
    console.log("plan      snippet.js not touched");
    return;
  }

  writeFileSync(SNIPPET, source.replace(existing, wanted.trim()));
  console.log("written   commit this and the build deploys the reader");
}

function fail(message) {
  console.error(`sync-reader failed: ${message}`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("sync-reader.mjs")) main();