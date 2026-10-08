#!/usr/bin/env node
/**
 * Measure this host against the public CDNs for the same files.
 *
 *   node tools/bench-assets.mjs                  measure, print a table
 *   node tools/bench-assets.mjs --runs 11        more samples, better median
 *   node tools/bench-assets.mjs --json           machine readable
 *
 * WHY THIS EXISTS
 *
 * Vendoring a file is only worth it if serving it from here is not worse. That is
 * a measurement, not an opinion, and the answer changes with the reader's network
 * and with where Cloudflare has put the file. So the numbers are taken from the
 * live host and compared against the CDN the page used to point at.
 *
 * WHAT IS AND IS NOT COMPARABLE
 *
 * These runs come from one machine on one network. That is a real datapoint and it
 * is not a general result: a reader in another country sees a different edge
 * location for each host. Read the table as "from here, at the time it was run",
 * and run it again from elsewhere before believing it is global.
 *
 * Two things are held equal on purpose. The same bytes are fetched, so content
 * encoding is not the story, and the connection is reused across the runs of one
 * URL so a cold TLS handshake is not counted as a slow asset. Cold-start cost is
 * real for a first-time visitor, so the connection timing is reported too.
 *
 * Nothing is deployed or changed. It only reads.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where our copies will be, once deployed. */
const OURS = "https://tiles.jasontally.com";

/**
 * Pairs to compare. The CDN URL is what the page used before, so this is the
 * question "is ours faster than what we had", not a general CDN shootout.
 */
const PAIRS = [
  {
    what: "MapLibre GL JS",
    ours: `${OURS}/vendor/maplibre-gl.js`,
    cdn: "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js",
    note: "BSD-3-Clause",
  },
  {
    what: "MapLibre GL CSS",
    ours: `${OURS}/vendor/maplibre-gl.css`,
    cdn: "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css",
    note: "BSD-3-Clause",
  },
  {
    what: "PMTiles JS",
    ours: `${OURS}/vendor/pmtiles.js`,
    cdn: "https://cdn.jsdelivr.net/npm/pmtiles@3.2.1/dist/pmtiles.js",
    note: "BSD-3-Clause",
  },
  {
    what: "glyph Noto Sans Regular 0-255",
    ours: `${OURS}/font/Noto%20Sans%20Regular/0-255.pbf`,
    cdn: "https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/0-255.pbf",
    note: "SIL OFL 1.1",
  },
  {
    what: "glyph Noto Sans Medium 0-255",
    ours: `${OURS}/font/Noto%20Sans%20Medium/0-255.pbf`,
    cdn: "https://demotiles.maplibre.org/font/Noto%20Sans%20Bold/0-255.pbf",
    note: "SIL OFL 1.1. Not the same font: Medium is what upstream calls bold",
  },
  {
    what: "sprite light.json",
    ours: `${OURS}/sprites/v4/light.json`,
    cdn: "https://protomaps.github.io/basemaps-assets/sprites/v4/light.json",
    note: "MIT, from tangrams/icons",
  },
];

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const RUNS = arg("runs", 7);
const asJson = process.argv.includes("--json");

