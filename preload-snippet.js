/**
 * Optional root-page snippet: inject the viewer's location, the preload tags,
 * and the archive preload for the first map view.
 *
 * Two build markers are carried in the code on purpose, because a second
 * subrequest to the same zone fails in the Snippets runtime and the origin fetch
 * below spends the one subrequest this snippet gets. See pmtiles-shard-spec.md.
 *
 * The table marker holds one entry per zoom-five tile: the tile parts the first
 * view reads. The meta marker holds the archive's fixed ranges (the head, the
 * metadata, and the leaf directory the zoom-five tiles sit behind), the archive
 * URL, and the static assets the page asks for. build.mjs inlines both.
 *
 * When a marker is not inlined it parses as nothing, so the snippet deploys and
 * injects less instead of failing.
 */

const TABLE = "__PRELOAD_TABLE__";
const META_TEXT = "__PRELOAD_META__";

// The rule excludes this header. A request with it reaches the origin without
// running this snippet again, so the origin fetch cannot loop back into itself.
const INTERNAL = "x-tiles-preload";

export function parseTable(text) {
  const chunks = text.split(";");
  const partsPerShard = Number(chunks.shift()) || 0;
  const buckets = new Map();
  for (const chunk of chunks) {
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const key = chunk.slice(0, colon);
    const parts = chunk.slice(colon + 1).split(",").map(Number).filter(Number.isFinite);
    if (key && parts.length) buckets.set(key, parts);
  }
  return { partsPerShard, buckets };
}

const { partsPerShard: PARTS_PER_SHARD, buckets: BUCKETS } = parseTable(TABLE);

/**
 * Read the second build marker. Every field is checked here, so a partial or
 * hand-edited meta file leaves the marker unusable rather than emitting a
 * preload script that fetches the wrong bytes.
 */
export function parseMeta(text) {
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (typeof value.url !== "string" || !value.url) return null;
  if (![value.total, value.tileOffset, value.partSize].every((n) => Number.isFinite(n) && n > 0)) {
    return null;
  }
  const ranges = Array.isArray(value.ranges)
    ? value.ranges.filter(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          range.every((n) => Number.isFinite(n) && n >= 0) &&
          range[1] > 0
      )
    : [];
  if (!ranges.length || ranges.length !== value.ranges.length) return null;
  const links = Array.isArray(value.links) ? value.links.filter((link) => typeof link === "string") : [];
  return {
    url: value.url,
    total: value.total,
    tileOffset: value.tileOffset,
    partSize: value.partSize,
    ranges,
    links,
  };
}

const META = parseMeta(META_TEXT);

// The keys are zoom-five tiles, the same keys tools/generate-preloads.mjs
// writes. The first map view asks for two tiles wide and up to three tall, and
// the generated table carries one tile of margin on each side, so the viewer's
// own tile is the only key this snippet needs to build.
const PRELOAD_ZOOM = 5;
const PRELOAD_SIDE = 1 << PRELOAD_ZOOM;
// Latitude clamps at the Mercator limit. A viewer at the pole still lands on
// the top row instead of a NaN key.
const MERCATOR_LAT = 85.051129;

function bucket(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const x = Math.min(PRELOAD_SIDE - 1, Math.max(0, Math.floor((lon + 180) / 360 * PRELOAD_SIDE)));
  const latRad = Math.max(-MERCATOR_LAT, Math.min(MERCATOR_LAT, lat)) * Math.PI / 180;
  const y = Math.min(
    PRELOAD_SIDE - 1,
    Math.max(0, Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * PRELOAD_SIDE))
  );
  return `${x}_${y}`;
}

function bucketFile(lat, lon) {
  const key = bucket(lat, lon);
  return key ? `/preload/${encodeURIComponent(key)}.json` : null;
}

function partUrl(part, partsPerShard) {
  const host = Math.floor(part / partsPerShard);
  return `https://s.tiles${host}.jasontally.com/s/basemap/tile/${String(part).padStart(6, "0")}.bin`;
}

export { bucket, bucketFile };

/**
 * The script the root page receives. It fetches the fixed ranges through the
 * pmtiles snippet, which already does the part lookup and the slicing, and the
 * tile parts from the shards. It keeps the bytes and answers the page's own
 * range reads from that memory, so the reader's directory walk and tile reads
 * need no round trip. A read the preload does not cover falls through to the
 * network, so a miss costs what it costs today rather than failing.
 *
 * This runs as an inline script in the page, not in the Snippets runtime, so it
 * may spend as many requests as it needs.
 */
