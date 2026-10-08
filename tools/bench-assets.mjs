#!/usr/bin/env node
/**
 * Measure this host against the public CDNs for the same files.
 *
 *   node tools/bench-assets.mjs                  measure, print a table
 *   node tools/bench-assets.mjs --runs 21        more samples
 *   node tools/bench-assets.mjs --json           machine readable
 *
 * WHY THE MEASUREMENT IS DELIBERATE AND FUSSY
 *
 * The first version of this measured the two hosts at the same time with
 * Promise.all, and reported that this host was 1.5 to 1.7 times slower. It also
 * measured them one after the other and reported this host 2.3 times FASTER, with
 * nothing having changed. Both were wrong for the same reason: with two requests in
 * flight at every instant the timing depends on which socket the kernel hands back.
 *
 * So the two are interleaved one request at a time, alternating which goes first,
 * on one connection that is reused, and the first three samples are thrown away so
 * neither TLS nor a cold edge cache is in the numbers.
 *
 * It also splits the time in two, because the two parts mean different things:
 *
 *   ttfb  how long until the first byte. Edge lookup and origin behaviour. This is
 *         where this host and a CDN differ, and it is what the verdict is based on.
 *   body  transferring the bytes. Bandwidth, which is the reader's connection and
 *         not the host. It comes out the same for both and including it only adds
 *         noise.
 *
 * WHAT THIS IS NOT
 *
 * One machine, one network, one city, one moment. A reader elsewhere meets a
 * different edge for each host and the ranking can flip. Read it as "from here, at
 * the time it was run", and run it again from elsewhere before believing it is
 * global. Nothing here is deployed or changed; it only reads.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const OURS = "https://tiles.jasontally.com";

/**
 * Pairs to compare. The CDN URL is what the page loads, so this answers "is ours
 * faster than what the page uses", not a general CDN shootout.
 */
const PAIRS = [
  {
    what: "MapLibre GL JS",
    ours: `${OURS}/vendor/maplibre-gl.js`,
    cdn: "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js",
    licence: "BSD-3-Clause",
    use: "cdn",
  },
  {
    what: "MapLibre GL CSS",
    ours: `${OURS}/vendor/maplibre-gl.css`,
    cdn: "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css",
    licence: "BSD-3-Clause",
    use: "cdn",
  },
  {
    what: "PMTiles JS",
    ours: `${OURS}/vendor/pmtiles.js`,
    cdn: "https://cdn.jsdelivr.net/npm/pmtiles@3.2.1/dist/pmtiles.js",
    licence: "BSD-3-Clause",
    use: "cdn",
  },
  {
    what: "glyph Noto Sans Regular",
    ours: `${OURS}/font/Noto%20Sans%20Regular/0-255.pbf`,
    cdn: "https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/0-255.pbf",
    licence: "SIL OFL 1.1",
    use: "ours",
  },
  {
    what: "glyph Noto Sans Medium",
    ours: `${OURS}/font/Noto%20Sans%20Medium/0-255.pbf`,
    cdn: "https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Medium/0-255.pbf",
    licence: "SIL OFL 1.1",
    use: "ours",
  },
  {
    what: "sprite light.json",
    ours: `${OURS}/sprites/v4/light.json`,
    cdn: "https://protomaps.github.io/basemaps-assets/sprites/v4/light.json",
    licence: "MIT, from tangrams/icons",
    use: "ours",
  },
  {
    what: "sprite light.png",
    ours: `${OURS}/sprites/v4/light.png`,
    cdn: "https://protomaps.github.io/basemaps-assets/sprites/v4/light.png",
    licence: "MIT, from tangrams/icons",
    use: "ours",
  },
];

/** Samples thrown away at the start of each URL: TLS, and a cold edge cache. */
const DISCARD = 3;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const RUNS = arg("runs", 15);
const asJson = process.argv.includes("--json");

async function one(url) {
  const start = performance.now();
  const response = await fetch(url, { headers: { "User-Agent": "pmtiles-cf-snippet-bench" } });
  const headers = performance.now();
  const bytes = (await response.arrayBuffer()).byteLength;
  const end = performance.now();
  return {
    ttfb: headers - start,
    body: end - headers,
    total: end - start,
    bytes,
    cacheControl: response.headers.get("cache-control"),
    encoding: response.headers.get("content-encoding"),
  };
}

/** The quantile of a sample set, ignoring the first DISCARD. */
function quantile(samples, q) {
  const warm = samples.slice(DISCARD).sort((a, b) => a - b);
  if (!warm.length) return NaN;
  return warm[Math.min(warm.length - 1, Math.floor(warm.length * q))];
}

