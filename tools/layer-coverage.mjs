#!/usr/bin/env node
/**
 * How much of the map does each layer actually draw?
 *
 *   node tools/layer-coverage.mjs                # a quick pass
 *   node tools/layer-coverage.mjs --full         # everything, takes longer
 *   node tools/layer-coverage.mjs --json
 *
 * Answers "which toggles should come off the builder", with a number rather than
 * one look at one city.
 *
 * THE FIRST VERSION OF THIS WAS WRONG and reported every roads, places and water
 * layer as drawing nothing. It compared the style layer's id (`road-highway`)
 * against the tile layer's name (`roads`), which never match, so everything scored
 * zero. The four layers it reported as working were the four whose ids happen to
 * equal their source layer. Comparing ids tells you nothing.
 *
 * So this decodes a tile's features with their properties, then runs each style
 * layer's filter over them, exactly as MapLibre does when it decides what to draw.
 * A layer counts as drawn only where features pass its filter, and its minzoom is
 * respected, which matters for a layer that only appears at z15.
 *
 * Sample: the whole world up to z5, where a census is cheap, and a grid of named
 * places above that, because z11 over the whole planet is a hundred million tiles
 * and the ones that matter are where people look.
 *
 * Reads through the public reader with Range requests. No credential, no local copy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TILES = "https://tiles.jasontally.com/basemap.pmtiles";
const LIBRARY = join(ROOT, "tools", ".pmtiles-cdn.mjs");

const full = process.argv.includes("--full");
const asJson = process.argv.includes("--json");

/** Where to look above z5. Longitude first, which is what tile maths wants. */
const PLACES = [
  ["London", 0.0, 51.5], ["Paris", 2.35, 48.86], ["Berlin", 13.4, 52.52],
  ["Madrid", -3.7, 40.42], ["Rome", 12.5, 41.9], ["Amsterdam", 4.9, 52.37],
  ["Stockholm", 18.07, 59.33], ["Warsaw", 21.01, 52.23],
  ["New York", -74.0, 40.71], ["Chicago", -87.63, 41.88], ["Atlanta", -84.39, 33.75],
  ["Denver", -104.99, 39.74], ["Los Angeles", -118.24, 34.05], ["Miami", -80.19, 25.77],
  ["Mexico City", -99.13, 19.43], ["Bogota", -74.07, 4.71],
  ["Lagos", 3.38, 6.52], ["Cairo", 31.24, 30.04], ["Nairobi", 36.82, -1.29],
  ["Moscow", 37.62, 55.75], ["Istanbul", 28.98, 41.01],
  ["Delhi", 77.21, 28.61], ["Mumbai", 72.88, 19.08], ["Bangkok", 100.5, 13.75],
  ["Jakarta", 106.85, -6.21], ["Manila", 120.98, 14.6], ["Singapore", 103.82, 1.35],
  ["Beijing", 116.4, 39.9], ["Shanghai", 121.47, 31.23], ["Hong Kong", 114.17, 22.32],
  ["Seoul", 126.98, 37.57], ["Tokyo", 139.69, 35.69],
  ["Sydney", 151.21, -33.87], ["Auckland", 174.76, -36.85],
  ["Sao Paulo", -46.63, -23.55], ["Buenos Aires", -58.38, -34.6],
  ["Cape Town", 18.42, -33.93], ["Reykjavik", -21.9, 64.15], ["Anchorage", -149.9, 61.22],
  ["Sahara", 10.0, 23.0], ["Amazon", -60.0, -3.0], ["Pacific", -140.0, 0.0],
  ["Antarctica", 0.0, -82.0],
];

// ---------------------------------------------------------------- protobuf

function varint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}

/**
 * Walk the fields of one protobuf message.
 *
 * The callback gets the raw bytes of every field, which is the only way a caller
 * can read a varint for itself: a Value's sint64 is field 6 wire 0, and passing
 * null for wire 0 makes it unreadable.
 */
