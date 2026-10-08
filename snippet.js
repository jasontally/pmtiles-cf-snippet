/**
 * Cloudflare Snippet: serve a PMTiles archive that is split across Static Asset files.
 *
 * WHY THIS IS NOT A PLAIN RANGE SERVER
 * Workers Static Assets do not answer HTTP Range requests. There is no
 * "Range: bytes=a-b" subrequest. A reader must fetch a whole asset file and cut
 * out the bytes it needs. So the size of the asset files decides how much work
 * and how much memory each tile request costs.
 *
 * The Protomaps client sends only closed, single byte ranges:
 *   - bytes=0-16383              the header and the root directory
 *   - bytes=<off>-<end>           one leaf directory, or one tile
 * The largest request measured from the Protomaps basemap is a leaf directory of
 * 150,036 bytes. A tile is usually about 200 bytes.
 *
 * Budget for this snippet: 2 subrequests (the Pro plan limit), 5 ms of CPU,
 * 2 MB of memory, 32 KB of package. No caches.default here, because a Cache API
 * call spends the same subrequest budget as a fetch. A part read IS the cache
 * read: the part files are served by the edge cache, so a hot part is already
 * in local memory at the data centre and needs no extra request.
 *
 * WHY TWO PART SIZES
 * The tile section is 99.99 % of all requests, so its part size sets both the
 * file count and the per request cost. The leaf section is 0.26 % of the bytes
 * but holds the largest single request, a leaf directory of 150,036 bytes, so
 * it needs parts just larger than that to stay at one subrequest. One uniform
 * size would either overflow the file limit or oversize the leaf parts.
 * See pmtiles-shard-spec.md section 5.
 *
 * ARCHIVE LAYOUT, written by shard-pmtiles.py
 *   head.bin          bytes [0, headEnd)
 *   tile/NNNNNN.bin   bytes [tileOffset, tileOffset + tileSpan), tileShard each
 *   meta.bin          bytes [metaOffset, metaOffset + metaSpan)
 *   leaf/NNNNNN.bin   bytes [leafOffset, leafOffset + leafSpan), leafShard each
 *
 * Ceiling: part sizes are build time constants. A request that would need more
 * than 2 parts, or more than MAX_RESPONSE bytes, gets 416. See
 * pmtiles-shard-spec.md sections 6.1 and 8.
 */

const HEAD_BYTES = 16384;
const MAX_SUBREQUESTS = 2;
// 150,036 B is the largest real request. 512 KiB leaves room for a client that
// asks for more, and stays far under the 2 MB memory limit.
const MAX_RESPONSE = 524288;
// A tile part is 2 MB, which does not fit in the 2 MB memory limit alongside the
// answer buffer. So a part larger than this is streamed and only the bytes the
// client asked for are kept. head, meta and leaf parts are all under it and are
// read in one piece, which is cheaper than streaming.
const BUFFER_LIMIT = 1048576;

const ARCHIVES = {
  // total, headEnd, tileOffset, metaOffset, leafOffset, tileShard, leafShard
  basemap: {
    total: 126775469007,
    headEnd: 16384,
    tileOffset: 16384,
    metaOffset: 126450545781,
    leafOffset: 126450546941,
    tileShard: 2000000,
    leafShard: 160000,
  },
};

