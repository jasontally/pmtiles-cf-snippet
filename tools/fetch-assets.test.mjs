/**
 * Tests for the vendored assets. Run with: node tools/fetch-assets.test.mjs
 *
 * The styles name a host for glyphs, and that host is this one. So a font stack
 * the styles ask for but the assets tree does not have is a 404 at map load, which
 * shows up as labels missing on a map rather than as an error. Everything here is
 * about catching that before it ships.
 *
 * Nothing needs a credential. The licence text is checked because redistributing
 * these files is only lawful if the licence travels with them, and it is easy to
 * add an asset and forget.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const manifest = new Map(
  readFileSync(join(ROOT, "assets", "MANIFEST.sha256"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64})\s+(.*)$/.exec(line.trim());
      return match ? [match[2], match[1]] : ["", ""];
    })
);

const styles = ["light", "bright", "dark"].map(
  (id) => JSON.parse(readFileSync(join(ROOT, "public", "styles", `${id}.json`), "utf8"))
);

await check("every asset on disk has a digest, and the manifest covers them all", () => {
  assert.ok(manifest.size > 500, `the manifest only has ${manifest.size} entries`);
  for (const [relative] of manifest) {
    assert.ok(existsSync(join(ROOT, "assets", relative)), `${relative} is listed but not on disk`);
  }
});

await check("the fonts the styles ask for are the fonts we vendored", () => {
  // The failure this catches: a style asks for a stack, the tree does not have it,
  // and every label 404s. It happened once already, when the styles asked for
  // "Noto Sans Bold" and the OFL set only has Medium.
  const wanted = new Set();
  for (const style of styles) {
    for (const layer of style.layers) {
      for (const stack of layer.layout?.["text-font"] || []) {
        wanted.add(stack);
      }
    }
  }
  assert.ok(wanted.size > 0, "no style asks for a font, so this test proves nothing");
  for (const stack of wanted) {
    assert.ok(
      manifest.has(`fonts/${stack}/0-255.pbf`),
      `the styles ask for "${stack}" and assets/fonts/${stack}/ is not vendored`
    );
  }
});

await check("no style still points at the demo tile server", () => {
  for (const style of styles) {
    assert.ok(!/demotiles\.maplibre\.org/.test(style.glyphs), `${style.name} points at demotiles`);
    assert.ok(
      new URL(style.glyphs).host === "tiles.jasontally.com",
      `${style.name} points glyphs at ${style.glyphs}`
    );
  }
});

await check("the glyph path is the one a hostname swap works with", () => {
  // demotiles.maplibre.org serves /font/{fontstack}/{range}.pbf. Matching it means a
  // developer replaces the hostname and nothing else. If this ever becomes
  // /fonts/, the claim on the page is wrong and so is the promise.
  for (const style of styles) {
    assert.equal(
      style.glyphs,
      "https://tiles.jasontally.com/font/{fontstack}/{range}.pbf",
      "the glyph path changed, so the hostname swap no longer works"
    );
  }
});

await check("every range a fontstack could be asked for is vendored", () => {
  // MapLibre asks 256 codepoints at a time across the whole Unicode range, and
  // Protomaps labels features with their local name. Trimming the set to Latin
  // would leave Tokyo and Cairo with no labels and no error.
  for (const [relative] of manifest) {
    const match = /^fonts\/(.+)\/(\d+)-(\d+)\.pbf$/.exec(relative);
    if (!match) continue;
    const start = Number(match[2]);
    const end = Number(match[3]);
    assert.equal(end - start, 255, `${relative} is not a 256 codepoint range`);
    assert.equal(start % 256, 0, `${relative} does not start on a 256 boundary`);
  }
  const ranges = [...manifest.keys()].filter((k) => k.endsWith(".pbf")).length;
  assert.equal(ranges, 512, `expected 512 font files, found ${ranges}`);
});

await check("both licences are present and say what they cover", () => {
  const ofl = readFileSync(join(ROOT, "assets", "fonts", "OFL.txt"), "utf8");
  assert.ok(/SIL OPEN FONT LICENSE/i.test(ofl), "the OFL text is not the OFL text");
  assert.ok(/Version 1\.1/.test(ofl), "the OFL is not version 1.1");
  const mit = readFileSync(join(ROOT, "assets", "sprites", "LICENSE.md"), "utf8");
  assert.ok(/MIT/i.test(mit), "the sprite licence is not MIT");
});

await check("the libraries are vendored even though the CDN is faster", () => {
  // Measured, and jsDelivr won, so the page loads from jsDelivr. The copies stay
  // because a developer who wants a map from one hostname should be able to have
  // that, and because saying "ours is slower" is only believable if ours exists.
  for (const name of ["maplibre-gl.js", "maplibre-gl.css", "pmtiles.js"]) {
    assert.ok(existsSync(join(ROOT, "assets", "vendor", name)), `assets/vendor/${name} is missing`);
    assert.ok(existsSync(join(ROOT, "public", "vendor", name)), `public/vendor/${name} is missing`);
    assert.ok(manifest.has(`vendor/${name}`), `vendor/${name} has no digest`);
  }
  // And they are documented, with their licences.
  for (const licence of ["maplibre-gl-LICENSE.txt", "pmtiles-LICENSE.txt"]) {
    assert.ok(existsSync(join(ROOT, "public", "vendor", licence)), `${licence} is not published`);
  }
  // The page must actually render them, from the build's own list rather than a
  // second hand written copy of it. A URL typed into the page is a URL that goes
  // stale without anything failing.
  const index = JSON.parse(readFileSync(join(ROOT, "public", "styles", "index.json"), "utf8"));
  const listed = index.assets.libraries || [];
  assert.equal(listed.length, 3, `index.json lists ${listed.length} libraries, expected 3`);
  for (const lib of listed) {
    assert.ok(existsSync(join(ROOT, "public", lib.path.replace(/^\//, ""))), `${lib.path} is listed but not published`);
  }
  // The page renders them from that list, which is the point: a URL typed into the
  // HTML would be a second copy of the truth and would go stale quietly.
  const page = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  assert.ok(page.includes("assets.libraries"), "the page does not render the library list from the build");
  assert.ok(
    page.includes("also on jsDelivr"),
    "the page does not say the libraries are on the CDN too"
  );
  const headers = readFileSync(join(ROOT, "public", "_headers"), "utf8");
  assert.ok(/^\/vendor\/\*/m.test(headers), "no header rule for /vendor/, so a cross-origin load would fail");
});

