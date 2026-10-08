/**
 * Decide how many Workers hold the archive, and where the boundaries fall.
 *
 * The problem: a Workers Builds container has 20 GB of disk and a 20 minute
 * timeout, and the archive is 118 GiB. So one Worker cannot hold it, and one
 * build cannot process it. The archive is split across several Worker asset
 * projects, each holding one contiguous slice, each built by its own build.
 *
 * Splitting reduces the work per build, not the total. What each build does:
 * download its own slice with a Range request, cut it into parts on disk, then
 * let wrangler upload them. So a build moves its slice twice, once down and once
 * up, and holds its slice on disk.
 *
 * Boundaries land on part boundaries, never inside a part. A part belongs to
 * exactly one shard, so the reader never has to join bytes from two hosts for
 * one part, and a tile request always costs one subrequest.
 */

/** Workers Builds gives a build 20 GB of disk and 20 minutes. */
export const BUILD_DISK_BYTES = 20 * 1000_000_000;
export const BUILD_TIMEOUT_SECONDS = 1200;
/** Cloudflare allows 100,000 asset files per Worker version. */
export const FILES_PER_WORKER = 100_000;
/** One asset file may be 25 MiB. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** The Protomaps client never sends a range longer than a leaf directory. */
export const LARGEST_CLIENT_RANGE = 150_036;

/**
 * Keep the disk figure well under the limit, because wrangler also needs room
 * for its own scratch files and the upload staging area. Measured: wrangler
 * stages the manifest and holds a batch of file bodies at once.
 */
const DISK_HEADROOM = 0.55;

/**
 * Work out how many shards to use.
 *
 * @param {object} input
 * @param {number} input.tileParts        how many parts the tile section needs
 * @param {number} input.tileShard        bytes per tile part
 * @param {number} input.leafParts        parts in the leaf directory section
 * @param {number} input.fixedBytes       head + metadata + leaf bytes, all in shard 0
 * @param {number} input.bytesPerSecond   measured throughput to plan for
 * @returns {object} the plan
 */
export function planShards({
  tileParts,
  tileShard,
  leafParts,
  fixedBytes,
  bytesPerSecond,
}) {
  // Each shard holds a whole number of tile parts, so the boundary is always
  // between parts. Rounding up means the last shard is short, never empty.
  const diskLimitPerShard = BUILD_DISK_BYTES * DISK_HEADROOM;

  const count = (() => {
    for (let n = 1; n <= 256; n++) {
      const perShard = Math.ceil(tileParts / n);
      const bytes = perShard * tileShard + fixedBytes;
      if (bytes <= diskLimitPerShard) {
        return { n, perShard, bytes, bound: "disk" };
      }
    }
    throw new Error("even one part per shard does not fit the build disk");
  })();

  // Now check the time budget, and add shards if the disk allowed too few.
  let n = count.n;
  let perShard = count.perShard;
  let bound = count.bound;
  while (n < 256) {
    const bytes = perShard * tileShard + fixedBytes;
    const seconds = (2 * bytes) / bytesPerSecond;
    if (seconds <= BUILD_TIMEOUT_SECONDS * 0.6 && n > count.n) break;
    if (seconds <= BUILD_TIMEOUT_SECONDS * 0.6 && bound === "time") break;
    n++;
    perShard = Math.ceil(tileParts / n);
    if (perShard * tileShard + fixedBytes > diskLimitPerShard) {
      throw new Error("cannot satisfy both the disk limit and the time budget");
    }
    bound = "time";
  }

  const files = perShard + leafParts + 2;
  if (files > FILES_PER_WORKER) {
    throw new Error(
      `${files} files per shard exceeds the ${FILES_PER_WORKER} file limit`
    );
  }

  return {
    shards: n,
    tilePartsPerShard: perShard,
    shardBytes: perShard * tileShard + fixedBytes,
    filesPerShard: files,
    limitedBy: bound,
  };
}

/**
 * The table the snippet needs, and the table the build planner needs.
 *
 * `tilePartsPerShard` is the whole of the routing logic. A tile byte offset
 * becomes a part index, and a part index becomes a shard.
 */
export function routingTable({ shardCount, tilePartsPerShard, tileShard, leafShard, total }) {
  return {
    shardCount,
    tilePartsPerShard,
    tileShard,
    leafShard,
    total,
  };
}

/**
 * Map a byte range in the virtual archive onto the reads that serve it, across
 * hosts. This is the same logic as the snippet, kept here so the plan and the
 * snippet cannot disagree.
 *
 * @param {number} start inclusive
 * @param {number} end inclusive
 * @param {object} layout from readHeader plus the shard table
 * @returns {Array<{host: number, path: string, offset: number, length: number}>}
 */
export function planRequest(start, end, layout) {
  const {
    headEnd, tileOffset, metaOffset, leafOffset, total,
    tileShard, leafShard, tilePartsPerShard, shardCount,
  } = layout;

  if (start < 0 || end >= total || end < start) return [];

  const sections = [
    { kind: "head", start: 0, end: headEnd, shard: 0 },
    { kind: "tile", start: tileOffset, end: metaOffset, shard: tileShard },
    { kind: "meta", start: metaOffset, end: leafOffset, shard: 0 },
    { kind: "leaf", start: leafOffset, end: total, shard: leafShard },
  ];

  const reads = [];
  for (const section of sections) {
    if (section.end <= section.start) continue;
    if (end < section.start || start >= section.end) continue;

    const lo = Math.max(start, section.start) - section.start;
    const hi = Math.min(end, section.end - 1) - section.start;

    if (section.shard === 0 && section.kind !== "leaf") {
      reads.push({
        host: 0,
        path: `${section.kind}.bin`,
        offset: lo,
        length: hi - lo + 1,
      });
      continue;
    }

    const shard = section.shard;
    const first = Math.floor(lo / shard);
    const last = Math.floor(hi / shard);
    if (last - first + 1 > 2) return [];

    for (let index = first; index <= last; index++) {
      const partStart = index * shard;
      const a = Math.max(lo, partStart) - partStart;
      const b = Math.min(hi, partStart + shard - 1) - partStart;
      let host;
      let path;
      if (section.kind === "leaf") {
        // Leaf parts live in shard 0 with the other fixed sections.
        host = 0;
        path = `leaf/${String(index).padStart(6, "0")}.bin`;
      } else {
        // A tile part number gives the shard: parts are whole and evenly
        // distributed, so the division never crosses a part boundary.
        const part = index;
        host = Math.floor(part / tilePartsPerShard);
        path = `tile/${String(part).padStart(6, "0")}.bin`;
      }
      reads.push({ host, path, offset: a, length: b - a + 1 });
    }
  }

  const covered = reads.reduce((sum, read) => sum + read.length, 0);
  if (covered !== end - start + 1) return [];
  if (reads.some((read) => read.host >= shardCount)) return [];
  return reads;
}