/** One fetch, timing it, with the connection left open for the next run. */
async function time(url) {
  const started = performance.now();
  const response = await fetch(url, { headers: { "User-Agent": "pmtiles-cf-snippet-bench" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const bytes = (await response.arrayBuffer()).byteLength;
  return { ms: performance.now() - started, bytes, headers: response.headers };
}

async function measure(url) {
  const samples = [];
  let bytes = 0;
  let headers = null;
  let error = null;
  for (let i = 0; i < RUNS; i++) {
    try {
      const result = await time(url);
      samples.push(result.ms);
      bytes = result.bytes;
      headers = result.headers;
    } catch (e) {
      error = e.message;
      break;
    }
  }
  if (error) return { error, samples: [] };
  // The first sample carries the TLS handshake and any cache miss. Median of the
  // rest is the warm number; the first is reported beside it.
  const warm = samples.slice(1).sort((a, b) => a - b);
  const at = (q) => warm[Math.min(warm.length - 1, Math.floor(warm.length * q))];
  return {
    error: null,
    median: at(0.5),
    best: Math.min(...samples),
    // The middle half of the samples. Reported because a median on its own cannot
    // tell a real difference from one lucky sample, and "the CDN is faster" is a
    // claim somebody will act on.
    p25: at(0.25),
    p75: at(0.75),
    cold: samples[0],
    bytes,
    cacheControl: headers.get("cache-control"),
    encoding: headers.get("content-encoding"),
  };
}

/**
 * Whether one host is faster than the other, and how sure of it.
 *
 * Two rules, both deliberate. The gap has to clear 15%, because below that it sits
 * inside the variation of one network at one moment and calling it a result would be
 * dressing noise up as a finding. And the middle halves of the two sets of samples
 * must not overlap, because if they do then one unlucky request moved the median and
 * no amount of averaging has fixed it.
 */
function verdict(ours, cdn) {
  const ratio = ours.median / cdn.median;
  if (Math.abs(ratio - 1) < 0.15) return { text: "too close to call", ratio, sure: false };
  const faster = ratio > 1 ? "ours" : "the CDN";
  const speedup = Math.max(ratio, 1 / ratio);
  // Ours slower means: the CDN's fast half is still faster than our slow half.
  const separated = ratio > 1 ? ours.p25 > cdn.p75 : cdn.p25 > ours.p75;
  return {
    text: `${faster} ${speedup.toFixed(2)}x faster${separated ? "" : ", samples overlap"}`,
    ratio,
    sure: separated,
  };
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const rows = [];
  for (const pair of PAIRS) {
    const [ours, cdn] = await Promise.all([measure(pair.ours), measure(pair.cdn)]);
    rows.push({ ...pair, ours, cdn });
  }

  if (asJson) {
    console.log(JSON.stringify({ runs: RUNS, rows }, null, 2));
    return;
  }

  console.log(`\n  ${RUNS} requests per URL from this machine. Warm = median of runs 2..${RUNS}.`);
  console.log(`  Cold is run 1, which pays TLS. Not a general result: a reader elsewhere\n  sees a different edge for each host.\n`);
  console.log(`  ${pad("asset", 32)}${pad("ours p25-p75", 22)}${pad("cdn p25-p75", 22)}verdict`);
  const unsure = [];
  for (const row of rows) {
    if (row.ours.error || row.cdn.error) {
      console.log(`  ${pad(row.what, 32)}ours ${row.ours.error || "ok"}  cdn ${row.cdn.error || "ok"}`);
      continue;
    }
    const v = verdict(row.ours, row.cdn);
    if (!v.sure) unsure.push(`${row.what}: ${v.text}`);
    console.log(`  ${pad(row.what, 32)}` +
      `${pad(`${row.ours.p25.toFixed(0)}-${row.ours.p75.toFixed(0)} ms`, 22)}` +
      `${pad(`${row.cdn.p25.toFixed(0)}-${row.cdn.p75.toFixed(0)} ms`, 22)}${v.text}`);
  }
  if (unsure.length) {
    console.log("\n  not acted on, because the samples overlap or the gap is under 15%:");
    for (const line of unsure) console.log(`    ${line}`);
  }

  console.log("\n  sizes and caching");
  for (const row of rows) {
    if (row.ours.error || row.cdn.error) continue;
    console.log(`  ${pad(row.what, 32)}` +
      `ours ${String(row.ours.bytes).padStart(9)} B  cache-control: ${row.ours.cacheControl || "(none)"}`);
    console.log(`  ${pad("", 32)}` +
      `cdn  ${String(row.cdn.bytes).padStart(9)} B  cache-control: ${row.cdn.cacheControl || "(none)"}`);
  }

  console.log(`\n  licences`);
  for (const row of rows) console.log(`  ${pad(row.what, 32)}${row.note}`);
  console.log();
}

main().catch((error) => {
  console.error(`bench failed: ${error.message}`);
  process.exit(1);
});