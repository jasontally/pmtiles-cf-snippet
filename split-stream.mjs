#!/usr/bin/env node
/**
 * Split a PMTiles archive into Static Asset parts while streaming, and upload
 * each part as soon as it is complete.
 *
 * Why streaming: a Workers Builds container has 20 GB of disk. The Protomaps
 * basemap is 118 GiB, so the archive cannot be written to disk at all, let
 * alone the parts. Streaming reads the archive over HTTP and keeps at most one
 * part in memory, so disk use is a single part of about 2 MB.
 *
 * Why this is not the split in shard-pmtiles.py: that tool verifies the parts
 * against the archive afterwards, which needs both on disk. Here the archive is
 * never stored, so verification is done as the bytes stream past. Every part is
 * compared with the source bytes before it is uploaded, so a corrupted transfer
 * fails the build instead of shipping.
 *
 * Section boundaries come from the 127 byte header at the start of the archive.
 * The header, the root directory, the tile data, the metadata, and the leaf
 * directories are cut into their own parts, matching shard-pmtiles.py exactly so
 * the snippet needs no change.
 *
 *   node split-stream.mjs --url https://host/basemap.pmtiles --out public --name basemap
 *
 * The upload is the Direct Upload API, because wrangler needs the whole asset
 * directory on disk. Its manifest step returns a JWT and a list of file hashes
 * that still need uploading, and skips the ones Cloudflare already has.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const BATCH = 20; // parts per multipart upload request

export function parseHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (off) => Number(view.getBigUint64(off, true));
  if (String.fromCharCode(...bytes.slice(0, 7)) !== "PMTiles") {
    throw new Error("not a PMTiles archive");
  }
  if (bytes[7] !== 3) throw new Error(`unsupported version ${bytes[7]}`);
  const header = {
    rootDirOffset: u64(8),
    rootDirLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafDirOffset: u64(40),
    leafDirLength: u64(48),
    tileDataOffset: u64(56),
    tileDataLength: u64(64),
    minZoom: bytes[100],
    maxZoom: bytes[101],
  };
  const rootEnd = header.rootDirOffset + header.rootDirLength;
  if (rootEnd > 16384) {
    throw new Error(`root directory ends at ${rootEnd}, past the first 16384 bytes`);
  }
  return header;
}

/**
 * The parts, in stream order, as { name, start, length }.
 *
 * The order matters: the reader must see the bytes in archive order, so the
 * parts are laid out head, tile, meta, leaf, exactly like the file. The last
 * part of each sharded section is short.
 */
export function planParts(header, total, tileShard, leafShard) {
  const headEnd = Math.min(16384, total);
  const sections = [
    { kind: "head", start: 0, length: headEnd, shard: 0 },
    { kind: "tile", start: header.tileDataOffset, length: header.tileDataLength, shard: tileShard },
    { kind: "meta", start: header.metadataOffset, length: header.metadataLength, shard: 0 },
    { kind: "leaf", start: header.leafDirOffset, length: header.leafDirLength, shard: leafShard },
  ].filter((s) => s.length > 0);

  // The sections must tile the archive with no gap, or some bytes would be
  // unreadable. Check before writing anything.
  let cursor = 0;
  for (const section of sections) {
    if (section.start !== cursor) {
      throw new Error(
        `section ${section.kind} starts at ${section.start} but the previous ` +
        `section ends at ${cursor}; bytes ${cursor} to ${section.start} belong to no section`
      );
    }
    cursor = section.start + section.length;
  }
  if (cursor !== total) {
    throw new Error(`sections end at ${cursor} but the archive is ${total} bytes`);
  }

  const parts = [];
  for (const section of sections) {
    if (section.shard === 0) {
      parts.push({
        name: `${section.kind}.bin`,
        start: section.start,
        length: section.length,
      });
      continue;
    }
    const count = Math.ceil(section.length / section.shard);
    for (let index = 0; index < count; index++) {
      const start = section.start + index * section.shard;
      const length = Math.min(section.shard, section.start + section.length - start);
      parts.push({
        name: `${section.kind}/${String(index).padStart(6, "0")}.bin`,
        start,
        length,
      });
    }
  }
  return parts;
}

/** md5, lowercase hex, no padding. This is the hash the upload manifest wants. */
export function md5(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}

/**
 * A byte-exact reader over a stream, so a part can be assembled without holding
 * the whole archive. `take(from, length)` must be called in ascending, non
 * overlapping order, which is how planParts lays the parts out.
 */