await check("the build publishes the fonts where the styles look for them", () => {
  // /font, not /fonts. The repo keeps them under fonts/ because that is what the
  // upstream layout and the OFL call it.
  assert.ok(existsSync(join(ROOT, "public", "font", "Noto Sans Regular", "0-255.pbf")), "public/font is empty");
  assert.ok(existsSync(join(ROOT, "public", "font", "OFL.txt")), "the OFL is not published with the fonts");
  assert.ok(existsSync(join(ROOT, "public", "sprites", "v4", "light.json")), "no sprite published");
  assert.ok(existsSync(join(ROOT, "public", "sprites", "LICENSE.md")), "the sprite licence is not published");
});

await check("the internal manifest is not published", () => {
  // It is for this build to check itself. Fetching it would tell a reader the
  // layout for no benefit, and it is not part of the promise.
  assert.ok(!existsSync(join(ROOT, "public", "MANIFEST.sha256")), "the manifest is in public/");
  const walked = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else walked.push(path);
    }
  };
  walk(join(ROOT, "public"));
  assert.equal(
    walked.filter((p) => p.endsWith(".sha256")).length,
    0,
    "a digest file reached public/"
  );
});

await check("every path a browser fetches cross-origin sends CORS headers", () => {
  // A style hosted anywhere asks this host for a font range. Without
  // Access-Control-Allow-Origin the browser refuses and the labels are missing with
  // no error in the page. This is the one failure that is invisible from here.
  const headers = readFileSync(join(ROOT, "public", "_headers"), "utf8");
  const blocks = {};
  let path = null;
  for (const line of headers.split("\n")) {
    if (line && !/^\s/.test(line)) path = line.trim();
    else if (path && /Access-Control-Allow-Origin/.test(line)) blocks[path] = true;
  }
  for (const p of ["/s/*", "/font/*", "/sprites/*", "/styles/*"]) {
    assert.ok(blocks[p], `no CORS header for ${p}`);
  }
  // The font rules must not be immutable, or a licence update would never reach a
  // browser that already has one cached.
  const fontBlock = /^\/font\/OFL\.txt\n((?:\t.*\n)*)/m.exec(headers);
  assert.ok(fontBlock, "no header block for the font licence");
  assert.ok(!/immutable/.test(fontBlock[1]), "the font licence is cached immutably");
});

await check("--check passes on a clean tree", () => {
  execFileSync(process.execPath, [join(ROOT, "tools", "fetch-assets.mjs"), "--check"], {
    encoding: "utf8",
    timeout: 120000,
  });
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);