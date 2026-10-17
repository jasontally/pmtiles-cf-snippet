/**
 * Optional root-page snippet: inject the viewer's location, the preload tags,
 * and the archive preload for the first map view.
 *
 * Two build markers are carried in the code on purpose, because a second
 * subrequest to the same zone fails in the Snippets runtime and the origin fetch
 * below spends the one subrequest this snippet gets. See pmtiles-shard-spec.md.
 *
 * The table marker holds one archive byte range per zoom-five tile, in grid
 * order. The meta marker holds the archive's fixed ranges (the head, the
 * metadata, and the leaf directory the zoom-five tiles sit behind), the archive
 * URL, the sprite, and the static assets the page asks for. build.mjs inlines
 * both.
 *
 * When a marker is not inlined it parses as nothing, so the snippet deploys and
 * injects less instead of failing.
 */

const TABLE = "__PRELOAD_TABLE__";
const META_TEXT = "__PRELOAD_META__";

// The rule excludes this header. A request with it reaches the origin without
// running this snippet again, so the origin fetch cannot loop back into itself.
const INTERNAL = "x-tiles-preload";

/**
 * Read the table: a format number, then one "offset.length" byte range per
 * zoom-five tile in grid order, in base 36. The position in the list is the
 * tile: index x * 32 + y. A bare "0" is a tile with no data, and a table whose
 * format number is not this one yields no tiles at all, so a snippet running
 * beside a table from another build preloads only the fixed ranges.
 */
export function parseTable(text) {
  const chunks = text.split(";");
  if (chunks.shift() !== "1") return [];
  return chunks.map((chunk) => {
    const dot = chunk.indexOf(".");
    if (dot < 0) return null;
    const offset = parseInt(chunk.slice(0, dot), 36);
    const length = parseInt(chunk.slice(dot + 1), 36);
    return Number.isFinite(offset) && length > 0 ? [offset, length] : null;
  });
}

const TILES = parseTable(TABLE);

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
  if (!Number.isFinite(value.total) || value.total <= 0) return null;
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
  const sprite = typeof value.sprite === "string" && value.sprite ? value.sprite : "";
  return {
    url: value.url,
    total: value.total,
    ranges,
    links,
    sprite,
  };
}

const META = parseMeta(META_TEXT);

// The keys are zoom-five tiles. The map opens centred on the request
// coordinates at zoom 5, and a window of one tile of margin on each side covers
// every container the page can have: the map's own CSS caps its width at 62rem
// and its height at 44rem, both under the 1024 pixels two tiles span, so no
// window reaches past the tile beside or above the viewer's own.
const PRELOAD_ZOOM = 5;
const PRELOAD_SPAN = 1;
const PRELOAD_SIDE = 1 << PRELOAD_ZOOM;
// Latitude clamps at the Mercator limit. A viewer at the pole still lands on
// the top row instead of a NaN key.
const MERCATOR_LAT = 85.051129;

function tileAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const x = Math.min(PRELOAD_SIDE - 1, Math.max(0, Math.floor((lon + 180) / 360 * PRELOAD_SIDE)));
  const latRad = Math.max(-MERCATOR_LAT, Math.min(MERCATOR_LAT, lat)) * Math.PI / 180;
  const y = Math.min(
    PRELOAD_SIDE - 1,
    Math.max(0, Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * PRELOAD_SIDE))
  );
  return { x, y };
}

function bucket(lat, lon) {
  const tile = tileAt(lat, lon);
  return tile ? `${tile.x}_${tile.y}` : null;
}

export { bucket };