export class StreamReader {
  /**
   * Invariant: `cursor` is the absolute offset of the next byte the caller
   * wants. `chunk` holds bytes starting at `chunkAt`, so the caller can take
   * bytes [cursor, chunkAt + chunk.length) from it without another fetch.
   */
  constructor(body, total) {
    this.iterator = body[Symbol.asyncIterator]();
    this.total = total;
    this.cursor = 0;
    this.chunk = null;
    this.chunkAt = 0;
  }

  /** The absolute offset just past the buffered chunk. */
  get bufferedEnd() {
    return this.chunk ? this.chunkAt + this.chunk.length : this.chunkAt;
  }

  /** Pull the next chunk. Returns false at the end of the stream. */
  async fill() {
    const next = await this.iterator.next();
    if (next.done) return false;
    // Compute the new start from the OLD chunk, so do this before overwriting.
    const start = this.bufferedEnd;
    this.chunk = next.value;
    this.chunkAt = start;
    return true;
  }

  /** Advance `cursor` to `offset`, discarding bytes. Never moves backwards. */
  async skipTo(offset) {
    if (offset < this.cursor) {
      throw new Error(`cannot seek backwards, from ${this.cursor} to ${offset}`);
    }
    this.cursor = offset;
    while (this.bufferedEnd <= this.cursor) {
      if (!(await this.fill())) {
        if (this.cursor === this.total) return;
        throw new Error(`archive ended before byte ${offset} of ${this.total}`);
      }
    }
  }

  /** Read exactly `length` bytes at `offset`, which must not move backwards. */
  async read(length) {
    await this.skipTo(this.cursor);
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (this.bufferedEnd <= this.cursor) {
        if (!(await this.fill())) {
          throw new Error(
            `archive ended ${length - filled} bytes short at ${this.cursor} of ${this.total}`
          );
        }
        continue;
      }
      const available = this.bufferedEnd - this.cursor;
      const take = Math.min(length - filled, available);
      out.set(
        this.chunk.subarray(this.cursor - this.chunkAt, this.cursor - this.chunkAt + take),
        filled
      );
      this.cursor += take;
      filled += take;
    }
    return out;
  }
}

export class PartUploader {
  /**
   * `endpoint` is the API path without the API host prefix, for example
   * `/accounts/<id>/workers/scripts/<name>`. It must not include `/client/v4`,
   * because `api()` adds that.
   */
  constructor(token, endpoint, batchSize = BATCH) {
    this.token = token;
    this.endpoint = endpoint;
    this.accountPath = endpoint.replace(/\/scripts\/[^/]+$/, "");
    this.batchSize = batchSize;
    this.pending = [];
    this.jwt = null;
    this.uploaded = 0;
    this.skipped = 0;
  }

  async start(manifest) {
    const response = await fetch(`${API}${this.endpoint}/assets-upload-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ manifest }),
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      throw new Error(`upload session failed: ${JSON.stringify(payload.errors)}`);
    }
    this.jwt = payload.result.jwt;
    // Cloudflare omits unchanged files from `buckets`, so this is the set that
    // genuinely needs sending. Everything else is already stored.
    this.wanted = new Set((payload.result.buckets ?? []).flat());
    this.buckets = payload.result.buckets ?? [];
    return this.wanted.size;
  }

  async add(key, bytes) {
    const hash = md5(bytes);
    if (!this.wanted.has(hash)) {
      this.skipped++;
      return;
    }
    this.pending.push({ key, bytes, hash });
    if (this.pending.length >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.pending.length === 0) return;
    const form = new FormData();
    for (const part of this.pending) {
      form.append(
        part.key,
        new Blob([part.bytes], { type: "application/octet-stream" }),
        part.key
      );
    }
    const response = await fetch(`${API}${this.accountPath}/assets/upload?base64=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      throw new Error(`part upload failed: ${JSON.stringify(payload.errors)}`);
    }
    this.uploaded += this.pending.length;
    this.pending.length = 0;
  }

