/**
 * Tests for split-stream.mjs. Run with: node split-stream.test.mjs
 *
 * The streaming splitter is the part that cannot be verified by eye: it reads a
 * 118 GiB archive through a 20 GB disk, so a byte that lands in the wrong part
 * is a corrupted tile in production. These tests build a small archive, split it
 * with the real code, and check the parts against the source byte for byte.
 */

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  PartUploader, StreamReader, md5, parseHeader, planParts, splitStream,
} from "./split-stream.mjs";

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const HEAD = 16_384;

/** A PMTiles v3 archive with the given section lengths. */
function makeArchive({ tileLength, metaLength, leafLength }) {
  const tileOffset = HEAD;
  const metaOffset = tileOffset + tileLength;
  const leafOffset = metaOffset + metaLength;
  const total = leafOffset + leafLength;

  const header = new Uint8Array(127);
  header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]); // PMTiles
  header[7] = 3;
  const view = new DataView(header.buffer);
  const u64 = (off, value) => view.setBigUint64(off, BigInt(value), true);
  u64(8, 127);
  u64(16, 100);
  u64(24, metaOffset);
  u64(32, metaLength);
  u64(40, leafOffset);
  u64(48, leafLength);
  u64(56, tileOffset);
  u64(64, tileLength);
  header[96] = 1;
  header[97] = 2;
  header[98] = 2;
  header[99] = 1;
  header[100] = 0;
  header[101] = 15;

  const bytes = new Uint8Array(total);
  bytes.set(header, 0);
  // A distinct, position dependent pattern so a misplaced byte is visible.
  for (let i = 0; i < total; i++) {
    if (i >= 127) bytes[i] = (i * 31 + (i >> 7)) & 0xff;
  }
  return { bytes, total, tileOffset, metaOffset, leafOffset };
}

/**
 * Serve a byte range of a buffer, like an origin that honours Range.
 * `chunkSize` controls how the body stream is chopped up.
 */
function rangeServer(bytes, chunkSize = 65536) {
  return async (input, init) => {
    const header = (init?.headers?.range) ?? new Headers(init?.headers).get("range");
    if (header) {
      const m = /bytes=(\d+)-(\d*)/.exec(header);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : bytes.length - 1;
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    return new Response(chunkedStream(bytes, chunkSize), {
      status: 200,
      headers: { "Content-Length": String(bytes.length) },
    });
  };
}

function withServer(bytes, fn, chunkSize = 65536) {
  const real = globalThis.fetch;
  globalThis.fetch = rangeServer(bytes, chunkSize);
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = real;
  });
}

const SMALL = {
  tileLength: 4_999_999,
  metaLength: 1_160,
  leafLength: 350_000,
};
const TILE_SHARD = 2_000_000;
const LEAF_SHARD = 160_000;

/** A ReadableStream over a buffer, with a controllable chunk size. */
function chunkedStream(bytes, chunkSize) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      controller.close();
    },
  });
}

check("parseHeader reads the real archive layout", () => {
  const { bytes, tileOffset, metaOffset, leafOffset } = makeArchive(SMALL);
  const header = parseHeader(bytes.slice(0, 127));
  assert.equal(header.tileDataOffset, tileOffset);
  assert.equal(header.metadataOffset, metaOffset);
  assert.equal(header.leafDirOffset, leafOffset);
  assert.equal(header.maxZoom, 15);
});

check("parseHeader rejects a file that is not PMTiles", () => {
  assert.throws(() => parseHeader(new Uint8Array(127)), /not a PMTiles/);
});

check("parseHeader rejects a version it does not support", () => {
  const { bytes } = makeArchive(SMALL);
  bytes[7] = 2;
  assert.throws(() => parseHeader(bytes.slice(0, 127)), /unsupported version/);
});

check("planParts tiles the archive with no gap", () => {
  const { bytes, total } = makeArchive(SMALL);
  const parts = planParts(parseHeader(bytes.slice(0, 127)), total, TILE_SHARD, LEAF_SHARD);
  let cursor = 0;
  for (const part of parts) {
    assert.equal(part.start, cursor, `gap or overlap before ${part.name}`);
    cursor += part.length;
  }
  assert.equal(cursor, total, "parts must cover the whole archive");
});