/**
 * The script the root page receives. It fetches the fixed ranges and the byte
 * ranges of the tiles the first view draws, through the pmtiles snippet, which
 * already does the part lookup and the slicing. It keeps the bytes and answers
 * the page's own range reads from that memory, so the reader's directory walk
 * and its first tiles need no round trip. A read the preload does not cover
 * falls through to the network, so a miss costs what it costs today rather than
 * failing.
 *
 * This runs as an inline script in the page, not in the Snippets runtime, so it
 * may spend as many requests as it needs. Only this function's body reaches the
 * page: the notes above stay on the server, which is why the reasoning lives
 * here rather than beside the lines it explains.
 *
 * A range whose answer is not a 206 is refused before the body is read: a 200
 * for a range would be the whole archive, and buffering that is worse than a
 * miss. A failed preload becomes a null span either way, so the read falls
 * through to the network instead of surfacing an error nobody asked for.
 *
 * The first view draws a small window of zoom-five tiles around the centre the
 * snippet was given for. The map's own element is the box MapLibre covers, and
 * it is smaller than the window, so measure that instead of guessing. It may not
 * be in the document yet when this runs, and in a background tab no frame is
 * rendered at all, so retry on the next frame and once more at DOMContentLoaded.
 * One vector tile covers 512 CSS pixels at its own zoom, so the pixel span of
 * the box is what decides how many tiles the window holds.
 *
 * The style's sprite is fetched here as well, at the variant the map will ask
 * for. MapLibre gets the sheet with an Image that sets crossOrigin "anonymous"
 * and the index with a fetch, so these two calls copy that mode and its own
 * loads find the bytes in the cache rather than on the network. The map's pixel
 * ratio picks the variant, and the page clamps that ratio to 1.5, so it is above
 * one exactly when the device ratio is. Bytes, not correctness, hang on the
 * guess: the wrong variant still loads, the map fetches the other one.
 */
export function runtime(config) {
  const net = window.fetch.bind(window);
  const spans = [];
  const add = (start, length, request) =>
    spans.push({ start, end: start + length, data: request.catch(() => null) });
  const body = (response, ...statuses) => {
    if (!statuses.includes(response.status)) throw new Error(`preload ${response.status}`);
    return response.arrayBuffer();
  };
  const bytes = (start, length) => `bytes=${start}-${start + length - 1}`;
  const get = (start, length) => {
    if (!(length > 0) || spans.some((span) => span.start === start && span.end === start + length)) return;
    add(start, length, net(config.url, { headers: { Range: bytes(start, length) } }).then((r) => body(r, 206)));
  };
  for (const [start, length] of config.ranges) get(start, length);


  const wanted = new Map();
  for (const chunk of (config.tiles || "").split(",")) {
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const [start, length] = chunk.slice(colon + 1).split(".");
    wanted.set(chunk.slice(0, colon), [parseInt(start, 36), parseInt(length, 36)]);
  }
  let started = false;
  const start = () => {
    if (started) return;
    const box = document.getElementById("map");
    const rect = box && box.getBoundingClientRect();
    const measured = rect && rect.width > 0 && rect.height > 0;
    if (!measured && document.readyState === "loading") {
      requestAnimationFrame(start);
      return;
    }
    started = true;
    if (!config.centre || !wanted.size) return;
    const width = measured ? rect.width : window.innerWidth;
    const height = measured ? rect.height : window.innerHeight;
    const tile = 512;
    const world = (1 << config.zoom) * tile;
    const lat = Math.max(-85.051129, Math.min(85.051129, config.centre[1]));
    const rad = lat * Math.PI / 180;
    const cx = (config.centre[0] + 180) / 360 * world;
    const cy = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * world;
    const last = (1 << config.zoom) - 1;
    const clamp = (n) => Math.max(0, Math.min(last, n));
    for (let x = clamp(Math.floor((cx - width / 2) / tile)); x <= clamp(Math.floor((cx + width / 2) / tile)); x++) {
      for (let y = clamp(Math.floor((cy - height / 2) / tile)); y <= clamp(Math.floor((cy + height / 2) / tile)); y++) {
        const span = wanted.get(`${x}_${y}`);
        if (span) get(span[0], span[1]);
      }
    }
  };
  start();
  document.addEventListener("DOMContentLoaded", start);

  const wantedRange = /^bytes=(\d+)-(\d+)$/;
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url === config.url) {
        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        const match = wantedRange.exec((headers.get("range") || "").trim());
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

  // The style's sprite, at the variant the map will ask for. MapLibre gets the
  // sheet with an Image that sets crossOrigin "anonymous" and the index with a
  // fetch, so these two calls copy that mode and its own loads find the bytes in
  // the cache rather than on the network.
  //
  // The map's pixel ratio picks the variant, and this repeats the ratio rule the
  // page applies, because the device ratio alone no longer answers it. The page
  // draws a phone at exactly 1, so a phone measures 2.625 and still asks for the
  // 1x sheet. The two lines must stay the same as the rule beside
  // map.setPixelRatio in web/index.html. Bytes, not correctness, hang on the
  // guess: the wrong variant still loads, and the map fetches the other one.
  //
  // This runs last, after the wrapper above. Anything unexpected here then costs
  // the page a warm sprite, not the wrapper that answers every range read.
  if (config.sprite) {
    const phone = Math.min(window.innerWidth, window.innerHeight) < 700;
    const suffix = !phone && (window.devicePixelRatio || 1) > 1 ? "@2x" : "";
    const sheet = new Image();
    sheet.crossOrigin = "anonymous";
    sheet.src = `${config.sprite}${suffix}.png`;
    net(`${config.sprite}${suffix}.json`)
      .then((response) => response.arrayBuffer())
      .catch(() => null);
  }
}

