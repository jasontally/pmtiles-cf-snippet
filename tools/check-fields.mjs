#!/usr/bin/env node
/**
 * Does the archive we serve carry the two fields the waiting layers need?
 *
 *   node tools/check-fields.mjs
 *
 * Answers it from the tiles, not from the metadata. The metadata lists the fields
 * Protomaps declares, which is close to the same thing but not the same thing, and
 * the difference is the thing being asked about: a field written into a tile and
 * never declared, or declared and never written.
 *
 * Reads the tile's key list as protobuf rather than searching its bytes for a
 * substring. That distinction matters more than it sounds: `shield_text_length`
 * contains `shield_text`, so a substring search reports the former as the latter and
 * the answer comes back wrong. The first version of this did exactly that.
 *
 * Reads through the public reader with Range requests. No credential, no local copy.
 * The tile cannot be fetched by path because the reader answers range requests, not
 * the flat scheme, so the archive's directory is walked through the PMTiles library.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TILES = "https://tiles.jasontally.com/basemap.pmtiles";
/**
 * The PMTiles library, ESM build, so this can `import` it.
 *
 * The copy published at /vendor is the UMD build, which does not import in Node:
 * `import` gives an empty namespace and `require` gives an empty object. The ESM
 * build is a different file of the same package and the same version, so this is
 * kept beside the script rather than under assets/, because it is a development
 * tool and nothing here is served with it.
 *
 * If the vendored version moves, move this with it: they are the same package.
 */
const LIBRARY = join(ROOT, "tools", ".pmtiles-cdn.mjs");
const LIBRARY_VERSION = "3.2.1";

/**
 * A tile, and why it is here. The archive runs z0 to z15, so z16 is out of bounds.
 *
 * Chosen to cover the two things being asked about, across several cities with
 * different tagging habits: the biggest roads in a city, interstates outside one,
 * and dense building footprints. A tile with only water in it proves nothing and
 * two of the first attempts were exactly that.
 */
const LOOK_AT = [
  { name: "Berlin z15", z: 15, x: 17500, y: 10773 },
  { name: "London z15", z: 15, x: 16391, y: 10890 },
  { name: "San Francisco z15", z: 15, x: 5241, y: 12666 },
  { name: "Chicago z15", z: 15, x: 6646, y: 12181 },
  { name: "Frankfurt z15", z: 15, x: 17352, y: 11279 },
  { name: "New Jersey Turnpike z13", z: 13, x: 2411, y: 3080 },
  { name: "Atlanta z14", z: 14, x: 4516, y: 6555 },
  { name: "Dallas z14", z: 14, x: 4516, y: 6556 },
  { name: "Sydney z14", z: 14, x: 45054, y: 28127 },
  { name: "Toronto z14", z: 14, x: 9122, y: 11327 },
  { name: "Amsterdam z15", z: 15, x: 16669, y: 10966 },
  { name: "Tokyo z15", z: 15, x: 29127, y: 12902 },
];

/** The keys being asked about. */
const LOOKING_FOR = ["shield_text", "addr_housenumber", "addr_housenumber:en", "housenumber"];
/** A key that is certainly there, so the decoder can be shown to be working. */
const CONTROL = ["shield_text_length", "kind", "name"];

/** Read one varint. Returns [value, position after it]. */
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

/** Walk the fields of one protobuf message. Calls back (field, wire, bytes). */
function fields(body, callback) {
  let pos = 0;
  while (pos < body.length) {
    const [tag, after] = varint(body, pos);
    const [, field] = [tag & 7, tag >> 3];
    const wire = tag & 7;
    pos = after;
    if (wire === 2) {
      const [length, afterLength] = varint(body, pos);
      const slice = body.subarray(afterLength, afterLength + length);
      callback(field, wire, slice);
      pos = afterLength + length;
    } else if (wire === 0) {
      const [, afterValue] = varint(body, pos);
      callback(field, wire, null);
      pos = afterValue;
    } else if (wire === 1) {
      callback(field, wire, null);
      pos += 8;
    } else if (wire === 5) {
      callback(field, wire, null);
      pos += 4;
    } else {
      return; // groups, or corrupt. Nothing here is in either.
    }
  }
}