const ALLOWED_ORIGINS = "*";
const CORS_EXPOSE = "ETag, Content-Range, Accept-Ranges, Content-Length";
const ARCHIVE_PATH = "/s/";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders(request, { Allow: "GET, HEAD, OPTIONS" }),
      });
    }

    const name = archiveName(url.pathname);
    if (name === null) return notFound(request);
    const archive = ARCHIVES[name];
    if (!archive) return notFound(request);

    const range = parseRange(request.headers.get("range"), archive.total);
    if (range === null) return rangeNotSatisfiable(request, archive.total);

    const { start, end } = range;
    const length = end - start + 1;
    if (length > MAX_RESPONSE) return rangeNotSatisfiable(request, archive.total);

    const reads = planReads(start, end, archive);
    if (reads === null || reads.length > MAX_SUBREQUESTS) {
      return rangeNotSatisfiable(request, archive.total);
    }

    // A HEAD answer needs the length, which the Range already gave us. Skip the
    // asset read entirely.
    let body = null;
    if (request.method !== "HEAD") {
      body = new Uint8Array(length);
      let written = 0;
      try {
        // The parts are read together so a two part request costs one round
        // trip in parallel, not two in series.
        const chunks = await Promise.all(
          reads.map((read) => fetchPart(url, name, archive, read))
        );
        for (const chunk of chunks) {
          body.set(chunk, written);
          written += chunk.length;
        }
      } catch (error) {
        return new Response(`Asset read failed: ${error.message}`, {
          status: 502,
          headers: corsHeaders(request),
        });
      }

      if (written !== length) {
        return new Response("Short asset read", {
          status: 502,
          headers: corsHeaders(request),
        });
      }
    }

    const headers = corsHeaders(request, {
      "Content-Type": "application/vnd.pmtiles",
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${archive.total}`,
      "Accept-Ranges": "bytes",
      // The Protomaps client compares the ETag between requests to notice a new
      // archive. A weak ETag is ignored by the client, so keep this strong.
      ETag: `"${name}-${archive.total}"`,
      "Cache-Control": "public, max-age=3600",
    });

    return new Response(body, { status: 206, headers });
  },
};

/** Read "name" from a path of the form /name.pmtiles. Returns null if no match. */
function archiveName(pathname) {
  if (!pathname.endsWith(".pmtiles")) return null;
  const name = pathname.slice(1, -".pmtiles".length);
  if (name === "" || name.includes("/")) return null;
  return name;
}

/**
 * Map a client byte range onto the asset reads that serve it.
 * Returns a list of { kind, index, offset, length }, or null if the range
 * falls outside the archive or cannot be served.
 */
function planReads(start, end, archive) {
  const sections = [
    { kind: "head", start: 0, end: archive.headEnd, shard: 0 },
    { kind: "tile", start: archive.tileOffset, shard: archive.tileShard },
    { kind: "meta", start: archive.metaOffset, shard: 0 },
    { kind: "leaf", start: archive.leafOffset, shard: archive.leafShard },
  ];
  // tile and leaf run until the next section starts.
  sections[1].end = archive.metaOffset;
  sections[2].end = archive.leafOffset;
  sections[3].end = archive.total;

  const reads = [];
  for (const section of sections) {
    if (section.end <= section.start) continue;
    if (end < section.start || start >= section.end) continue;

    const lo = Math.max(start, section.start) - section.start;
    const hi = Math.min(end, section.end - 1) - section.start;

    if (section.shard === 0) {
      reads.push({ kind: section.kind, index: 0, offset: lo, length: hi - lo + 1 });
      continue;
    }
    const first = Math.floor(lo / section.shard);
    const last = Math.floor(hi / section.shard);
    if (last - first + 1 > MAX_SUBREQUESTS) return null;
    for (let index = first; index <= last; index++) {
      const partStart = index * section.shard;
      const a = Math.max(lo, partStart) - partStart;
      const b = Math.min(hi, partStart + section.shard - 1) - partStart;
      reads.push({ kind: section.kind, index, offset: a, length: b - a + 1 });
    }
  }
  // Every byte of the range must be covered, or the answer would be wrong.
  const covered = reads.reduce((sum, read) => sum + read.length, 0);
  if (covered !== end - start + 1) return null;
  return reads;
}

/**
 * Fetch one asset and cut out the requested bytes.
 *
 * Static Assets ignore the Range header, so this reads the whole part and
 * slices it. That read is the cost this design must budget for:
 *
 *   part        worst read   typical read   subrequests
 *   head.bin    16 KiB       16 KiB         1
 *   meta.bin    1.2 KiB      1.2 KiB        1
 *   leaf part   160 KiB      111 KiB        1
 *   tile part   2.0 MB       1.0 MB         1
 *
 * The peak allocation is one part plus the answer, so 2.0 MB + 0.15 MB. That is
 * over the 2 MB memory limit for a tile part, so a tile request that needs a
 * part is served by streaming instead of buffering. See fetchPartStreamed.
 *
 * Ceiling: a tile part read costs up to 2 MB of internal transfer to answer a
 * 200 byte tile. That is the price of Static Assets having no Range support.
 * The cost falls as the part size falls, and the file count rises. The chosen
 * point is TILE_SHARD in shard-pmtiles.py.
 */
async function fetchPart(url, name, archive, read) {
  const file = read.kind === "head" || read.kind === "meta"
    ? `${read.kind}.bin`
    : `${read.kind}/${String(read.index).padStart(6, "0")}.bin`;
  const target = `${url.origin}${ARCHIVE_PATH}${name}/${file}`;

  const response = await fetch(target);
  if (response.status !== 200) {
    throw new Error(`${file} returned ${response.status}`);
  }

  const partSize = Number(response.headers.get("Content-Length") || "0");
  if (partSize > BUFFER_LIMIT || !response.body) {
    return readSlice(response, read, file);
  }

  const all = new Uint8Array(await response.arrayBuffer());
  const slice = all.subarray(read.offset, read.offset + read.length);
  if (slice.length !== read.length) {
    throw new Error(`${file} is shorter than byte ${read.offset + read.length - 1}`);
  }
  return slice;
}

/**
 * Read only the needed bytes of a large part, without holding the whole part.
 * Keeps memory at the size of the answer plus one network chunk.
 */
async function readSlice(response, read, file) {
  const wanted = new Uint8Array(read.length);
  const reader = response.body.getReader();
  let position = 0;
  let copied = 0;

  try {
    while (copied < wanted.length) {
      const { value, done } = await reader.read();
      if (done) break;
      // Skip the part before the answer, then copy, then stop reading.
      const chunkStart = position;
      const chunkEnd = position + value.length;
      position = chunkEnd;
      if (chunkEnd <= read.offset) continue;
      if (chunkStart >= read.offset + read.length) break;
      const from = Math.max(read.offset, chunkStart);
      const to = Math.min(read.offset + read.length, chunkEnd);
      wanted.set(value.subarray(from - chunkStart, to - chunkStart), from - read.offset);
      copied += to - from;
    }
  } finally {
    // Stop the transfer as soon as the answer is complete. Without this the
    // whole part would arrive at the edge.
    await reader.cancel();
  }

  if (copied !== read.length) {
    throw new Error(`${file} ended before byte ${read.offset + read.length - 1}`);
  }
  return wanted;
}

/**
 * Parse a Range header against a resource of "total" bytes.
 * Returns { start, end } with both bounds included, or null if the range
 * cannot be served. A missing header returns null on purpose: the Protomaps
 * client treats 416 on its first request as "this archive is tiny" and then asks
 * for the whole file, which is 118 GiB here. See pmtiles-shard-spec.md section 8.
 */
function parseRange(header, total) {
  if (!header) return null;
  const text = header.trim();
  if (!text.startsWith("bytes=")) return null;

  const spec = text.slice(6);
  if (spec === "" || spec.includes(",")) return null;

  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const first = spec.slice(0, dash).trim();
  const last = spec.slice(dash + 1).trim();
  if (first === "" && last === "") return null;

  let start;
  let end;
  if (first === "") {
    const count = Number(last);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    start = Math.max(0, total - count);
    end = total - 1;
  } else {
    start = Number(first);
    if (!Number.isSafeInteger(start)) return null;
    end = last === "" ? total - 1 : Number(last);
    if (!Number.isSafeInteger(end)) return null;
  }

  if (start < 0 || start >= total || end < start) return null;
  return { start, end: Math.min(end, total - 1) };
}

function notFound(request) {
  return new Response("Not Found", { status: 404, headers: corsHeaders(request) });
}

function rangeNotSatisfiable(request, total) {
  return new Response(null, {
    status: 416,
    headers: corsHeaders(request, { "Content-Range": `bytes */${total}` }),
  });
}

/**
 * CORS headers for the Protomaps client.
 * ETag must appear in Access-Control-Expose-Headers, otherwise the browser
 * hides it from the client and the client cannot detect a new archive.
 */
function corsHeaders(request, extra) {
  const headers = new Headers(extra);
  const origin = request.headers.get("Origin");
  const allowed = ALLOWED_ORIGINS === "*"
    ? "*"
    : ALLOWED_ORIGINS.split(",").map((value) => value.trim());
  if (origin && (allowed === "*" || allowed.includes(origin))) {
    headers.set("Access-Control-Allow-Origin", allowed === "*" ? "*" : origin);
    headers.append("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE);
  headers.append("Vary", "Range");
  return headers;
}

// Keep the header size constant referenced so a reader can check it.
export const HEAD_READ_BYTES = HEAD_BYTES;