/**
 * The head of the root response: the visitor's coordinates, the assets the page
 * asks for next, the sprite, the byte ranges of the nine tiles the first view
 * can reach, and the archive preload script. The coordinates come from
 * request.cf, which is the same coarse city the latlon service answers with, so
 * the page needs no request of its own for them.
 *
 * The nine tiles are the viewer's own and the ring around it. The script picks
 * the ones the map will draw out of them, so the page carries a few hundred
 * bytes rather than the whole table the snippet holds.
 *
 * The script is a module, which defers it. A classic inline script in the head
 * stops the parser and the first paint of a page that has no use for these bytes
 * yet. A module runs after the document is parsed and before DOMContentLoaded,
 * so the fetch it wraps is still in place before the page's own module runs, and
 * the map's box is in the document with its style applied when it measures.
 */
export function headInjection(lat, lon, { meta = META, tiles = TILES } = {}) {
  const head = [];
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    head.push(`<meta name="tiles-latlon" content="${lat.toFixed(4)},${lon.toFixed(4)}">`);
  }
  if (!meta) return head.join("");
  head.push(...meta.links);

  const here = tileAt(lat, lon);
  const group = [];
  for (let dx = -PRELOAD_SPAN; here && dx <= PRELOAD_SPAN; dx++) {
    for (let dy = -PRELOAD_SPAN; dy <= PRELOAD_SPAN; dy++) {
      const x = Math.max(0, Math.min(PRELOAD_SIDE - 1, here.x + dx));
      const y = Math.max(0, Math.min(PRELOAD_SIDE - 1, here.y + dy));
      const key = `${x}_${y}`;
      const range = tiles && tiles[x * PRELOAD_SIDE + y];
      // A tile at the edge of the world appears more than once in the ring.
      if (range && !group.some((entry) => entry.startsWith(`${key}:`))) {
        group.push(`${key}:${range[0].toString(36)}.${range[1].toString(36)}`);
      }
    }
  }
  const config = {
    url: meta.url,
    total: meta.total,
    ranges: meta.ranges,
    sprite: meta.sprite || "",
    // Longitude first, the order MapLibre centres take.
    centre: Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null,
    zoom: PRELOAD_ZOOM,
    tiles: group.join(","),
  };
  head.push(`<script type="module">(${runtime.toString()})(${JSON.stringify(config)})</script>`);
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