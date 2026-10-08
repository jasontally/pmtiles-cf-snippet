/**
 * Tests for the shard plan. Run with: node shard-plan.test.mjs
 *
 * The plan decides which Worker holds which byte of a 118 GiB archive. A wrong
 * shard number sends a tile request to a host that does not have the bytes, and
 * the reader returns 502 instead of a tile. These tests pin the routing.
 */

import assert from "node:assert/strict";
import {
  BUILD_DISK_BYTES, FILES_PER_WORKER, planRequest, planShards,
} from "./shard-plan.mjs";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

// The real archive, measured 2026-10-08.
const TILE_OFFSET = 16_384;
const TILE_LENGTH = 126_450_529_397;
const META_OFFSET = 126_450_545_781;
const META_LENGTH = 1_160;
const LEAF_OFFSET = 126_450_546_941;
const LEAF_LENGTH = 324_922_066;
const TOTAL = 126_775_469_007;
const TILE_SHARD = 2_000_000;
const LEAF_SHARD = 160_000;

const tileParts = Math.ceil(TILE_LENGTH / TILE_SHARD);
const leafParts = Math.ceil(LEAF_LENGTH / LEAF_SHARD);
const fixedBytes = 16_384 + META_LENGTH + LEAF_LENGTH;

function layoutFor(shardCount, tilePartsPerShard) {
  return {
    headEnd: 16_384,
    tileOffset: TILE_OFFSET,
    metaOffset: META_OFFSET,
    leafOffset: LEAF_OFFSET,
    total: TOTAL,
    tileShard: TILE_SHARD,
    leafShard: LEAF_SHARD,
    tilePartsPerShard,
    shardCount,
  };
}

check("the plan satisfies the disk limit at every speed", () => {
  for (const mbs of [10, 15, 30, 61, 100, 500]) {
    const plan = planShards({
      tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes,
      bytesPerSecond: mbs * 1e6,
    });
    assert.ok(
      plan.shardBytes <= BUILD_DISK_BYTES,
      `at ${mbs} MB/s a shard is ${plan.shardBytes} bytes, over the disk limit`
    );
  }
});

check("the plan satisfies the file limit at every speed", () => {
  for (const mbs of [10, 30, 61, 200]) {
    const plan = planShards({
      tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes,
      bytesPerSecond: mbs * 1e6,
    });
    assert.ok(
      plan.filesPerShard <= FILES_PER_WORKER,
      `at ${mbs} MB/s a shard has ${plan.filesPerShard} files`
    );
  }
});

check("every tile part is assigned to exactly one shard, and all are covered", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);

  // The union of shard byte ranges must cover the tile section with no gap and
  // no overlap, and no part may be split between two shards.
  //
  // Note the end is the end of the last part, not META_OFFSET. The section holds
  // 63,225 whole parts and a final part of 529,397 bytes, so rounding the part
  // count up overshoots the metadata offset by the shortfall. That is fine: the
  // final part is short on disk, so the bytes still stop at META_OFFSET.
  const coveredEnd = TILE_OFFSET + tileParts * TILE_SHARD;
  assert.ok(
    coveredEnd >= META_OFFSET,
    `the parts should reach the metadata offset: ${coveredEnd} < ${META_OFFSET}`
  );

  let cursor = TILE_OFFSET;
  for (let shard = 0; shard < plan.shards; shard++) {
    const firstPart = shard * plan.tilePartsPerShard;
    if (firstPart >= tileParts) break;
    const lastPart = Math.min(firstPart + plan.tilePartsPerShard, tileParts) - 1;
    const start = TILE_OFFSET + firstPart * TILE_SHARD;
    const end = TILE_OFFSET + (lastPart + 1) * TILE_SHARD;
    assert.equal(start, cursor, `shard ${shard} starts at ${start}, expected ${cursor}`);
    cursor = end;

    // A tile in the middle of this shard's range must route here.
    const probe = TILE_OFFSET + (firstPart + Math.floor((lastPart - firstPart) / 2)) * TILE_SHARD;
    const reads = planRequest(probe, probe + 201, layout);
    assert.equal(reads.length, 1, `a tile in shard ${shard} used ${reads.length} reads`);
    assert.equal(reads[0].host, shard, `tile at ${probe} routed to host ${reads[0].host}`);
  }
  assert.equal(
    cursor,
    coveredEnd,
    `shards cover up to ${cursor}, expected ${coveredEnd}`
  );
});

