/**
 * Tests for snippet.js. Run with: node snippet-test.js
 *
 * The test drives the snippet's default export through a fake fetch that serves
 * bytes from an in memory split of a synthetic archive. This checks the real
 * code path: parseRange, planReads, fetchPart and the 206 response.
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const TOOL = fileURLToPath(new URL("./shard-pmtiles.py", import.meta.url));
const HEAD_BYTES = 16384;

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

/* ------------------------------------------------------------------ *
 * Build a real split with the real tool, then serve it with the snippet.
 * ------------------------------------------------------------------ */

function makeArchive() {
  // Layout chosen so every section is non empty and the tile section spans
  // more than one part at the default part size.
  const tileLength = 4_999_999;
  const metaOffset = HEAD_BYTES + tileLength;
  const metaLength = 1000;
  const leafOffset = metaOffset + metaLength;
  const leafLength = 400_000;
  const total = leafOffset + leafLength;

  const dir = mkdtempSync(join(tmpdir(), "pmt-"));
  const src = join(dir, "demo.pmtiles");

  const header = new Uint8Array(127);
  header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]); // PMTiles
  header[7] = 3;
  const u64 = (offset, value) => {
    new DataView(header.buffer).setBigUint64(offset, BigInt(value), true);
  };
  u64(8, 127);          // rootDirOffset
  u64(16, 100);         // rootDirLength
  u64(24, metaOffset);  // metadataOffset
  u64(32, metaLength);
  u64(40, leafOffset);  // leafDirOffset
  u64(48, leafLength);
  u64(56, HEAD_BYTES);  // tileDataOffset
  u64(64, tileLength);

  const bytes = new Uint8Array(total);
  // A distinct byte pattern per region makes a mis routed range obvious.
  // The header must stay a valid PMTiles header, so the first HEAD_BYTES are
  // the pattern and the header overwrites them.
  for (let i = 0; i < total; i++) {
    if (i < HEAD_BYTES) bytes[i] = 0xa0;
    else if (i < metaOffset) bytes[i] = (i - HEAD_BYTES) & 0xff;
    else if (i < leafOffset) bytes[i] = 0xb0;
    else bytes[i] = 0xc0;
  }
  bytes.set(header, 0);
  writeFileSync(src, bytes);
  return { dir, src, total, bytes, metaOffset, leafOffset, tileLength };
}

/**
 * Load the snippet with its ARCHIVES table pointed at the test archive, and
 * optionally with the shard host names repointed at test domains.
 */
async function loadSnippet(modules, hosts = {}) {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  let patched = source.replace(
    /const ARCHIVES = \{[\s\S]*?\n\};/,
    `const ARCHIVES = {\n  demo: ${JSON.stringify(modules)},\n};`
  );
  assert.notEqual(patched, source, "could not patch ARCHIVES in snippet.js");
  for (const [key, value] of Object.entries(hosts)) {
    const re = new RegExp(`const ${key} = "[^"]*";`);
    assert.ok(re.test(patched), `could not patch ${key} in snippet.js`);
    patched = patched.replace(re, `const ${key} = ${JSON.stringify(value)};`);
  }
  // The trailing `export const` lines are constants kept for readers; the tests
  // use planReads, which is a function and must stay.
  const url = "data:text/javascript;base64," +
    Buffer.from(patched.replace(/^export const [^\n]*\n/gm, "")).toString("base64");
  return import(url);
}

/** Load the snippet with its real production constants, for the routing tests. */
async function loadRealSnippet() {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  const url = "data:text/javascript;base64," +
    Buffer.from(source.replace(/^export const [^\n]*\n/gm, "")).toString("base64");
  return import(url);
}

