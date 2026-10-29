#!/usr/bin/env node
/**
 * Generate the per-tile preload table from a PMTiles archive.
 *
 * The table holds one archive byte range per zoom-five tile, so the preload
 * snippet can fetch the bytes the first map view draws instead of the whole
 * megabyte part that holds them.
 *
 * The archive is read with range requests only: the header, the root directory
 * and one leaf directory. A remote archive is never downloaded.
 *
 * WHY THE BYTES COME FROM THE SHARDS
 *
 * The obvious source is the host this build publishes, the one the preload
 * snippet reads from. It cannot be. That host runs the reader this build is
 * about to replace, and the reader answers a range past its own total with 416.
 * When the archive has grown, the reader still carries the old total, so it
 * refuses the leaf directory that the new offsets name, and the build fails
 * before it can publish the reader that would have fixed it. The build and the
 * reader were each waiting for the other.
 *
 * So the generator reads the shards instead. They hold the archive, and the
 * reader constants in snippet.js say where the sections are, so the generator
 * reads the same files the reader reads, with the same offsets. The table then
 * describes the archive the reader will serve, and the build no longer depends
 * on the reader being up to date.
 *
 * The header that comes back is checked against those constants. A reader whose
 * offsets do not match the archive would serve the wrong bytes, so a build that
 * finds a mismatch stops there instead of publishing a table for another
 * archive.
 */
import { mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";
import { ARCHIVES, assetFile, assetUrl } from "../snippet.js";

const pmtilesCode = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "vendor", "pmtiles.js"), "utf8");
const sandbox = { console, fetch, URL, Headers };
vm.createContext(sandbox);
vm.runInContext(pmtilesCode, sandbox);
const pm = sandbox.pmtiles;

function flag(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
}
const args = process.argv.slice(2);
const tablePath = flag("--table", "dist/preload-table.txt");
const metaPath = flag("--meta", "dist/preload-meta.json");
const archiveName = flag("--archive-name", "basemap");
const archivePath = flag("--archive", "");

/**
 * Read the archive from the shards, through the same files the reader reads.
 *
 * Shard 0 holds the head, the metadata and the leaf directories. The generator
 * needs the head and one leaf directory, so two files are fetched and the leaf
 * file is 160 KB. The reader constants say where the sections are, so the
 * offsets here are the reader's own.
 */