export function runtime(config) {
  const net = window.fetch.bind(window);
  const spans = [];
  // A range whose answer is not a 206 is refused before the body is read: a 200
  // for a range would be the whole archive, and buffering that is worse than a
  // miss. A failed preload becomes a null span either way, so the read falls
  // through to the network instead of surfacing an error nobody asked for.
  const add = (start, length, request) =>
    spans.push({ start, end: start + length, data: request.catch(() => null) });
  const body = (response, ...statuses) => {
    if (!statuses.includes(response.status)) throw new Error(`preload ${response.status}`);
    return response.arrayBuffer();
  };
  const bytes = (start, length) => `bytes=${start}-${start + length - 1}`;
  for (const [start, length] of config.ranges) {
    add(start, length, net(config.url, { headers: { Range: bytes(start, length) } }).then((r) => body(r, 206)));
  }
  for (const [part, url] of config.parts) {
    add(config.tileOffset + part * config.partSize, config.partSize, net(url).then((r) => body(r, 200, 206)));
  }

  const wanted = /^bytes=(\d+)-(\d+)$/;
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url === config.url) {
        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        const match = wanted.exec((headers.get("range") || "").trim());
        if (match) {
          const start = Number(match[1]);
          const end = Number(match[2]);
          const span = spans.find((candidate) => start >= candidate.start && end < candidate.end);
          if (span) {
            return Promise.resolve(span.data)
              .then((buffer) => {
                const offset = start - span.start;
                if (!buffer || offset + (end - start + 1) > buffer.byteLength) {
                  throw new Error("no preload");
                }
                return new Response(buffer.slice(offset, end - span.start + 1), {
                  status: 206,
                  headers: {
                    "Content-Range": `bytes ${start}-${end}/${config.total}`,
                    "Content-Length": `${end - start + 1}`,
                    "Cache-Control": "public, max-age=604800",
                  },
                });
              })
              .catch(() => net(input, init));
          }
        }
      }
    } catch {
      // Fall through to the network on anything unexpected in the wrapper.
    }
    return net(input, init);
  };
}

/**
 * The head of the root response: the visitor's coordinates, the assets the page
 * asks for next, the tile parts for the viewer's first view, and the archive
 * preload script. The coordinates come from request.cf, which is the same coarse
 * city the latlon service answers with, so the page needs no request of its own
 * for them.
 */
export function headInjection(lat, lon, { meta = META, partsPerShard = PARTS_PER_SHARD, buckets = BUCKETS } = {}) {
  const head = [];
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    head.push(`<meta name="tiles-latlon" content="${lat.toFixed(4)},${lon.toFixed(4)}">`);
  }
  if (!meta) return head.join("");
  const key = bucket(lat, lon);
  const parts = ((key && buckets.get(key)) || []).map((part) => [part, partUrl(part, partsPerShard)]);
  // The parts are served from another host. Open those connections first, while
  // the parser is still at the top of the head, so the handshake is not waiting
  // in front of the bytes the first view needs.
  for (const origin of new Set(parts.map(([, url]) => new URL(url).origin))) {
    head.push(`<link rel="preconnect" href="${origin}" crossorigin>`);
  }
  head.push(...meta.links);
  if (!parts.length) return head.join("");
  // The part links start the part fetches while the parser is still in the head,
  // and the script below reads the same URLs back from the browser cache, so the
  // bytes are both fetched early and usable from memory.
  head.push(...parts.map(([, url]) => `<link rel="preload" as="fetch" href="${url}" crossorigin>`));
  const config = {
    url: meta.url,
    total: meta.total,
    tileOffset: meta.tileOffset,
    partSize: meta.partSize,
    ranges: meta.ranges,
    parts,
  };
  head.push(`<script>(${runtime.toString()})(${JSON.stringify(config)})</script>`);
  return head.join("");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return fetch(request);
    // The nested fetch after the snippet adds this header does not match the
    // snippet rule, so it reaches the asset rather than re-entering the snippet.
    if (request.headers.get(INTERNAL) === "1") return fetch(request);

    const originRequest = new Request(request, {
      headers: new Headers(request.headers),
    });
    originRequest.headers.set(INTERNAL, "1");
    const response = await fetch(originRequest);
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.startsWith("text/html")) return response;

    const lat = Number(request.cf && request.cf.latitude);
    const lon = Number(request.cf && request.cf.longitude);
    const injection = headInjection(lat, lon);
    if (!injection) return response;

    const transformed = new HTMLRewriter()
      .on("head", {
        element(element) {
          element.append(injection, { html: true });
        },
      })
      .transform(response);
    // The injected head follows the viewer's coordinates, so a shared cache must
    // not store this response: it would serve one visitor's location and parts to
    // the next. private keeps the browser cache, where they belong to one viewer.
    const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "private, max-age=0, must-revalidate");
    return new Response(transformed.body, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  },
};