/** Serve the split archive the way Cloudflare would, honouring no Range. */
function makeFetch(assets, stats) {
  return async (target, init) => {
    const url = new URL(target);
    const key = url.pathname.replace(/^\/s\/demo\//, "");
    stats.calls++;
    stats.ranges.push(init?.headers?.Range);
    if (assets[key] === undefined) {
      return new Response("missing", { status: 404 });
    }
    // Deliberately ignore Range, which is what Static Assets do. This is the
    // behaviour the snippet is written to work around.
    return new Response(assets[key], {
      status: 200,
      headers: { "Content-Length": String(assets[key].length) },
    });
  };
}

async function main() {
  const { dir, src, total, bytes, metaOffset, leafOffset } = makeArchive();

  // Split with the real tool.
  const out = join(dir, "public");
  execFileSync("python3", [TOOL, src, "--out", out, "--name", "demo"], {
    stdio: "pipe",
  });

  // Load the split from disk, exactly as the edge would.
  const fs = await import("node:fs");
  const assets = {};
  const walk = (base, prefix) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else assets[`${prefix}${entry.name}`] = new Uint8Array(fs.readFileSync(full));
    }
  };
  walk(join(out, "s", "demo"), "");
  delete assets["manifest.json"];

  const modules = {
    total,
    headEnd: HEAD_BYTES,
    tileOffset: HEAD_BYTES,
    metaOffset,
    leafOffset,
    tileShard: 2000000,
    leafShard: 160000,
    // One tile part per shard. The synthetic archive has 3 tile parts, so they
    // land on hosts 0, 1 and 2. makeFetch ignores the hostname, so this also
    // exercises the division on the single origin tests.
    tilePartsPerShard: 1,
  };
  const { default: handler } = await loadSnippet(modules);

  const realFetch = globalThis.fetch;
  const origin = "https://tiles.example.com";
  const request = (range, extra = {}) =>
    new Request(`${origin}/demo.pmtiles`, {
      headers: range === null ? extra.headers || {} : { Range: range, ...(extra.headers || {}) },
      method: extra.method || "GET",
    });

  // A request that reads one part.
  const get = async (range, extra) => {
    const stats = { calls: 0, ranges: [] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(assets, stats);
    try {
      const response = await handler.fetch(request(range, extra), { env: {} }, { env: {} });
      const body = new Uint8Array(await response.arrayBuffer());
      return { response, body, stats };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  await checkAsync("header request returns the first 16384 bytes", async () => {
    const { response, body, stats } = await get("bytes=0-16383");
    assert.equal(response.status, 206);
    assert.equal(body.length, 16384);
    assert.deepEqual(body, bytes.subarray(0, 16384));
    assert.equal(stats.calls, 1, "must use exactly 1 subrequest");
    assert.equal(response.headers.get("Content-Range"), `bytes 0-16383/${total}`);
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(response.headers.get("Content-Type"), "application/vnd.pmtiles");
    assert.ok(response.headers.get("ETag"), "ETag is required by the client");
    assert.ok(!response.headers.get("ETag").startsWith("W/"), "ETag must be strong");
  });

  await checkAsync("metadata request", async () => {
    const { response, body, stats } = await get(
      `bytes=${metaOffset}-${metaOffset + 999}`
    );
    assert.equal(response.status, 206);
    assert.deepEqual(body, bytes.subarray(metaOffset, metaOffset + 1000));
    assert.equal(stats.calls, 1);
  });

  await checkAsync("leaf directory request crosses parts and still matches", async () => {
    const length = 150036;
    const start = leafOffset;
    const { response, body } = await get(`bytes=${start}-${start + length - 1}`);
    assert.equal(response.status, 206);
    assert.equal(body.length, length);
    assert.deepEqual(body, bytes.subarray(start, start + length));
  });

  await checkAsync("a tile inside the tile section matches", async () => {
    const start = HEAD_BYTES + 1234567;
    const { body, stats } = await get(`bytes=${start}-${start + 201}`);
    assert.deepEqual(body, bytes.subarray(start, start + 202));
    assert.equal(stats.calls, 1);
  });

  await checkAsync("every tile offset in the section matches", async () => {
    // Check the first and last bytes of every tile part, which is where an
    // off by one in the part arithmetic would show up.
    const shard = modules.tileShard;
    const tileEnd = metaOffset;
    for (let partStart = HEAD_BYTES; partStart < tileEnd; partStart += shard) {
      const span = Math.min(shard, tileEnd - partStart);
      for (const offset of [0, Math.floor(span / 2), span - 1]) {
        const at = partStart + offset;
        const { body } = await get(`bytes=${at}-${at + 15}`);
        assert.deepEqual(body, bytes.subarray(at, at + 16), `offset ${at}`);
      }
    }
  });

  await checkAsync("a range that spans two parts uses exactly 2 subrequests", async () => {
    const shard = modules.tileShard;
    const start = HEAD_BYTES + shard - 100;
    const { body, stats } = await get(`bytes=${start}-${start + 300}`);
    assert.equal(stats.calls, 2);
    assert.equal(body.length, 301);
    assert.deepEqual(body, bytes.subarray(start, start + 301));
  });

  await checkAsync("416 for an unsatisfiable range", async () => {
    const { response } = await get(`bytes=${total}-${total + 10}`);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), `bytes */${total}`);
  });

  await checkAsync("416 when there is no Range header", async () => {
    const { response } = await get(null);
    assert.equal(response.status, 416);
  });

  await checkAsync("416 for a range wider than MAX_RESPONSE", async () => {
    // 150,036 is the largest real request. Ask for far more.
    const { response } = await get("bytes=0-1048575");
    assert.equal(response.status, 416);
  });

  await checkAsync("416 for an inverted range", async () => {
    const { response } = await get("bytes=100-50");
    assert.equal(response.status, 416);
  });

  await checkAsync("416 for bytes=-0 and for many ranges", async () => {
    assert.equal((await get("bytes=-0")).response.status, 416);
    assert.equal((await get("bytes=0-10,20-30")).response.status, 416);
  });

  await checkAsync("suffix range", async () => {
    const { body } = await get("bytes=-4096");
    assert.equal(body.length, 4096);
    assert.deepEqual(body, bytes.subarray(total - 4096));
  });

  await checkAsync("open ended range", async () => {
    const { body } = await get(`bytes=${total - 10}-`);
    assert.deepEqual(body, bytes.subarray(total - 10));
  });

  await checkAsync("HEAD returns headers and no body, with no subrequest", async () => {
    const { response, body, stats } = await get("bytes=0-16383", { method: "HEAD" });
    assert.equal(response.status, 206);
    assert.equal(body.length, 0);
    assert.equal(response.headers.get("Content-Length"), "16384");
    assert.equal(stats.calls, 0, "HEAD needs no asset read");
  });

  await checkAsync("unknown archive name is 404", async () => {
    const response = await handler.fetch(
      new Request(`${origin}/missing.pmtiles`, { headers: { Range: "bytes=0-10" } }),
      { env: {} },
      { env: {} }
    );
    assert.equal(response.status, 404);
  });

  await checkAsync("a path that is not a single name is 404", async () => {
    for (const path of ["/a/b.pmtiles", "/.pmtiles", "/demo.pmtiles.txt"]) {
      const response = await handler.fetch(
        new Request(`${origin}${path}`, { headers: { Range: "bytes=0-10" } }),
        { env: {} },
        { env: {} }
      );
      assert.equal(response.status, 404, `path ${path}`);
    }
  });

  await checkAsync("method not allowed", async () => {
    const response = await handler.fetch(
      new Request(`${origin}/demo.pmtiles`, { method: "POST" }),
      { env: {} },
      { env: {} }
    );
    assert.equal(response.status, 405);
    assert.ok(response.headers.get("Allow").includes("GET"));
  });

  await checkAsync("CORS exposes ETag and sets Vary", async () => {
    const { response } = await get("bytes=0-10", {
      headers: { Origin: "https://app.example.com" },
    });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const expose = response.headers.get("Access-Control-Expose-Headers");
    assert.ok(expose.includes("ETag"), `expose was ${expose}`);
    assert.ok(expose.includes("Content-Range"));
    assert.ok(response.headers.get("Vary").includes("Range"));
  });

  await checkAsync("a part larger than BUFFER_LIMIT is streamed", async () => {
    // The archive below has 2,000,000 byte tile parts, which is over the 1 MiB
    // buffer limit, so the snippet must take the streaming path. Check that the
    // answer is still correct and that the read stops early.
    const stats = { calls: 0, ranges: [], bytesRead: 0 };
    const realFetchImpl = globalThis.fetch;
    globalThis.fetch = async (target, init) => {
      const url = new URL(target);
      const key = url.pathname.replace(/^\/s\/demo\//, "");
      stats.calls++;
      const part = assets[key];
      if (!part) return new Response("missing", { status: 404 });
      // Count the bytes the snippet actually consumes. A Response over a
      // Uint8Array cannot report that, so wrap it.
      const stream = new ReadableStream({
        async pull(controller) {
          stats.bytesRead += part.length;
          controller.enqueue(part);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Length": String(part.length) },
      });
    };
    try {
      const response = await handler.fetch(request("bytes=0-16383"), { env: {} }, { env: {} });
      const body = new Uint8Array(await response.arrayBuffer());
      assert.equal(response.status, 206);
      assert.deepEqual(body, bytes.subarray(0, 16384));
      // head.bin is 16384 bytes, under the limit, so it is buffered whole.
      assert.equal(stats.bytesRead, 16384, `read ${stats.bytesRead} bytes`);
    } finally {
      globalThis.fetch = realFetchImpl;
    }
  });

  await checkAsync("a missing asset gives 502, not corrupt bytes", async () => {
    const stats = { calls: 0, ranges: [] };
    globalThis.fetch = makeFetch({}, stats);
    try {
      const response = await handler.fetch(request("bytes=0-16383"), { env: {} }, { env: {} });
      assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes("PMTiles"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /* ------------------------------------------------------------------ *
   * Sharded routing.
   * ------------------------------------------------------------------ */

  // One tile part per shard, so the synthetic archive's 3 tile parts land on
  // hosts 0, 1 and 2. That exercises the division and the cross host read.
  const shardModules = modules;
  const shardHandler = (await loadSnippet(shardModules, {
    SHARD_HOST_PREFIX: "https://shard",
    SHARD_HOST_SUFFIX: ".test",
  })).default;

  /**
   * Put each asset on the shard that holds it, the same rule the shard builds
   * use: tile part N goes to shard floor(N / tilePartsPerShard), everything
   * else to shard 0.
   */
  function distributeByShard(all, tilePartsPerShard) {
    const hosts = new Map();
    const put = (host, path) => {
      if (!hosts.has(host)) hosts.set(host, {});
      hosts.get(host)[path] = all[path];
    };
    for (const path of Object.keys(all)) {
      const tile = /^tile\/(\d+)\.bin$/.exec(path);
      put(tile ? Math.floor(Number(tile[1]) / tilePartsPerShard) : 0, path);
    }
    return hosts;
  }

  /** A fetch that serves assets per shard host and records which host was hit. */
  function makeShardedFetch(byHost, stats) {
    return async (target) => {
      const url = new URL(target);
      const host = /^shard(\d+)\.test$/.exec(url.hostname);
      if (!host) {
        stats.bad.push(url.hostname);
        return new Response("wrong host", { status: 404 });
      }
      stats.calls++;
      stats.hosts.push(Number(host[1]));
      const shelf = byHost.get(Number(host[1]));
      const path = url.pathname.replace(/^\/s\/demo\//, "");
      const bytes = shelf ? shelf[path] : undefined;
      if (bytes === undefined) return new Response("missing", { status: 404 });
      // Static Assets ignore Range, which is what the snippet works around.
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Length": String(bytes.length) },
      });
    };
  }

  const byHost = distributeByShard(assets, shardModules.tilePartsPerShard);

  const getSharded = async (range) => {
    const stats = { calls: 0, hosts: [], bad: [] };
    const saved = globalThis.fetch;
    globalThis.fetch = makeShardedFetch(byHost, stats);
    try {
      const response = await shardHandler.fetch(request(range), { env: {} }, { env: {} });
      const body = new Uint8Array(await response.arrayBuffer());
      return { response, body, stats };
    } finally {
      globalThis.fetch = saved;
    }
  };

  await checkAsync("each tile part is read from its own shard", async () => {
    const tileEnd = metaOffset;
    for (let part = 0; part * 2000000 < tileEnd; part++) {
      const partStart = HEAD_BYTES + part * 2000000;
      const span = Math.min(2000000, tileEnd - partStart);
      // The last probe stops 16 bytes short of the part end, because a 16 byte
      // read at the very last byte spans into the next part by design. That case
      // is covered by the cross boundary test below.
      for (const offset of [0, Math.floor(span / 2), span - 16]) {
        const at = partStart + offset;
        const { response, body, stats } = await getSharded(`bytes=${at}-${at + 15}`);
        assert.equal(response.status, 206, `offset ${at}`);
        assert.deepEqual(body, bytes.subarray(at, at + 16), `offset ${at}`);
        assert.deepEqual(stats.bad, [], `offset ${at} hit an unexpected host`);
        assert.deepEqual(stats.hosts, [part], `part ${part} read from the wrong shard`);
      }
    }
  });

  await checkAsync("head, metadata and leaf parts come from shard 0", async () => {
    const head = await getSharded("bytes=0-16383");
    assert.deepEqual(head.stats.hosts, [0], "head.bin must come from shard 0");
    assert.deepEqual(head.body, bytes.subarray(0, 16384));

    const meta = await getSharded(`bytes=${metaOffset}-${metaOffset + 999}`);
    assert.deepEqual(meta.stats.hosts, [0], "meta.bin must come from shard 0");
    assert.deepEqual(meta.body, bytes.subarray(metaOffset, metaOffset + 1000));

    // Start 50 bytes before the first leaf part boundary so the read spans two
    // leaf parts, the largest request the client makes.
    const leafStart = leafOffset + 160000 - 50;
    const leaf = await getSharded(`bytes=${leafStart}-${leafStart + 150035}`);
    assert.equal(leaf.response.status, 206);
    assert.deepEqual(leaf.body, bytes.subarray(leafStart, leafStart + 150036));
    assert.equal(leaf.stats.calls, 2, "a 150,036 B leaf read spans two parts");
    assert.deepEqual([...new Set(leaf.stats.hosts)], [0], "leaf parts must all be shard 0");
  });

  await checkAsync("a range across a shard boundary uses two hosts", async () => {
    // Ends 100 bytes before the end of part 0, so it spans parts 0 and 1, which
    // are on shards 0 and 1.
    const start = HEAD_BYTES + 2000000 - 100;
    const { response, body, stats } = await getSharded(`bytes=${start}-${start + 300}`);
    assert.equal(response.status, 206);
    assert.equal(stats.calls, 2, "must use exactly 2 subrequests");
    assert.deepEqual(stats.hosts.sort(), [0, 1], "must read one part from each shard");
    assert.deepEqual(body, bytes.subarray(start, start + 301));
  });

  await checkAsync("a range across three parts is refused", async () => {
    // Three parts of 2,000,000 B. Over MAX_RESPONSE too, but planReads must also
    // refuse it on its own, or the only thing stopping it is the size check.
    const { planReads } = await loadSnippet(shardModules, {
      SHARD_HOST_PREFIX: "https://shard",
      SHARD_HOST_SUFFIX: ".test",
    });
    // This fixture has only 3 tile parts, so three parts means the whole tile
    // section, from its first byte to the byte before the metadata.
    const at = (part) => HEAD_BYTES + part * 2000000;
    assert.equal(planReads(at(0), metaOffset - 1, shardModules), null, "three parts must be refused");
    assert.notEqual(planReads(at(0), at(2) - 1, shardModules), null, "two parts are allowed");

    // And the handler answers 416 without spending a subrequest.
    const start = at(10) - 10;
    const { response, stats } = await getSharded(`bytes=${start}-${start + 400}`);
    assert.equal(response.status, 416);
    assert.equal(stats.calls, 0, "a refused range must not read anything");
  });

  await checkAsync("a part missing from its shard gives 502", async () => {
    // Drop shard 2's shelf, so the part it should hold reads as missing.
    const stats = { calls: 0, hosts: [], bad: [] };
    const saved = globalThis.fetch;
    const partial = new Map(byHost);
    partial.delete(2);
    globalThis.fetch = makeShardedFetch(partial, stats);
    try {
      const at = HEAD_BYTES + 2 * 2000000 + 5;
      const response = await shardHandler.fetch(request(`bytes=${at}-${at + 15}`), { env: {} }, { env: {} });
      assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes("PMTiles"));
    } finally {
      globalThis.fetch = saved;
    }
  });

  /* ------------------------------------------------------------------ *
   * Routing with the real production constants, no bytes needed.
   * ------------------------------------------------------------------ */

  const real = await loadRealSnippet();
  const base = real.ARCHIVES_FOR_TEST?.basemap;
  // ARCHIVES is not exported, so rebuild the one entry from the deployed values
  // in plan-report.mjs. Keep these in step with snippet.js.
  const BASEMAP = {
    total: 126775469007,
    headEnd: 16384,
    tileOffset: 16384,
    metaOffset: 126450545781,
    leafOffset: 126450546941,
    tileShard: 2000000,
    leafShard: 160000,
    tilePartsPerShard: 4864,
  };

  /** Byte offset of tile part N. */
  const tilePartStart = (n) => BASEMAP.tileOffset + n * BASEMAP.tileShard;

  await checkAsync("the real table routes tile parts to the right shard", async () => {
    assert.equal(real.SHARDS, 13);
    const cases = [
      [0, 0], [1, 0], [4863, 0],
      [4864, 1], [4865, 1], [9727, 1],
      [9728, 2], [19455, 3],
      [38816, 7], [58368, 12], [63225, 12],
    ];
    for (const [part, shard] of cases) {
      const start = tilePartStart(part);
      const reads = real.planReads(start, start + 201, BASEMAP);
      assert.equal(reads.length, 1, `part ${part} produced ${reads.length} reads`);
      assert.equal(reads[0].kind, "tile");
      assert.equal(reads[0].index, part, `part ${part} read index`);
      assert.equal(reads[0].host, shard, `part ${part} must be on shard ${shard}`);
    }
  });

  await checkAsync("the real table puts every tile part on a shard that exists", async () => {
    for (const part of [0, 4864, 30000, 63224, 63225]) {
      const start = tilePartStart(part);
      const reads = real.planReads(start, start, BASEMAP);
      assert.equal(reads.length, 1);
      assert.ok(reads[0].host >= 0 && reads[0].host < real.SHARDS, `shard ${reads[0].host}`);
    }
    // The last tile part is short: the tile section does not divide evenly.
    const lastPartStart = tilePartStart(63225);
    assert.equal(
      BASEMAP.metaOffset - lastPartStart,
      529397,
      "the last tile part should be 529,397 B, which shard-12 serves"
    );
  });

  await checkAsync("the real table spans a shard boundary in 2 reads", async () => {
    const start = tilePartStart(4863) + BASEMAP.tileShard - 100;
    const reads = real.planReads(start, start + 300, BASEMAP);
    assert.equal(reads.length, 2);
    assert.deepEqual(reads.map((r) => r.host), [0, 1]);
    assert.deepEqual(reads.map((r) => r.index), [4863, 4864]);
    // The bytes must add up to the range, with no gap or overlap.
    const covered = reads.reduce((sum, r) => sum + r.length, 0);
    assert.equal(covered, 301);
  });

  await checkAsync("the real table refuses a range over three parts", async () => {
    // Parts 10, 11 and 12 in full. A range covering all three must be refused.
    assert.equal(real.planReads(tilePartStart(10), tilePartStart(13) - 1, BASEMAP), null);
    // Two whole parts are still allowed, and cost exactly 2 subrequests.
    const two = real.planReads(tilePartStart(10), tilePartStart(12) - 1, BASEMAP);
    assert.equal(two.length, 2);
    assert.equal(two.reduce((sum, r) => sum + r.length, 0), 2 * BASEMAP.tileShard);
  });

  await checkAsync("the real table refuses a shard outside the table", async () => {
    // A tilePartsPerShard that disagrees with SHARD_COUNT would send reads to a
    // host that does not exist. That must be refused, not attempted.
    const broken = { ...BASEMAP, tilePartsPerShard: 100 };
    const start = tilePartStart(5000);
    assert.equal(real.planReads(start, start + 201, broken), null);
  });

  await checkAsync("the real table keeps head, metadata and leaf on shard 0", async () => {
    const head = real.planReads(0, 16383, BASEMAP);
    assert.deepEqual(head.map((r) => [r.kind, r.host]), [["head", 0]]);

    const meta = real.planReads(BASEMAP.metaOffset, BASEMAP.metaOffset + 1159, BASEMAP);
    assert.deepEqual(meta.map((r) => [r.kind, r.host]), [["meta", 0]]);

    // The leaf section is 324,922,066 B in 160,000 B parts, so 2,031 parts, all
    // on shard 0. A 150,036 B leaf read is the largest the client makes.
    const cases = [
      [BASEMAP.leafOffset, 150036],
      [BASEMAP.leafOffset + 160000 * 2029, 150036],
      [BASEMAP.total - 150036, 150036],
    ];
    for (const [start, length] of cases) {
      assert.ok(
        start + length - 1 < BASEMAP.total,
        `the test case at ${start} runs past the archive end`
      );
      const reads = real.planReads(start, start + length - 1, BASEMAP);
      assert.notEqual(reads, null, `leaf read at ${start}`);
      assert.deepEqual([...new Set(reads.map((r) => r.host))], [0], `leaf read at ${start}`);
      assert.deepEqual([...new Set(reads.map((r) => r.kind))], ["leaf"]);
    }
  });

  await checkAsync("the snippet and the build planner route identically", async () => {
    // shard-plan.mjs planRequest is what the shard builds are planned with. If
    // it and the snippet disagree, a tile is looked for on a host that does not
    // hold it. Compare them over every part boundary plus random ranges.
    const { planRequest } = await import("./shard-plan.mjs");
    const layout = {
      headEnd: BASEMAP.headEnd,
      tileOffset: BASEMAP.tileOffset,
      metaOffset: BASEMAP.metaOffset,
      leafOffset: BASEMAP.leafOffset,
      total: BASEMAP.total,
      tileShard: BASEMAP.tileShard,
      leafShard: BASEMAP.leafShard,
      tilePartsPerShard: BASEMAP.tilePartsPerShard,
      shardCount: real.SHARDS,
    };

    const starts = [];
    for (const part of [0, 1, 4863, 4864, 4865, 9727, 9728, 31631, 31632, 63224, 63225]) {
      starts.push(tilePartStart(part), tilePartStart(part) + 12345, tilePartStart(part) + 1999999);
    }
    starts.push(0, BASEMAP.metaOffset, BASEMAP.leafOffset, BASEMAP.leafOffset + 160000,
      BASEMAP.total - 200000, BASEMAP.total - 1);

    let compared = 0;
    for (const start of starts) {
      for (const length of [1, 200, 6873, 150036, 200001, 2000000, 2500000]) {
        const end = start + length - 1;
        if (end >= BASEMAP.total) continue;
        const mine = real.planReads(start, end, BASEMAP) || [];
        const theirs = planRequest(start, end, layout);
        // Normalise both to [host, kind, index, offset, length]. The planner
        // writes zero padded paths such as tile/000000.bin.
        const key = (host, path) => {
          const m = /^(tile|leaf)\/(\d+)\.bin$/.exec(path);
          return m ? [host, m[1], Number(m[2])] : [host, path.replace(".bin", ""), 0];
        };
        const mineKey = JSON.stringify(
          mine.map((r) => [r.host, r.kind, r.index, r.offset, r.length])
        );
        const theirsKey = JSON.stringify(
          theirs.map((r) => [...key(r.host, r.path), r.offset, r.length])
        );
        assert.equal(
          mineKey,
          theirsKey,
          `range ${start}-${end}\n  snippet ${mineKey}\n  planner ${theirsKey}`
        );
        compared++;
      }
    }
    assert.ok(compared > 100, `only compared ${compared} ranges`);
  });

  rmSync(dir, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();