/**
 * The key list of every layer in an MVT tile.
 *
 * A tile holds layers; a layer holds keys and values. Only the keys are wanted, so
 * only the layer's field 3 is read. The other fields are walked past rather than
 * skipped blindly, because a layer's version and extent are varints and stopping at
 * the first one is how the first version of this returned two keys from a tile with
 * twenty.
 */
function keysOf(tile) {
  const found = new Set();
  fields(tile, (field, wire, bytes) => {
    if (field !== 3 || wire !== 2) return; // 3 = Layer
    fields(bytes, (layerField, layerWire, layerBytes) => {
      if (layerField !== 3 || layerWire !== 2) return; // 3 = keys
      found.add(Buffer.from(layerBytes).toString("utf8"));
    });
  });
  return found;
}

/** The layer names, so it is clear which layer a key came from. */
function layersOf(tile) {
  const found = new Map();
  fields(tile, (field, wire, bytes) => {
    if (field !== 3 || wire !== 2) return;
    let name = null;
    const keys = new Set();
    fields(bytes, (layerField, layerWire, layerBytes) => {
      if (layerField === 1 && layerWire === 2) name = Buffer.from(layerBytes).toString("utf8");
      if (layerField === 3 && layerWire === 2) keys.add(Buffer.from(layerBytes).toString("utf8"));
    });
    if (name) found.set(name, keys);
  });
  return found;
}

async function main() {
  const { PMTiles, FetchSource } = await import(LIBRARY);
  const source = new PMTiles(new FetchSource(TILES));

  const header = await source.getHeader();
  console.log(`  reading ${TILES}`);
  console.log(`  zoom ${header.minZoom} to ${header.maxZoom}, tile type ${header.tileType}` +
    ` (1 = vector MVT)\n`);
  console.log(`  ${"tile".padEnd(28)}${"bytes".padStart(9)}${"keys".padStart(6)}   carries`);

  const counts = new Map();
  const control = new Map();
  for (const probe of LOOK_AT) {
    let found;
    try {
      found = await source.getZxy(probe.z, probe.x, probe.y);
    } catch (error) {
      console.log(`  ${probe.name.padEnd(28)}${"-".padStart(9)}   ${error.message}`);
      continue;
    }
    if (!found) {
      console.log(`  ${probe.name.padEnd(28)}${"none".padStart(9)}${"-".padStart(6)}   no tile there`);
      continue;
    }
    // getZxy decompresses already.
    const tile = new Uint8Array(found.data);
    const keys = keysOf(tile);
    for (const key of LOOKING_FOR) if (keys.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
    for (const key of CONTROL) if (keys.has(key)) control.set(key, (control.get(key) || 0) + 1);
    const layers = layersOf(tile);
    console.log(`  ${probe.name.padEnd(28)}${tile.length.toLocaleString().padStart(9)}` +
      `${String(keys.size).padStart(6)}   layers ${[...layers.keys()].join(",")}`);
  }

  console.log("\n  the keys asked about, counted across every tile read:");
  for (const key of LOOKING_FOR) {
    console.log(`    ${key.padEnd(20)} ${counts.get(key) ? `in ${counts.get(key)} tile(s)` : "in no tile"}`);
  }
  console.log("\n  and the control, to show the decoder works:");
  for (const key of CONTROL) {
    console.log(`    ${key.padEnd(20)} ${control.get(key) ? `in ${control.get(key)} tile(s)` : "in no tile"}`);
  }

  // What the archive declares, which is the other half of the answer.
  const meta = await source.getMetadata();
  console.log("\n  what the archive declares about itself:");
  for (const id of ["roads", "buildings"]) {
    const layer = meta.vector_layers.find((l) => l.id === id);
    const keys = Object.keys(layer.fields || {}).sort();
    for (const key of id === "roads" ? ["shield_text", "shield_text_length"] : ["addr_housenumber", "kind"]) {
      console.log(`    ${(id + "." + key).padEnd(30)} ${keys.includes(key) ? "declared" : "NOT declared"}`);
    }
  }
  console.log();
}

main().catch((error) => {
  console.error(`check-fields failed: ${error.message}`);
  process.exit(1);
});