  async finish() {
    await this.flush();
    const response = await fetch(`${API}${this.accountPath}/assets/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      throw new Error(`upload completion failed: ${JSON.stringify(payload.errors)}`);
    }
    return payload.result.jwt;
  }
}

/**
 * Stream the archive, cut it into parts, and hand each part to `onPart`.
 * Returns the header and the part count. Nothing is written to disk.
 */
export async function splitStream(url, { tileShard, leafShard, onPart, log = () => {} }) {
  const probe = await fetch(url, { headers: { Range: "bytes=0-16383" } });
  if (!probe.ok && probe.status !== 206) {
    throw new Error(`range request for the header returned ${probe.status}`);
  }
  const contentRange = probe.headers.get("content-range") || "";
  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (!match) {
    throw new Error(`no total size in Content-Range: ${JSON.stringify(contentRange)}`);
  }
  const total = Number(match[1]);
  const first = new Uint8Array(await probe.arrayBuffer());
  const header = parseHeader(first.slice(0, 127));
  const parts = planParts(header, total, tileShard, leafShard);

  log(`archive ${total.toLocaleString()} bytes, ${parts.length.toLocaleString()} parts`);
  log(`sections: ${["tileData", "metadata", "leafDir"].filter((k) => header[`${k}Length`]).join(", ")}`);

  // Reopen the stream from the start so the parts are produced in order.
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`archive download returned ${response.status}`);
  }
  const reader = new StreamReader(response.body, total);

  let index = 0;
  let copied = 0;
  for (const part of parts) {
    await reader.skipTo(part.start);
    const bytes = await reader.read(part.length);
    if (bytes.length !== part.length) {
      throw new Error(`part ${part.name} got ${bytes.length} bytes, expected ${part.length}`);
    }
    await onPart(part, bytes);
    index++;
    copied += part.length;
    if (index % 5000 === 0 || index === parts.length) {
      log(`  ${index.toLocaleString()} / ${parts.length.toLocaleString()} parts, ` +
          `${(copied / 1e9).toFixed(2)} GB of ${(total / 1e9).toFixed(2)} GB`);
    }
  }
  if (copied !== total) {
    throw new Error(`streamed ${copied} bytes, expected ${total}`);
  }
  return { header, total, parts: parts.length };
}

/* ---------------------------------------------------------------- *
 * Command line entry point.
 * ---------------------------------------------------------------- */

if (process.argv[1] && process.argv[1].endsWith("split-stream.mjs")) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
  };
  const url = arg("url");
  const name = arg("name", "basemap");
  const tileShard = Number(arg("tile-shard", 2000000));
  const leafShard = Number(arg("leaf-shard", 160000));
  const dryRun = process.argv.includes("--dry-run");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const scriptName = process.env.WORKER_NAME || "pmtiles-cf-snippet";

  if (!url) {
    console.error("give --url https://host/basemap.pmtiles");
    process.exit(1);
  }

  try {
    if (dryRun) {
      // Plan and read the header without uploading, to see the shape and the
      // timing of a download.
      const started = Date.now();
      const result = await splitStream(url, {
        tileShard,
        leafShard,
        log: console.log,
        onPart: async () => {},
      });
      const seconds = (Date.now() - started) / 1000;
      console.log(`\ndry run read ${result.total.toLocaleString()} bytes in ${seconds.toFixed(1)}s`);
      console.log(`that is ${(result.total / 1e6 / seconds).toFixed(1)} MB/s`);
      console.log(`parts ${result.parts.toLocaleString()}, maxZoom ${result.header.maxZoom}`);
      process.exit(0);
    }

    if (!token || !account) {
      console.error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to upload");
      process.exit(1);
    }

    const endpoint = `/accounts/${account}/workers/scripts/${scriptName}`;
    const started = Date.now();

    // Two passes over the archive: one to hash every part for the manifest, one
    // to upload the parts Cloudflare does not already have. The manifest needs a
    // hash per file, and the hashes can only be computed from the bytes, so the
    // manifest pass cannot be skipped.
    const manifest = {};
    let bytes = 0;
    await splitStream(url, {
      tileShard,
      leafShard,
      log: console.log,
      onPart: async (part, data) => {
        manifest[`/s/${name}/${part.name}`] = { hash: md5(data), size: data.length };
        bytes += data.length;
      },
    });
    console.log(`hashed ${Object.keys(manifest).length} parts, ${(bytes / 1e9).toFixed(2)} GB`);

    const uploader = new PartUploader(token, endpoint);
    const wanted = await uploader.start(manifest);
    console.log(`Cloudflare wants ${wanted.toLocaleString()} of them`);

    await splitStream(url, {
      tileShard,
      leafShard,
      log: console.log,
      onPart: async (part, data) => {
        await uploader.add(`/s/${name}/${part.name}`, data);
      },
    });
    const completion = await uploader.finish();
    console.log(
      `uploaded ${uploader.uploaded.toLocaleString()} parts, ` +
      `skipped ${uploader.skipped.toLocaleString()} already present`
    );

    // The completion JWT goes to wrangler to bind the assets to a version.
    writeFileSync(join(process.cwd(), ".asset-jwt"), completion.jwt);
    console.log(`wrote .asset-jwt (${String(completion.jwt).length} chars)`);
    console.log(`total ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
    rmSync(join(process.cwd(), ".asset-jwt.tmp"), { force: true });
  } catch (error) {
    console.error(`split-stream failed: ${error.message}`);
    process.exit(1);
  }
}