export function shardSource(name, reader, fetchImpl = fetch) {
  const files = new Map();
  const file = (kind, index) => {
    const key = `${kind}/${index}`;
    if (!files.has(key)) {
      files.set(key, fetchImpl(assetUrl(name, 0, kind, index)).then(async (response) => {
        if (!response.ok) {
          throw new Error(`${assetFile(kind, index)} returned ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      }));
    }
    return files.get(key);
  };
  return async function readRange(offset, length) {
    if (offset < reader.headEnd) {
      const head = await file("head", 0);
      if (offset + length > head.length) {
        throw new Error(
          `head.bin is ${head.length} bytes, and byte ${offset + length - 1} was asked for`
        );
      }
      return head.subarray(offset, offset + length);
    }
    if (offset >= reader.leafOffset) {
      const within = offset - reader.leafOffset;
      const first = Math.floor(within / reader.leafShard);
      const last = Math.floor((within + length - 1) / reader.leafShard);
      const pieces = [];
      for (let index = first; index <= last; index++) {
        const part = await file("leaf", index);
        const start = Math.max(within, index * reader.leafShard) - index * reader.leafShard;
        const end = Math.min(within + length, (index + 1) * reader.leafShard) - index * reader.leafShard;
        if (end > part.length) {
          throw new Error(
            `leaf part ${index} is ${part.length} bytes, and byte ${end - 1} was asked for`
          );
        }
        pieces.push(part.subarray(start, end));
      }
      if (pieces.length === 1) return pieces[0];
      const out = new Uint8Array(length);
      let at = 0;
      for (const piece of pieces) {
        out.set(piece, at);
        at += piece.length;
      }
      return out;
    }
    throw new Error(`byte ${offset} is in the tile section, and the generator reads no tiles`);
  };
}

/**
 * Read the archive from a file, or from a URL that answers range requests.
 *
 * A build that holds the archive reads the file. Only the bytes asked for are
 * read: the archive is about 140 GB and the generator needs a few hundred KB of it.
 */
export function archiveSource(path, fetchImpl = fetch) {
  if (/^https?:\/\//.test(path)) {
    return async function readRange(offset, length) {
      const resp = await fetchImpl(path, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (!resp.ok) throw new Error(`fetch ${offset} returned ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    };
  }
  const fd = openSync(path, "r");
  return async function readRange(offset, length) {
    const out = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, out, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    if (read < length) {
      throw new Error(
        `the archive is ${offset + read} bytes, and byte ${offset + length - 1} was asked for`
      );
    }
    return new Uint8Array(out);
  };
}

/**
 * The archive and the reader must describe the same bytes.
 *
 * A reader whose offsets do not match the archive serves the wrong bytes, and
 * a preload table for another archive warms the wrong spans. So the build stops
 * here instead of publishing either.
 */
export function checkLayout(header, reader) {
  const checks = [
    ["tile data", header.tileDataOffset, reader.tileOffset],
    ["metadata", header.jsonMetadataOffset, reader.metaOffset],
    ["leaf directory", header.leafDirectoryOffset, reader.leafOffset],
    ["total", header.leafDirectoryOffset + header.leafDirectoryLength, reader.total],
  ];
  for (const [what, fromArchive, fromReader] of checks) {
    if (fromArchive !== fromReader) {
      throw new Error(
        `the archive and the reader disagree about the ${what} offset: ` +
        `${fromArchive} in the archive, ${fromReader} in the reader constants`
      );
    }
  }
}

function decompress(data, code) {
  if (code === 1 || code === "none") return data;
  if (code === 2 || code === "gzip") return gunzipSync(data);
  throw new Error(`unsupported internal compression ${code}`);
}

function deserializeIndex(buffer) {
  const p = { buf: buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), pos: 0 };
  const readVarint = () => pm.readVarint(p);
  const numEntries = readVarint();
  const entries = [];
  let lastId = 0;
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint();
    entries.push({ tileId: lastId + v, offset: 0, length: 0, runLength: 1 });
    lastId += v;
  }
  for (let i = 0; i < numEntries; i++) entries[i].runLength = readVarint();
  for (let i = 0; i < numEntries; i++) entries[i].length = readVarint();
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint();
    if (v === 0 && i > 0) {
      entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    } else {
      entries[i].offset = v - 1;
    }
  }
  return entries;
}

/**
 * Read the archive and write the table and the meta file.
 *
 * The reader is the description of the archive, so its constants are checked
 * against the header before anything is written. A build that finds a mismatch
 * stops here, because a table for another archive warms the wrong spans.
 */
export async function generate({ reader, source, tablePath, metaPath }) {
  const directoryCache = new Map();

  async function directoryAt(offset, length) {
    const key = `${offset}:${length}`;
    if (directoryCache.has(key)) return directoryCache.get(key);
    const slice = await source(offset, length);
    const data = decompress(slice, header.internalCompression);
    const result = deserializeIndex(data);
    directoryCache.set(key, result);
    return result;
  }

  const headerBytes = await source(0, pm.HEADER_SIZE_BYTES || 127);
  const header = pm.bytesToHeader(
    headerBytes instanceof Uint8Array ? headerBytes.buffer : headerBytes,
    null
  );
  checkLayout(header, reader);
  const rootDirectory = await directoryAt(header.rootDirectoryOffset, header.rootDirectoryLength);

  function findTile(entries, tileId) {
    return (pm.findTile ? pm.findTile(entries, tileId) : entries.find((e) => e.tileId <= tileId && tileId < e.tileId + e.runLength));
  }

  // The first map view asks for a small window of zoom-five tiles: the viewer's
  // own tile plus at most one tile on each side, because the map opens centred on
  // the request coordinates. This resolves one tile's archive byte range, which is
  // what the preload snippet fetches instead of the whole megabyte part that holds
  // it. Reading the range costs nothing here: the leaf directory below is the one
  // the snippet already preloads, and it was read for the fixed ranges anyway.
  async function tileRange(z, x, y) {
    const tileId = pm.zxyToTileId(z, x, y);
    const rootEntry = findTile(rootDirectory, tileId);
    if (!rootEntry) return null;
    let entry = rootEntry;
    if (rootEntry.runLength === 0) {
      const leaf = await directoryAt(header.leafDirectoryOffset + rootEntry.offset, rootEntry.length);
      entry = findTile(leaf, tileId);
    }
    return entry && entry.runLength > 0 ? entry : null;
  }

const PRELOAD_ZOOM = 5;
const PRELOAD_SIDE = 1 << PRELOAD_ZOOM;

// Three archive reads happen at the same offsets on every first view: the head,
// which carries the header and the root directory; the JSON metadata the page
// reads for its layer table; and one leaf directory, which the whole zoom-five
// tile range falls into. preload-snippet.js carries them so the first view needs
// no serial directory round trips. Every zoom-five tile has to share that one
// leaf directory, so this fails the build rather than emit a range that only
// some viewers would hit.
const HEAD_LENGTH = 16384; // pmtiles 3.x reads getBytes(0, 16384) for header and root

  function fixedRanges() {
    const ranges = [
      [0, HEAD_LENGTH],
      [header.jsonMetadataOffset, header.jsonMetadataLength],
    ];
    let leaf = null;
    for (let x = 0; x < PRELOAD_SIDE; x++) {
      for (let y = 0; y < PRELOAD_SIDE; y++) {
        const entry = findTile(rootDirectory, pm.zxyToTileId(PRELOAD_ZOOM, x, y));
        if (!entry || entry.runLength !== 0) {
          throw new Error(`zoom-five tile ${x}_${y} is not behind a leaf directory`);
        }
        const range = [header.leafDirectoryOffset + entry.offset, entry.length];
        if (leaf === null) leaf = range;
        else if (leaf[0] !== range[0] || leaf[1] !== range[1]) {
          throw new Error("zoom-five tiles fall in more than one leaf directory");
        }
      }
    }
    ranges.push(leaf);
    return ranges;
  }

  // One entry per zoom-five tile in grid order, index x * 32 + y. The entry is the
  // byte range of that tile's data in base 36: offset then length, absolute, so a
  // reader needs no running state to decode it. A missing tile is a bare "0", a
  // range no tile can have. The snippet reads nine of these per request, for the
  // window around the viewer.
  const tableRows = [];
  let missing = 0;
  for (let x = 0; x < PRELOAD_SIDE; x++) {
    for (let y = 0; y < PRELOAD_SIDE; y++) {
      const entry = await tileRange(PRELOAD_ZOOM, x, y);
      if (!entry) {
        missing++;
        tableRows.push("0");
        continue;
      }
      tableRows.push(`${(header.tileDataOffset + entry.offset).toString(36)}.${entry.length.toString(36)}`);
    }
  }

  mkdirSync(dirname(tablePath), { recursive: true });
  // The leading "1" is the table format. A snippet that meets anything else reads
  // no tile at all and preloads only the fixed ranges, which is the safe outcome
  // for a snippet deployed beside a table from another version.
  const table = `1;${tableRows.join(";")}`;
  writeFileSync(tablePath, table);
  console.log(`wrote ${tableRows.length} tile ranges to ${tablePath} (${missing} tiles without data)`);

  mkdirSync(dirname(metaPath), { recursive: true });
  const meta = {
    // The archive size, for the Content-Range of a served range, and the fixed
    // ranges themselves.
    total: header.leafDirectoryOffset + header.leafDirectoryLength,
    ranges: fixedRanges(),
  };
  writeFileSync(metaPath, JSON.stringify(meta));
  console.log(`wrote fixed ranges to ${metaPath}`);
  return { table, meta };
}

async function main() {
  const reader = ARCHIVES[archiveName];
  if (!reader) throw new Error(`snippet.js has no archive named ${archiveName}`);

  // The shards hold the archive and the reader constants say where the sections
  // are, so the generator reads the same files the reader reads. A build that
  // holds the archive reads that instead: it is about to publish those bytes.
  const source = archivePath ? archiveSource(archivePath) : shardSource(archiveName, reader);
  console.log(
    archivePath
      ? `reading the archive ${archivePath}`
      : `reading the shards for ${archiveName}`
  );
  await generate({ reader, source, tablePath, metaPath });
}

if (process.argv[1] && process.argv[1].endsWith("generate-preloads.mjs")) {
  await main();
}
