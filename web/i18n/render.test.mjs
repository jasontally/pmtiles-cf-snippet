/**
 * Tests for the rendered help pages. Run: node web/i18n/render.test.mjs
 *
 * The structural checks never need the network. The live checks (one HEAD per
 * boundary part) do, and skip cleanly when the network is unavailable, so a
 * clone that is offline still gets the structural coverage.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { languages } from "./render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PUBLIC = join(ROOT, "public");
const ENGLISH = readFileSync(join(PUBLIC, "en", "index.html"), "utf8");
const ENGLISH_PRE = ENGLISH.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/g) || [];

let passed = 0;
let failed = 0;
let skipped = 0;
async function check(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failed++; console.error(`FAIL  ${name}\n      ${error.message}`); }
}

for (const lang of languages) {
  const path = join(PUBLIC, lang.path.replace(/^\/|\/$/g, ""), "index.html");
  let html;
  try { html = readFileSync(path, "utf8"); }
  catch (error) { await check(`${lang.code}: page exists`, () => { throw error; }); continue; }

  await check(`${lang.code}: lang and dir`, () => {
    assert.ok(new RegExp(`<html lang="${lang.code}"`).test(html), "lang");
    if (lang.dir === "rtl") assert.ok(/dir="rtl"/.test(html), "dir");
  });
  await check(`${lang.code}: canonical and alternate set`, () => {
    assert.ok(html.includes(`rel="canonical" href="https://tiles.jasontally.com${lang.path}"`), "canonical");
    for (const other of languages) {
      assert.ok(html.includes(`hreflang="${other.code}"`), `hreflang ${other.code}`);
    }
    assert.ok(html.includes('hreflang="x-default"'), "x-default");
  });
  await check(`${lang.code}: no untranslated marker`, () => {
    assert.ok(!/data-i18n(?:-attr)?="/.test(html), "marker left");
  });
  await check(`${lang.code}: no relative asset URL`, () => {
    assert.ok(!/(?<!\/)styles\/(index|builder)\.json/.test(html), "relative style url");
    assert.ok(!/src="styles\//.test(html) && !/href="styles\//.test(html), "relative asset path");
  });
  await check(`${lang.code}: no forbidden word`, () => {
    for (const word of ["shard", "snippet", "wrangler", "Static Assets", "Worker"]) {
      assert.ok(!html.includes(word), word);
    }
  });
  await check(`${lang.code}: code blocks are identical`, () => {
    const blocks = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/g) || [];
    assert.equal(blocks.length, ENGLISH_PRE.length, "pre count");
    for (let i = 0; i < blocks.length; i++) {
      assert.equal(blocks[i], ENGLISH_PRE[i], `pre ${i}`);
    }
  });
  await check(`${lang.code}: language menu`, () => {
    assert.ok((html.match(/hreflang="[a-z-]+"/g) || []).length >= languages.length + 1, "menu links");
  });
}

await check("the chooser is a utility page", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  assert.ok(html.includes('name="robots" content="noindex"'), "no noindex");
  assert.ok(!html.includes('hreflang="x-default"'), "chooser claims an alternate");
});

await check("the sitemap covers every language", () => {
  const xml = readFileSync(join(PUBLIC, "sitemap.xml"), "utf8");
  for (const lang of languages) {
    assert.ok(xml.includes(`https://tiles.jasontally.com${lang.path}`), lang.code);
  }
  assert.ok(!/<loc>https:\/\/tiles\.jasontally\.com\/<\/loc>/.test(xml), "the gateway is listed");
});

// The live check: the header and the shards agree about how many parts there are.
try {
  const { readLayout } = await import("../../tools/sync-reader.mjs");
  const layout = await readLayout();
  await check("the live header fits the shard count", () => {
    assert.equal(layout.tilePartsPerShard, Math.ceil(layout.tileParts / 25), "parts per shard");
    assert.ok(layout.tileParts > 24 * layout.tilePartsPerShard, "last shard empty");
  });
  await check("the live shards serve the parts the header implies", async () => {
    const urlFor = (index) =>
      `https://s.tiles${Math.floor(index / layout.tilePartsPerShard)}.jasontally.com/s/basemap/tile/${String(index).padStart(6, "0")}.bin`;
    const last = layout.tileParts - 1;
    for (const index of [0, last]) {
      const response = await fetch(urlFor(index), { method: "HEAD" });
      assert.equal(response.status, 200, `part ${index} returned ${response.status}`);
    }
    const past = await fetch(urlFor(layout.tileParts), { method: "HEAD" });
    assert.equal(past.status, 404, `part ${layout.tileParts} exists`);
  });
} catch (error) {
  skipped++;
  console.log(`skip  live checks  (${String(error.message).split("\n")[0]})`);
}

console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