function fields(body, callback) {
  let pos = 0;
  while (pos < body.length) {
    const [tag, after] = varint(body, pos);
    const wire = tag & 7;
    const field = tag >> 3;
    pos = after;
    if (wire === 2) {
      const [length, afterLength] = varint(body, pos);
      const slice = body.subarray(afterLength, afterLength + length);
      callback(field, wire, slice);
      pos = afterLength + length;
    } else if (wire === 0) {
      const [, afterValue] = varint(body, pos);
      callback(field, wire, body.subarray(pos, afterValue));
      pos = afterValue;
    } else if (wire === 1) {
      callback(field, wire, body.subarray(pos, pos + 8));
      pos += 8;
    } else if (wire === 5) {
      callback(field, wire, body.subarray(pos, pos + 4));
      pos += 4;
    } else {
      return; // groups, or corrupt. Neither occurs here.
    }
  }
}

/**
 * One MVT value.
 *
 * The FIRST VERSION of this read bytes[0] as a type code. It is not: it is a
 * protobuf field tag, where 0x0a is field 1 wire 2 and means string_value, and
 * 0x30 is field 6 wire 0 and means sint_value. Reading it as a type produced
 * "type10" and "type48" for every property, which no filter could ever match,
 * which is why every layer with a filter scored zero.
 *
 * The Value message is one optional field, and which one it is tells the type.
 */
function valueOf(bytes) {
  if (!bytes || !bytes.length) return null;
  let result = null;
  let seen = false;
  fields(bytes, (field, wire, slice) => {
    if (wire === 2) {
      if (field === 1) {
        result = Buffer.from(slice).toString("utf8");
        seen = true;
      } else if (field === 2) {
        result = new DataView(slice.buffer, slice.byteOffset, 4).getFloat32(0, true);
        seen = true;
      } else if (field === 3) {
        result = new DataView(slice.buffer, slice.byteOffset, 8).getFloat64(0, true);
        seen = true;
      }
      return;
    }
    if (wire === 0) {
      const [n] = varintAt(slice);
      switch (field) {
        case 4: result = n | 0; break;                       // int64
        case 5: result = n; break;                           // uint64
        case 6: result = (n >> 1) ^ -(n & 1); break;         // sint64, zigzag
        case 7: result = Boolean(n); break;                  // bool
        default: return;
      }
      seen = true;
    }
  });
  return seen ? result : null;
}

/** Read a varint from a complete buffer. */
function varintAt(buf) {
  let result = 0;
  let shift = 0;
  let pos = 0;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}

/** The properties of every feature in each layer of a tile. */
function layersOfTile(tile) {
  const found = new Map();
  fields(tile, (field, wire, bytes) => {
    if (field !== 3 || wire !== 2) return; // 3 = Layer
    let name = null;
    const keys = [];
    const values = [];
    const features = [];
    fields(bytes, (layerField, layerWire, layerBytes) => {
      if (layerField === 1 && layerWire === 2) {
        name = Buffer.from(layerBytes).toString("utf8");
      } else if (layerField === 3 && layerWire === 2) {
        keys.push(Buffer.from(layerBytes).toString("utf8"));
      } else if (layerField === 4 && layerWire === 2) {
        values.push(layerBytes);
      } else if (layerField === 2 && layerWire === 2) {
        features.push(layerBytes);
      }
    });
    if (name === null) return;
    const props = features.map((feature) => {
      const tags = [];
      fields(feature, (ff, fw, fb) => {
        if (ff === 2 && fw === 2) {
          let p = 0;
          while (p < fb.length) {
            const [tag, after] = varint(fb, p);
            tags.push(tag);
            p = after;
          }
        }
      });
      const out = {};
      for (let i = 0; i + 1 < tags.length; i += 2) {
        const key = keys[tags[i]];
        if (key === undefined) continue;
        out[key] = valueOf(values[tags[i + 1]]);
      }
      return out;
    });
    found.set(name, props);
  });
  return found;
}

// ---------------------------------------------------------------- filters

/** Deep equals for the small JSON values in a filter. */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Operators this understands. Anything else is reported, not guessed at. */
const KNOWN = new Set([
  "all", "any", "none", "match", "==", "!=", "<=", ">=", "<", ">",
  "get", "has", "coalesce", "length",
]);