check("planParts produces the same count as the file split", () => {
  const { bytes, total } = makeArchive(SMALL);
  const header = parseHeader(bytes.slice(0, 127));
  const parts = planParts(header, total, TILE_SHARD, LEAF_SHARD);
  const tile = parts.filter((p) => p.name.startsWith("tile/"));
  const leaf = parts.filter((p) => p.name.startsWith("leaf/"));
  assert.equal(tile.length, Math.ceil(header.tileDataLength / TILE_SHARD));
  assert.equal(leaf.length, Math.ceil(header.leafDirLength / LEAF_SHARD));
  assert.equal(parts.filter((p) => p.name === "head.bin").length, 1);
  assert.equal(parts.filter((p) => p.name === "meta.bin").length, 1);
});

check("planParts refuses a layout with a gap", () => {
  const { bytes, total } = makeArchive(SMALL);
  const header = parseHeader(bytes.slice(0, 127));
  header.tileDataLength -= 5; // leaves a hole
  assert.throws(
    () => planParts(header, total, TILE_SHARD, LEAF_SHARD),
    /belong to no section|sections end at/
  );
});

check("planParts refuses a layout that stops short", () => {
  const { bytes, total } = makeArchive(SMALL);
  const header = parseHeader(bytes.slice(0, 127));
  header.leafDirLength -= 5;
  assert.throws(() => planParts(header, total, TILE_SHARD, LEAF_SHARD), /sections end at/);
});

await checkAsync("the streamed parts match the archive byte for byte", async () => {
  const { bytes, total } = makeArchive(SMALL);
  await withServer(bytes, async () => {
    const seen = new Map();
    await splitStream("https://example.test/a.pmtiles", {
      tileShard: TILE_SHARD,
      leafShard: LEAF_SHARD,
      onPart: async (part, data) => {
        assert.equal(data.length, part.length, `${part.name} length`);
        seen.set(part.name, data);
      },
    });
    const header = parseHeader(bytes.slice(0, 127));
    const parts = planParts(header, total, TILE_SHARD, LEAF_SHARD);
    assert.equal(seen.size, parts.length);
    for (const part of parts) {
      const got = seen.get(part.name);
      assert.ok(got, `${part.name} was not produced`);
      const expected = bytes.subarray(part.start, part.start + part.length);
      assert.ok(
        Buffer.from(got).equals(Buffer.from(expected)),
        `${part.name} does not match the archive`
      );
    }
  });
});

await checkAsync("a stream with awkward chunk sizes still reads correctly", async () => {
  const { bytes } = makeArchive({ tileLength: 300_000, metaLength: 100, leafLength: 50_000 });
  // Chunk sizes that share no common factor with the part boundaries. A
  // splitter that assumed chunk alignment would corrupt parts here.
  for (const chunkSize of [1, 7, 997, 131_071]) {
    const parts = new Map();
    await withServer(bytes, async () => {
      await splitStream("https://example.test/a.pmtiles", {
        tileShard: 131_072,
        leafShard: 16_384,
        onPart: async (part, data) => parts.set(part.name, data),
      });
    }, chunkSize);
    const header = parseHeader(bytes.slice(0, 127));
    const plan = planParts(header, bytes.length, 131_072, 16_384);
    for (const part of plan) {
      const expected = bytes.subarray(part.start, part.start + part.length);
      assert.ok(
        Buffer.from(parts.get(part.name)).equals(Buffer.from(expected)),
        `${part.name} is wrong with chunk size ${chunkSize}`
      );
    }
  }
});

await checkAsync("a short stream fails loudly instead of shipping a short part", async () => {
  const { bytes, total } = makeArchive(SMALL);
  // Claim the full size in Content-Range but send fewer bytes, which is what a
  // truncated download looks like.
  const real = globalThis.fetch;
  const server = rangeServer(bytes);
  globalThis.fetch = async (input, init) => {
    const response = await server(input, init);
    const range = new Headers(init?.headers).get("range");
    if (!range) {
      return new Response(chunkedStream(bytes.subarray(0, total - 100_000), 65536), {
        status: 200,
        headers: { "Content-Length": String(total) },
      });
    }
    return response;
  };
  try {
    await assert.rejects(
      splitStream("https://example.test/a.pmtiles", {
        tileShard: TILE_SHARD,
        leafShard: LEAF_SHARD,
        onPart: async () => {},
      }),
      /ended .* bytes short|streamed .* bytes/
    );
  } finally {
    globalThis.fetch = real;
  }
});

