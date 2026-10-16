/**
 * Optional root-page snippet: inject preload tags for the first map view.
 *
 * The table below is generated at build time from the archive layout and
 * inlined by build.mjs. The snippet reads one entry for the viewer's zoom-five
 * tile and emits one preload link per tile part.
 *
 * The table is carried in the code on purpose. A second subrequest to the same
 * zone fails in the Snippets runtime, so the origin fetch below spends the one
 * subrequest this snippet gets. See pmtiles-shard-spec.md.
 *
 * When build.mjs does not inline the table, the marker parses as an empty
 * table, so the snippet deploys and injects nothing instead of failing.
 */

const TABLE = "__PRELOAD_TABLE__";

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

function partUrls(key) {
  const parts = BUCKETS.get(key);
  if (!parts || !PARTS_PER_SHARD) return [];
  return parts.map((part) => {
    const host = Math.floor(part / PARTS_PER_SHARD);
    return `https://s.tiles${host}.jasontally.com/s/basemap/tile/${String(part).padStart(6, "0")}.bin`;
  });
}

export { bucket, bucketFile };

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
    const key = bucket(lat, lon);
    const urls = key ? partUrls(key) : [];
    if (!urls.length) return response;

    const links = urls.map((href) =>
      `<link rel="preload" as="fetch" href="${href}" crossorigin>`
    ).join("");
    const transformed = new HTMLRewriter()
      .on("head", {
        element(element) {
          element.append(links, { html: true });
        },
      })
      .transform(response);
    // The links follow the viewer's coordinates, so a shared cache must not
    // store this response: it would serve one visitor's parts to the next.
    // private keeps the browser cache, where the links belong to one viewer.
    const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "private, max-age=0, must-revalidate");
    return new Response(transformed.body, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  },
};