/** True when the style filter would let this feature through. */
function passes(filter, props, unknown) {
  // Unknown shape: counted as passing. A filter this does not understand is a
  // bug in the evaluator, not a reason to report a layer as empty, so it errs
  // towards over-counting and says so in the report.
  if (!Array.isArray(filter)) return true;
  const [op, ...rest] = filter;
  if (!KNOWN.has(op)) {
    if (unknown) unknown.add(JSON.stringify(filter).slice(0, 120));
    return true; // over-count rather than under-report
  }

  if (op === "all") return rest.every((part) => passes(part, props, unknown));
  if (op === "any") return rest.some((part) => passes(part, props, unknown));
  if (op === "none") return !rest.some((part) => passes(part, props, unknown));

  if (op === "match") {
    const [input, ...tail] = rest;
    const value = at(input, props, unknown);
    const fallback = tail[tail.length - 1];
    const pairs = tail.slice(0, -1);
    for (let i = 0; i + 1 < pairs.length; i += 1) {
      const label = pairs[i];
      if (Array.isArray(label) && label.includes(value)) return pairs[i + 1];
      if (!Array.isArray(label) && same(label, value)) return pairs[i + 1];
    }
    return fallback;
  }

  if (op === "==") return same(at(rest[0], props, unknown), rest[1]);
  if (op === "!=") return !same(at(rest[0], props, unknown), rest[1]);
  if (op === "<=") return at(rest[0], props, unknown) <= at(rest[1], props, unknown);
  if (op === ">=") return at(rest[0], props, unknown) >= at(rest[1], props, unknown);
  if (op === "<") return at(rest[0], props, unknown) < at(rest[1], props, unknown);
  if (op === ">") return at(rest[0], props, unknown) > at(rest[1], props, unknown);

  if (op === "get") return props[rest[0]];
  if (op === "has") return props[rest[0]] !== undefined && props[rest[0]] !== null;
  if (op === "coalesce") {
    for (const part of rest) {
      const value = at(part, props, unknown);
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return null;
  }
  if (op === "length") return String(at(rest[0], props, unknown) ?? "").length;

  return true;
}

/** Evaluate an input expression, which is usually `["get", "name"]`. */
function at(node, props, unknown) {
  if (Array.isArray(node)) return passes(node, props, unknown);
  return node;
}

// ---------------------------------------------------------------- main

function tileOf(z, lon, lat) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y: Math.min(n - 1, Math.max(0, y)) };
}

