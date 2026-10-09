#!/usr/bin/env node
/**
 * Load every published style in a real browser and prove each layer draws.
 *
 *   node tools/check-style.mjs localhost:8099        # a local public/ directory
 *   node tools/check-style.mjs https://tiles.jasontally.com
 *
 * WHY A BROWSER AND NOT A LIST OF RULES
 *
 * A style with a malformed expression is rejected in full by MapLibre. Nothing
 * fails a request, nothing in the network log turns red, and the map is simply
 * absent. Every offline check I wrote for this either said "clean" or produced
 * hundreds of false positives on a style that loads fine, and both of those are
 * worse than useless: the first is a test that cannot fail, the second is one that
 * fails when nothing is wrong.
 *
 * So this loads the styles, waits for the tiles, and asks the map what it actually
 * drew. A layer that renders zero features is reported as such. That is the check.
 *
 * It needs the maps to be served over HTTP, not file://, because the styles fetch
 * their glyphs and their sprite from this host. Run it against a local server:
 *
 *   cd public && python3 -m http.server 8099
 *
 * Layers that are waiting for a data refresh are expected to draw nothing. They are
 * listed separately and do not fail the run: they are correct now and will start
 * drawing when the archive is refreshed, and that is the whole point of the `has`
 * test they are built on.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2] || "https://tiles.jasontally.com";

/** What to count, and where. Chosen so every layer has somewhere it should appear. */
const VIEWS = [
  { label: "world z1", center: [0, 20], zoom: 1 },
  { label: "coast z5", center: [-80.7, 28.2], zoom: 5 },
  { label: "city z12", center: [2.3522, 48.8566], zoom: 12 },
  { label: "city z16", center: [2.3522, 48.8566], zoom: 16 },
];

/** Layers that wait for the archive to carry a field it does not yet carry. */
const WAITING = ["road-shield", "address-label"];

const index = JSON.parse(readFileSync(join(ROOT, "public", "styles", "index.json"), "utf8"));

let failed = 0;
const notes = [];

const browser = async () => {
  const { default: chromium } = await import("playwright");
  return chromium.launch();
};

async function open(browser, url) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

async function run() {
  const chromium = (await import("playwright")).chromium;
  const browser = await chromium.launch();
  const page = await open(browser, `data:text/html,<div id=h style="width:600px;height:420px"></div>`);

  // A harness page with MapLibre and PMTiles on it, so the styles are loaded exactly
  // as a developer's page would load them, in the same situation, and the failure
  // mode is the same one.
  await page.setContent(`<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/pmtiles@3.2.1/dist/pmtiles.js"></script>
</head><body><div id="map" style="width:600px;height:420px"></div></body></html>`);
  await page.waitForFunction("typeof maplibregl !== 'undefined'");

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon/.test(message.text())) consoleErrors.push(message.text());
  });

  for (const flavour of index.flavors) {
    const url = new URL(flavour.url.replace(/^\//, ""), origin).href;
    const counts = await page.evaluate(
      async ([url, views, waiting]) => {
        const style = await (await fetch(url)).json();
        const host = document.createElement("div");
        host.id = "probe";
        host.style.cssText = "position:fixed;left:-9999px;width:640px;height:440px";
        document.body.appendChild(host);
        const map = new maplibregl.Map({ container: host, style, center: views[0].center, zoom: views[0].zoom });
        const ready = new Promise((resolve) => {
          map.once("idle", resolve);
          setTimeout(resolve, 20000);
        });
        await ready;

        const drawn = {};
        const errors = [];
        map.on("error", (event) => {
          const message = event.error ? event.error.message : String(event);
          if (!/Failed to load resource/.test(message)) errors.push(message);
        });

        for (const view of views) {
          map.jumpTo({ center: view.center, zoom: view.zoom });
          await new Promise((resolve) => {
            map.once("idle", resolve);
            setTimeout(resolve, 20000);
          });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          for (const layer of style.layers) {
            try {
              const n = map.queryRenderedFeatures({ layers: [layer.id] }).length;
              if (n) drawn[layer.id] = (drawn[layer.id] || 0) + n;
            } catch (error) {
              errors.push(`${layer.id}: ${error.message}`);
            }
          }
        }
        const loaded = map.getStyle().layers.length;
        map.remove();
        host.remove();
        return { drawn, errors, loaded, wanted: style.layers.length, ids: style.layers.map((l) => l.id) };
      },
      [url, VIEWS, WAITING]
    );

    if (counts.loaded !== counts.wanted) {
      console.error(`  ${flavour.id.padEnd(7)} FAILED: MapLibre loaded ${counts.loaded} of ` +
        `${counts.wanted} layers. The style was rejected.`);
      for (const message of counts.errors) console.error(`           ${message}`);
      failed++;
      continue;
    }

    // A layer that is not drawn anywhere in any of the four views and is not one of
    // the ones waiting for a refresh is a layer that draws nothing at all.
    const absent = counts.ids.filter(
      (id) => !counts.drawn[id] && !WAITING.includes(id)
    );
    const waiting = WAITING.filter((id) => counts.ids.includes(id));
    if (absent.length) {
      console.error(`  ${flavour.id.padEnd(7)} FAILED: these layers drew nothing in any view: ${absent.join(", ")}`);
      failed++;
    } else {
      console.log(`  ${flavour.id.padEnd(7)} ${counts.loaded} layers, ` +
        `${Object.keys(counts.drawn).length} drawing, ${Object.keys(counts.drawn).length - counts.ids.length === 0 ? "" : ""}` +
        `${waiting.length ? `${waiting.length} waiting for the refresh` : ""}`);
    }
    for (const id of waiting) {
      notes.push(`${flavour.id}: ${id} drew 0 everywhere, as expected until the archive has the field`);
    }
  }

  await browser.close();

  const fatal = consoleErrors.filter((text) => /layers\[\d+\]|does not exist in the map/.test(text));
  if (fatal.length) {
    console.error(`\n  style errors in the browser:`);
    for (const text of fatal.slice(0, 5)) console.error(`    ${text}`);
    failed++;
  }

  if (notes.length) {
    console.log(`\n  waiting for the data refresh, and drawing nothing until then:`);
    for (const note of notes) console.log(`    ${note}`);
  }

  console.log(`\n  ${failed === 0 ? "every published style loads and draws" : `${failed} style(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(`check-style failed: ${error.message}`);
  process.exit(1);
});