check("a tile request never needs more than 2 subrequests", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);

  // Real tile sizes from the archive: median 202, p99 754, max 6873.
  for (const length of [1, 202, 754, 6_873]) {
    // Walk every part boundary, which is where a straddle would show up.
    for (let part = 0; part < tileParts; part += 997) {
      const base = TILE_OFFSET + part * TILE_SHARD;
      for (const offsetIn of [0, 1, 1_000_000, TILE_SHARD - length - 1, TILE_SHARD - length]) {
        const start = base + offsetIn;
        const reads = planRequest(start, start + length - 1, layout);
        assert.ok(
          reads.length > 0 && reads.length <= 2,
          `tile at part ${part}+${offsetIn} used ${reads.length} reads`
        );
      }
    }
  }
});

check("a leaf directory request never needs more than 2 subrequests", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);
  // Leaf directories run to 150,036 bytes and live in shard 0.
  for (const length of [5_234, 111_389, 150_036]) {
    for (const offsetIn of [0, 80_000, LEAF_SHARD - length]) {
      const start = LEAF_OFFSET + offsetIn;
      const reads = planRequest(start, start + length - 1, layout);
      assert.ok(
        reads.length > 0 && reads.length <= 2,
        `leaf at +${offsetIn} of length ${length} used ${reads.length} reads`
      );
      for (const read of reads) {
        assert.equal(read.host, 0, "leaf parts must all live in shard 0");
      }
    }
  }
});

check("the header request is one read on shard 0", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);
  const reads = planRequest(0, 16_383, layout);
  assert.deepEqual(reads, [{ host: 0, path: "head.bin", offset: 0, length: 16_384 }]);
});

check("the metadata request is one read on shard 0", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);
  const reads = planRequest(META_OFFSET, META_OFFSET + META_LENGTH - 1, layout);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].path, "meta.bin");
  assert.equal(reads[0].host, 0);
});

check("a range that spans a shard boundary uses 2 reads on 2 hosts", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);
  // Start just before the boundary and end just after it.
  const boundary = TILE_OFFSET + plan.tilePartsPerShard * TILE_SHARD;
  const reads = planRequest(boundary - 100, boundary + 100, layout);
  assert.equal(reads.length, 2, `expected 2 reads, got ${reads.length}`);
  const hosts = new Set(reads.map((r) => r.host));
  assert.equal(hosts.size, 2, `expected 2 hosts, got ${[...hosts]}`);
  assert.ok(hosts.has(0) && hosts.has(1), `hosts were ${[...hosts]}`);
});

check("a range is never served from a host that does not exist", () => {
  const plan = planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes, bytesPerSecond: 30e6,
  });
  const layout = layoutFor(plan.shards, plan.tilePartsPerShard);
  for (let part = 0; part < tileParts; part += 313) {
    const start = TILE_OFFSET + part * TILE_SHARD;
    const reads = planRequest(start, start + 100, layout);
    assert.ok(reads.length > 0, `part ${part} produced no reads`);
    for (const read of reads) {
      assert.ok(
        read.host >= 0 && read.host < plan.shards,
        `part ${part} routed to host ${read.host}, plan has ${plan.shards}`
      );
    }
  }
});

check("an unsatisfiable range produces no reads", () => {
  const layout = layoutFor(13, 4864);
  assert.deepEqual(planRequest(-1, 100, layout), []);
  assert.deepEqual(planRequest(0, TOTAL, layout), []);
  assert.deepEqual(planRequest(100, 50, layout), []);
  assert.deepEqual(planRequest(TOTAL, TOTAL + 10, layout), []);
});

check("a range that would span 3 tile parts is refused", () => {
  const layout = layoutFor(13, 4864);
  // 3 whole tile parts is 6 MB, which no real client asks for, and it would
  // mean 3 subrequests. The plan must refuse rather than exceed the budget.
  const start = TILE_OFFSET + 100;
  assert.deepEqual(planRequest(start, start + 3 * TILE_SHARD, layout), []);
});

check("a slower assumed speed asks for more shards, never fewer", () => {
  const at = (mbs) => planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes,
    bytesPerSecond: mbs * 1e6,
  }).shards;
  const fast = at(200);
  const slow = at(15);
  assert.ok(slow >= fast, `15 MB/s gave ${slow} shards, 200 MB/s gave ${fast}`);
});

check("shard count is the same for every speed above the disk floor", () => {
  const counts = [30, 61, 100, 200, 500].map((mbs) => planShards({
    tileParts, tileShard: TILE_SHARD, leafParts, fixedBytes,
    bytesPerSecond: mbs * 1e6,
  }).shards);
  assert.equal(
    new Set(counts).size,
    1,
    `the count should not depend on speed above the floor, got ${counts}`
  );
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);