async function main() {
  const { PMTiles, FetchSource } = await import(LIBRARY);
  const source = new PMTiles(new FetchSource(TILES));
  const header = await source.getHeader();
  const style = JSON.parse(readFileSync(join(ROOT, "public", "styles", "bright.json"), "utf8"));

  const stats = new Map();
  for (const layer of style.layers) {
    stats.set(layer.id, {
      layer,
      tiles: 0,
      tilesWith: 0,
      passes: 0,
      perZoom: new Map(),
    });
  }
  const unevaluated = new Set();
  let tilesSampled = 0;

  const sample = async (z, tiles) => {
    for (const { x, y } of tiles) {
      let found;
      try {
        found = await source.getZxy(z, x, y);
      } catch {
        continue;
      }
      if (!found) continue;
      const per = layersOfTile(new Uint8Array(found.data));
      tilesSampled += 1;

      for (const layer of style.layers) {
        const entry = stats.get(layer.id);
        entry.tiles += 1;
        const drawn = leafDrawn(layer, per, z, unevaluated);
        if (drawn) {
          entry.tilesWith += 1;
          entry.passes += 1;
          const at_ = entry.perZoom.get(z) || { tiles: 0, with: 0 };
          at_.tiles += 1;
          at_.with += 1;
          entry.perZoom.set(z, at_);
        } else {
          const at_ = entry.perZoom.get(z) || { tiles: 0, with: 0 };
          at_.tiles += 1;
          entry.perZoom.set(z, at_);
        }
      }
    }
  };

  for (const z of full ? [0, 1, 2, 3, 4, 5] : [0, 2, 4]) {
    const n = 2 ** z;
    const tiles = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) tiles.push({ x, y });
    process.stdout.write(`  z${z}: ${tiles.length} tiles\r`);
    await sample(z, tiles);
  }
  for (const z of [8, 10, 12, 14, 15]) {
    const tiles = [];
    for (const [, lon, lat] of PLACES) {
      const { x, y } = tileOf(z, lon, lat);
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        const n = 2 ** z;
        tiles.push({ x: Math.min(n - 1, Math.max(0, x + dx)), y: Math.min(n - 1, Math.max(0, y + dy)) });
      }
    }
    process.stdout.write(`  z${z}: ${tiles.length} tiles\r`);
    await sample(z, tiles);
  }
  console.log(`\r  sampled ${tilesSampled} tiles across z0-z15            `);

  const rows = [...stats.entries()].map(([id, entry]) => {
    const zooms = [...entry.perZoom.entries()]
      .filter(([, per]) => per.with > 0)
      .map(([z]) => z)
      .sort((a, b) => a - b);
    return {
      layer: id,
      type: entry.layer.type,
      minzoom: entry.layer.minzoom ?? 0,
      tiles: entry.tiles,
      withAny: entry.tilesWith,
      share: entry.tiles ? entry.tilesWith / entry.tiles : 0,
      zooms,
      firstZoom: zooms.length ? zooms[0] : null,
      lastZoom: zooms.length ? zooms[zooms.length - 1] : null,
    };
  });
  rows.sort((a, b) => a.share - b.share);

  if (asJson) {
    console.log(JSON.stringify({
      archive: { minZoom: header.minZoom, maxZoom: header.maxZoom },
      tilesSampled, rows, unevaluated: [...unevaluated],
    }, null, 2));
    return;
  }

  console.log(`\n  archive z${header.minZoom}-z${header.maxZoom}, ${tilesSampled} tiles sampled\n`);
  console.log(`  ${"style layer".padEnd(24)}${"type".padEnd(9)}${"z".padEnd(7)}${"drawn in".padStart(10)}  verdict`);
  for (const row of rows) {
    const pct = `${(row.share * 100).toFixed(0)}%`;
    const zoomText = row.zooms.length
      ? row.firstZoom === row.lastZoom ? `z${row.firstZoom}` : `z${row.firstZoom}-z${row.lastZoom}`
      : "never";
    const verdict = row.share === 0
      ? "nothing drawn"
      : row.share < 0.05 ? "almost nothing"
      : row.share < 0.2 ? "sparse"
      : row.share < 0.6 ? "common" : "everywhere";
    console.log(`  ${row.layer.padEnd(24)}${String(row.type).padEnd(9)}` +
      `${String(row.minzoom).padEnd(7)}${pct.padStart(10)}  ${verdict} (${zoomText})`);
  }

  console.log("\n  per zoom, tiles where the layer drew something:");
  for (const row of rows) {
    const entry = stats.get(row.layer);
    const parts = [...entry.perZoom.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([z, per]) => `z${z} ${per.with}/${per.tiles}`);
    console.log(`    ${row.layer.padEnd(22)} ${parts.join("  ")}`);
  }

  if (unevaluated.size) {
    console.log("\n  these filters were not understood and counted as passing:");
    for (const f of unevaluated) console.log(`    ${f}`);
  }
  console.log();
}

/** Does this style layer draw anything in this tile, at this zoom? */
function leafDrawn(layer, per, z, unevaluated) {
  // A layer whose minzoom is above the tile's zoom is not drawn. MapLibre does
  // this itself, and a layer at minzoom 18 on an archive whose top is z15 never
  // appears, which is exactly what happened to the house numbers.
  if (layer.minzoom !== undefined && z < layer.minzoom) return false;
  if (layer.type === "background") return true;
  const name = layer["source-layer"];
  if (!name) return false;
  const props = per.get(name);
  if (!props || !props.length) return false;
  if (!layer.filter) return props.length > 0;

  // A layer with no matching feature draws nothing, which is a real finding
  // rather than a failure to evaluate. Only an operator this does not know is
  // reported, and that is collected inside passes().
  return props.some((properties) => passes(layer.filter, properties, unevaluated));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});