#!/usr/bin/env node
/**
 * Print the shard plan for the Protomaps basemap, at several assumed speeds.
 * Run with: node plan-report.mjs
 *
 * This is the decision tool. It answers "how many Workers" without deploying
 * anything, and it shows which limit binds at each speed.
 */

import { planShards, planRequest } from "./shard-plan.mjs";

// Measured from https://build.protomaps.com/20241021.pmtiles, 2026-10-08.
const TOTAL = 126_775_469_007;
const HEAD_END = 16_384;
const TILE_OFFSET = 16_384;
const TILE_LENGTH = 126_450_529_397;
const META_OFFSET = 126_450_545_781;
const META_LENGTH = 1_160;
const LEAF_OFFSET = 126_450_546_941;
const LEAF_LENGTH = 324_922_066;

const TILE_SHARD = 2_000_000;
const LEAF_SHARD = 160_000;

const tileParts = Math.ceil(TILE_LENGTH / TILE_SHARD);
const leafParts = Math.ceil(LEAF_LENGTH / LEAF_SHARD);
const fixedBytes = HEAD_END + META_LENGTH + LEAF_LENGTH;

console.log(`archive            ${TOTAL.toLocaleString()} bytes (${(TOTAL / 2 ** 30).toFixed(2)} GiB)`);
console.log(`tile section       ${TILE_LENGTH.toLocaleString()} bytes in ${tileParts.toLocaleString()} parts`);
console.log(`leaf section       ${LEAF_LENGTH.toLocaleString()} bytes in ${leafParts} parts`);
console.log(`head + meta + leaf ${(fixedBytes / 1e6).toFixed(1)} MB, all in shard 0`);
console.log(`build limits       20 GB disk, 1200 s, 100,000 files`);
console.log();

const pad = (value, width) => String(value).padStart(width);
console.log(
  `${pad("assumed", 10)} ${pad("shards", 7)} ${pad("GB/shard", 9)} ` +
  `${pad("files", 8)} ${pad("min/build", 10)} ${pad("limited by", 11)}`
);

for (const mbs of [15, 30, 61, 100, 200]) {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: mbs * 1e6,
  });
  const minutes = (2 * plan.shardBytes) / (mbs * 1e6) / 60;
  console.log(
    `${pad(`${mbs} MB/s`, 10)} ${pad(plan.shards, 7)} ` +
    `${pad((plan.shardBytes / 1e9).toFixed(2), 9)} ${pad(plan.filesPerShard, 8)} ` +
    `${pad(minutes.toFixed(1), 10)} ${pad(plan.limitedBy, 11)}`
  );
}

// The chosen plan, at a conservative speed, with a worked example.
const plan = planShards({
  tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
});
console.log(`\nchosen: ${plan.shards} shards at a conservative 30 MB/s`);
console.log(`  ${plan.tilePartsPerShard.toLocaleString()} tile parts per shard`);
console.log(`  ${(plan.shardBytes / 1e9).toFixed(2)} GB per shard on disk, limit 20 GB`);
console.log(`  ${plan.filesPerShard.toLocaleString()} files per shard, limit 100,000`);

const layout = {
  headEnd: HEAD_END, tileOffset: TILE_OFFSET, metaOffset: META_OFFSET,
  leafOffset: LEAF_OFFSET, total: TOTAL, tileShard: TILE_SHARD, leafShard: LEAF_SHARD,
  tilePartsPerShard: plan.tilePartsPerShard, shardCount: plan.shards,
};

console.log("\nworked examples, which host serves which read:");
// A tile near the end of the tile section, so the example lands in the last
// shard. Derived from the section bounds rather than sampled, so it is always
// in range even if the archive changes size.
const medianTile = TILE_OFFSET + 63_224 * TILE_SHARD + 978_759;
const cases = [
  ["Protomaps header request", 0, HEAD_END - 1],
  [`a real tile (202 B) at archive byte ${medianTile.toLocaleString()}`, medianTile, medianTile + 201],
  ["the largest leaf directory (150,036 B)", 126_586_196_522, 126_586_196_522 + 150_035],
];
for (const [label, start, end] of cases) {
  const reads = planRequest(start, end, layout);
  const hosts = [...new Set(reads.map((r) => r.host))];
  console.log(`  ${label}`);
  console.log(
    `    ${reads.length} read(s) on host(s) ${hosts.join(", ")}: ` +
    `${reads.map((r) => `${r.path}[${r.offset},+${r.length}]`).join(" ")}`
  );
}

// The boundary case that decides whether the plan is safe.
const boundary = plan.tilePartsPerShard * TILE_SHARD;
console.log(`\nshard boundary at archive byte ${(TILE_OFFSET + boundary).toLocaleString()}`);
for (const [label, start, end] of [
  ["a tile just before it", boundary + TILE_OFFSET - 500, boundary + TILE_OFFSET - 299],
  ["a tile just after it", boundary + TILE_OFFSET, boundary + TILE_OFFSET + 201],
]) {
  const reads = planRequest(start, end, layout);
  console.log(`  ${label}: ${reads.length} read(s), host ${[...new Set(reads.map((r) => r.host))].join(",")}`);
}