const band = (samples) =>
  `${quantile(samples, 0.25).toFixed(0)}-${quantile(samples, 0.75).toFixed(0)}`;

/**
 * Whether one host answers faster, and how sure of it.
 *
 * Two rules. The gap has to clear 15%, because below that it sits inside the
 * variation of one network at one moment and calling it a result would be dressing
 * noise up as evidence. And the middle halves must not overlap, because if they do
 * then one unlucky request moved the number and averaging has not fixed it.
 */
function verdict(ours, cdn) {
  const oursMedian = quantile(ours, 0.5);
  const cdnMedian = quantile(cdn, 0.5);
  // Above 1 means this host answered sooner.
  const ratio = cdnMedian / oursMedian;
  if (Math.abs(ratio - 1) < 0.15) return { text: "too close to call", sure: false, ratio };
  const faster = ratio > 1 ? "ours" : "the CDN";
  // The same test either way round: this host's fastest quarter is slower than the
  // CDN's slowest quarter. If that holds, no amount of luck explains the gap. The
  // earlier version tested it the other way for the CDN case and therefore reported
  // "samples overlap" on every run where the bands were plainly apart.
  const separated = quantile(ours, 0.25) > quantile(cdn, 0.75);
  return {
    text: `${faster} ${Math.max(ratio, 1 / ratio).toFixed(2)}x faster${separated ? "" : ", samples overlap"}`,
    sure: separated,
    ratio,
  };
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const rows = [];
  for (const pair of PAIRS) {
    const ours = [];
    const cdn = [];
    for (let i = 0; i < RUNS; i++) {
      // Interleaved, and the order alternates so neither host always gets the
      // first slot and the warmer connection.
      if (i % 2 === 0) {
        ours.push(await one(pair.ours));
        cdn.push(await one(pair.cdn));
      } else {
        cdn.push(await one(pair.cdn));
        ours.push(await one(pair.ours));
      }
    }
    // The verdict is on time to first byte, not on the total. The total includes the
    // transfer, which is the reader's connection rather than the host.
    const v = verdict(ours.map((s) => s.ttfb), cdn.map((s) => s.ttfb));
    rows.push({
      ...pair,
      ours: { ttfb: band(ours.map((s) => s.ttfb)), body: band(ours.map((s) => s.body)), samples: ours },
      cdn: { ttfb: band(cdn.map((s) => s.ttfb)), body: band(cdn.map((s) => s.body)), samples: cdn },
      bytes: ours[0].bytes,
      cacheControlOurs: ours[0].cacheControl,
      cacheControlCdn: cdn[0].cacheControl,
      encoding: ours[0].encoding,
      verdict: v,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ runs: RUNS, rows }, null, 2));
    return;
  }

  console.log(`\n  ${RUNS} interleaved requests per host, one at a time, one reused connection.`);
  console.log(`  First ${DISCARD} of each thrown away. ttfb is the first byte, which is what the`);
  console.log(`  verdict is based on; body is the transfer, which is the reader's connection.`);
  console.log(`  From one machine on one network. Not a general result.\n`);

  console.log(`  ${pad("asset", 26)}${pad("ours ttfb", 14)}${pad("cdn ttfb", 14)}${pad("gap", 34)}page uses`);
  for (const row of rows) {
    console.log(`  ${pad(row.what, 26)}${pad(row.ours.ttfb + " ms", 14)}${pad(row.cdn.ttfb + " ms", 14)}` +
      `${pad(row.verdict.text, 34)}${row.use === "ours" ? "this host" : "the CDN"}`);
  }

  console.log("\n  body transfer, which is the same for both hosts");
  for (const row of rows) {
    console.log(`  ${pad(row.what, 26)}ours ${pad(row.ours.body + " ms", 14)}cdn ${row.cdn.body} ms`);
  }

  console.log("\n  sizes and cache policy");
  for (const row of rows) {
    console.log(`  ${pad(row.what, 26)}${String(row.bytes).padStart(9)} B  ${row.encoding || "no encoding"}`);
    console.log(`  ${pad("", 26)}ours: ${row.cacheControlOurs || "(none)"}`);
    console.log(`  ${pad("", 26)}cdn : ${row.cacheControlCdn || "(none)"}`);
  }
  console.log();
}

main().catch((error) => {
  console.error(`bench failed: ${error.message}`);
  process.exit(1);
});