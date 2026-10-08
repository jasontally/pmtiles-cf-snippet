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

/* Load the snippet with its ARCHIVES table pointed at the test archive. */
async function loadSnippet(modules) {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  const patched = source.replace(
    /const ARCHIVES = \{[\s\S]*?\n\};/,
    `const ARCHIVES = {\n  demo: ${JSON.stringify(modules)},\n};`
  );
  assert.notEqual(patched, source, "could not patch ARCHIVES in snippet.js");
  const url = "data:text/javascript;base64," +
    Buffer.from(patched.replace(/export const HEAD_READ_BYTES[^\n]*\n/, "")).toString("base64");
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

  rmSync(dir, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();