await checkAsync("StreamReader takes exact ranges", async () => {
  const source = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) source[i] = i & 0xff;
  for (const chunkSize of [1, 13, 97, 1000, 4096]) {
    const reader = new StreamReader(chunkedStream(source, chunkSize), 1000);
    const a = await reader.read(10);
    assert.deepEqual([...a], [...source.subarray(0, 10)], `read(10) at chunk ${chunkSize}`);
    await reader.skipTo(500);
    const b = await reader.read(5);
    assert.deepEqual([...b], [...source.subarray(500, 505)], `read(5) at chunk ${chunkSize}`);
  }
});

await checkAsync("StreamReader refuses to read past the end", async () => {
  const reader = new StreamReader(chunkedStream(new Uint8Array(10), 4), 10);
  await assert.rejects(reader.read(20), /short at 0 of 10|ended/);
});

await checkAsync("StreamReader refuses to seek backwards", async () => {
  const reader = new StreamReader(chunkedStream(new Uint8Array(100), 10), 100);
  await reader.read(50);
  await assert.rejects(reader.skipTo(10), /cannot seek backwards/);
});

check("md5 matches a known value", () => {
  assert.equal(md5(new TextEncoder().encode("")), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5(new TextEncoder().encode("abc")), "900150983cd24fb0d6963f7d28e17f72");
});

await checkAsync("PartUploader sends only the files Cloudflare asks for", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers ? new Headers(init.headers) : {},
    });
    if (String(url).includes("assets-upload-session")) {
      // Cloudflare omits the unchanged hash from `buckets`. Read the manifest
      // that was sent and return every hash except the last, which stands for a
      // file Cloudflare already holds.
      const sent = JSON.parse(init.body).manifest;
      const hashes = Object.values(sent).map((v) => v.hash);
      return new Response(JSON.stringify({
        success: true,
        result: { jwt: "test-jwt", buckets: [hashes.slice(0, -1)] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true, result: { jwt: "done" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    // Cloudflare matches on the real content hash, so the test must too.
    const a = new Uint8Array(10).fill(1);
    const b = new Uint8Array(10).fill(2);
    const c = new Uint8Array(10).fill(3);
    const ha = md5(a);
    const hb = md5(b);
    const hc = md5(c);

    const uploader = new PartUploader("token", "/accounts/a/workers/scripts/w", 2);
    const wanted = await uploader.start({
      "/s/n/head.bin": { hash: ha, size: 10 },
      "/s/n/tile/000000.bin": { hash: hb, size: 10 },
      "/s/n/tile/000001.bin": { hash: hc, size: 10 },
    });
    assert.equal(wanted, 2, "only two hashes are new");

    // Batch size 2, so the first two queue and flush, and the third is skipped
    // because Cloudflare already has it.
    await uploader.add("/s/n/head.bin", a);
    await uploader.add("/s/n/tile/000000.bin", b);
    assert.equal(uploader.pending.length, 0, "a full batch should have flushed");
    assert.equal(uploader.uploaded, 2);
    await uploader.add("/s/n/tile/000001.bin", c);
    assert.equal(uploader.pending.length, 0, "the unchanged file must not be queued");
    assert.equal(uploader.skipped, 1);

    await uploader.finish();
    const uploads = calls.filter((c) => c.url.includes("/assets/upload"));
    assert.equal(uploads.length, 2, "one batch plus the completion call");
    // The path must not double the API prefix.
    for (const call of calls) {
      assert.ok(
        !call.url.includes("/client/v4/client/v4"),
        `doubled API prefix in ${call.url}`
      );
    }
    assert.match(uploads[0].url, /base64=true/);
    assert.equal(uploads[0].headers.get("Authorization"), "Bearer test-jwt");
  } finally {
    globalThis.fetch = original;
  }
});

await checkAsync("PartUploader reports an API error rather than continuing", async () => {
  const one = new Uint8Array([7]);
  const original = globalThis.fetch;
  let session = false;
  globalThis.fetch = async (url) => {
    if (!session) {
      session = true;
      return new Response(JSON.stringify({
        success: true, result: { jwt: "j", buckets: [[md5(one)]] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      success: false, errors: [{ code: 1, message: "nope" }],
    }), { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    // Batch size 1, so the add flushes immediately and hits the API error.
    const uploader = new PartUploader("token", "/accounts/a/workers/scripts/w", 1);
    await uploader.start({ "/s/n/a.bin": { hash: md5(one), size: 1 } });
    await assert.rejects(uploader.add("/s/n/a.bin", one), /part upload failed.*nope/s);
  } finally {
    globalThis.fetch = original;
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);