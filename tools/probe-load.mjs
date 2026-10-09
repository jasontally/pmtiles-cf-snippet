#!/usr/bin/env node
/**
 * Do what a browser does to load this map, and time each step.
 *
 *   node tools/probe-load.mjs
 *
 * A map that shows "loading tiles…" has created its map and never gone idle, which
 * means something it asks for is slow, missing, or never resolves. This walks that
 * path over HTTP with the same URLs the page uses, so the answer is visible here
 * rather than only in a browser console.
 *
 * Each request is timed separately and with a deadline, because a request that
 * hangs is a different failure from one that 404s and they look the same from a
 * map: no tiles either way.
 */

const TILES = "https://tiles.jasontally.com";
const ORIGIN = "https://tiles.jasontally.com";
const DEADLINE_MS = 12000;

async function step(name, url, { headers = {}, expectJson = false } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    const body = await response.arrayBuffer();
    const ms = Date.now() - started;
    let note = `${response.status} in ${ms} ms, ${body.byteLength.toLocaleString()} bytes`;
    let extra = "";
    if (expectJson) {
      try {
        const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
        extra = `, parsed JSON with ${parsed.layers ? parsed.layers.length + " layers" : Object.keys(parsed).length + " keys"}`;
      } catch (error) {
        note += `, JSON PARSE FAILED: ${error.message}`;
      }
    }
    console.log(`  ${name.padEnd(28)} ${note}${extra}`);
    return { ok: response.ok, status: response.status, ms, bytes: body.byteLength };
  } catch (error) {
    console.log(`  ${name.padEnd(28)} FAILED after ${Date.now() - started} ms: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`  probing ${ORIGIN}\n`);
  const style = await step("style bright.json", `${TILES}/styles/bright.json`, { expectJson: true });
  await step("style dark.json", `${TILES}/styles/dark.json`, { expectJson: true });
  await step("style light.json", `${TILES}/styles/light.json`, { expectJson: true });
  console.log();

  // The sprite, every file MapLibre asks for. @2x is separate because it is the one
  // that redirects on this host.
  for (const name of ["light.json", "light.png", "light@2x.json", "light@2x.png"]) {
    await step(`sprite ${name}`, `${TILES}/sprites/v4/${name}`);
  }
  console.log();

  // The glyphs, two stacks and a couple of ranges.
  await step("glyph Regular 0-255", `${TILES}/font/Noto%20Sans%20Regular/0-255.pbf`);
  await step("glyph Medium 256-511", `${TILES}/font/Noto%20Sans%20Medium/256-511.pbf`);
  console.log();

  // The page and the libraries it loads.
  await step("the page", `${TILES}/`);
  await step("maplibre-gl.js", `${TILES}/vendor/maplibre-gl.js`);
  await step("pmtiles.js", `${TILES}/vendor/pmtiles.js`);
  console.log();

  // The thing the map actually draws: a tile, walked through the archive.
  const { PMTiles, FetchSource } = await import("./.pmtiles-cdn.mjs");
  const source = new PMTiles(new FetchSource(`${TILES}/basemap.pmtiles`));
  const started = Date.now();
  try {
    const tile = await source.getZxy(6, 18, 39);
    console.log(`  ${"a z6 tile, own directory".padEnd(28)} ${tile ? `200 in ${Date.now() - started} ms, ${tile.data.byteLength.toLocaleString()} bytes` : "no tile there"}`);
  } catch (error) {
    console.log(`  ${"a z6 tile".padEnd(28)} FAILED: ${error.message}`);
  }

  if (style && style.status !== 200) {
    console.log("\n  the style did not load, so nothing downstream matters");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});