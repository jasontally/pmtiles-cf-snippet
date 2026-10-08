/**
 * Tests for the style generator. Run with: node web/make-styles.test.mjs
 *
 * A style that names a source layer the archive does not have loads without an
 * error and then draws nothing, which is the failure mode that is hardest to
 * notice. A palette key that is missing from one flavour gives that flavour a
 * null colour and the browser rejects the style. Both are silent, so they are
 * checked here against the schema the generator declares and against the real
 * archive metadata.
 *
 * The metadata check needs the network. Without it the rest still runs, and the
 * test says which parts it skipped.
 */

import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStyle, renderTemplate, placeholderPalette, FLAVORS, SCHEMA, TILES_URL,
  CONTROLS, CONTROL_KEYS, TOGGLE_GROUPS, packEdits, unpackEdits, hasUnfilled,
} from "./make-styles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const READER = TILES_URL;
const META_OFFSET = 126450545781;
const META_LENGTH = 1160;

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

/** The archive's own layer list, so the generator is checked against reality. */
async function archiveLayers() {
  const response = await fetch(READER, {
    headers: { Range: `bytes=${META_OFFSET}-${META_OFFSET + META_LENGTH - 1}` },
  });
  if (response.status !== 206) throw new Error(`reader returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(raw.toString("utf8"));
}

const ids = Object.keys(FLAVORS);

/** The builder payload the page loads, read from disk. */
function readBuilder() {
  return JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "builder.json"), "utf8"));
}

await check("there is more than one flavour", () => {
  assert.ok(ids.length >= 2, `only ${ids.length} flavour`);
});

await check("every flavour has the same palette keys", () => {
  const reference = Object.keys(FLAVORS[ids[0]]).sort();
  for (const id of ids) {
    const keys = Object.keys(FLAVORS[id]).sort();
    assert.deepEqual(keys, reference, `flavour ${id} has a different set of palette keys`);
    // label and swatch are for the page, the rest must be colours.
    for (const key of keys) {
      if (key === "name" || key === "swatch") continue;
      const value = FLAVORS[id][key];
      assert.equal(typeof value, "string", `${id}.${key} is ${typeof value}`);
      assert.match(value, /^#[0-9a-f]{6}$/i, `${id}.${key} is not a hex colour: ${value}`);
    }
  }
});

await check("every flavour has a human name and a hex swatch", () => {
  for (const id of ids) {
    assert.match(FLAVORS[id].swatch, /^#[0-9a-f]{6}$/i, `${id} swatch`);
    // The name is what the button shows, so it must not be a hex colour.
    assert.ok(FLAVORS[id].name.length > 0, `${id} name is empty`);
    assert.ok(
      !FLAVORS[id].name.startsWith("#"),
      `${id} name is a hex colour: ${FLAVORS[id].name}`
    );
  }
});

await check("every style is valid MapLibre JSON with a version", () => {
  for (const id of ids) {
    const style = buildStyle(id);
    assert.equal(style.version, 8, `${id} version`);
    assert.ok(style.glyphs.includes("{fontstack}"), `${id} glyphs needs {fontstack}`);
    assert.ok(style.glyphs.includes("{range}"), `${id} glyphs needs {range}`);
    assert.ok(style.sources.protomaps, `${id} has no protomaps source`);
    assert.equal(style.sources.protomaps.type, "vector", `${id} source type`);
    assert.ok(Array.isArray(style.layers) && style.layers.length > 5, `${id} layers`);
    assert.equal(style.layers[0].id, "background", `${id} first layer must be the background`);
  }
});

await check("every style points at the one archive", () => {
  for (const id of ids) {
    const style = buildStyle(id);
    assert.equal(
      style.sources.protomaps.url,
      `pmtiles://${TILES_URL}`,
      `${id} source url`
    );
  }
});

await check("every style names only source layers the generator declares", () => {
  const declared = new Set(Object.keys(SCHEMA));
  for (const id of ids) {
    const style = buildStyle(id);
    for (const layer of style.layers) {
      if (!layer["source-layer"]) continue;
      assert.ok(
        declared.has(layer["source-layer"]),
        `${id} layer ${layer.id} uses source-layer ${layer["source-layer"]}, not in the schema`
      );
    }
  }
});

await check("the declared schema matches the archive metadata", async () => {
  let meta;
  try {
    meta = await archiveLayers();
  } catch (error) {
    console.log(`      skipped, could not reach ${READER}: ${error.message}`);
    return;
  }
  const actual = Object.fromEntries(
    meta.vector_layers.map((v) => [v.id, [v.minzoom, v.maxzoom]])
  );
  assert.deepEqual(SCHEMA, actual, "the declared schema drifted from the archive");
});

await check("every layer id is unique inside a style", () => {
  for (const id of ids) {
    const seen = new Set();
    for (const layer of buildStyle(id).layers) {
      assert.ok(!seen.has(layer.id), `${id} has two layers called ${layer.id}`);
      seen.add(layer.id);
    }
  }
});

await check("no palette value leaks a null colour into a style", () => {
  // A match expression missing a branch yields null, which MapLibre rejects.
  for (const id of ids) {
    const text = JSON.stringify(buildStyle(id));
    assert.ok(!text.includes("null"), `flavour ${id} contains null`);
    assert.ok(!/"#[0-9a-f]{0,5}"/i.test(text), `flavour ${id} has a short hex colour`);
  }
});

await check("the generated index lists every flavour and points at real files", () => {
  const index = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "index.json"), "utf8"));
  assert.equal(index.tiles, TILES_URL);
  assert.deepEqual(index.flavors.map((f) => f.id), ids);
  for (const flavor of index.flavors) {
    for (const url of [flavor.url, flavor.style]) {
      const file = join(HERE, "..", "public", url.replace(/^\//, ""));
      const doc = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(doc.version, 8, `${url} is not a style`);
    }
  }
});

await check("the template plus a palette reproduces the shipped style", () => {
  // This is the guarantee behind the builder: what the page shows is what it
  // hands you. If the template and the shipped styles described different maps,
  // the builder would be a lie.
  const builder = readBuilder();
  const strip = (node) =>
    Array.isArray(node)
      ? node.map(strip)
      : node && typeof node === "object"
        ? Object.fromEntries(
            Object.entries(node).filter(([key]) => key !== "visibility").map(([k, v]) => [k, strip(v)])
          )
        : node;

  for (const id of ids) {
    const show = Object.fromEntries(builder.toggles.map((t) => [t.id, true]));
    const rendered = renderTemplate(builder.template, { ...builder.palettes[id], flavor: id }, show);
    const shipped = buildStyle(id);
    assert.deepEqual(
      strip(rendered),
      strip(shipped),
      `the template rendered with the ${id} palette differs from the ${id} style`
    );
  }
});

await check("a full palette leaves no placeholder unfilled", () => {
  const builder = readBuilder();
  const show = Object.fromEntries(builder.toggles.map((t) => [t.id, true]));
  for (const id of ids) {
    const rendered = renderTemplate(builder.template, { ...builder.palettes[id], flavor: id }, show);
    const text = JSON.stringify(rendered);
    assert.ok(!text.includes("{{"), `flavour ${id} leaves a placeholder unfilled`);
  }
});

await check("a toggle off hides every layer in its group", () => {
  const builder = readBuilder();
  const show = Object.fromEntries(builder.toggles.map((t) => [t.id, true]));
  for (const group of TOGGLE_GROUPS) {
    const style = renderTemplate(builder.template, builder.palettes.light, { ...show, [group.id]: false });
    for (const layerId of group.layers) {
      const layer = style.layers.find((l) => l.id === layerId);
      assert.ok(layer, `group ${group.id} names layer ${layerId}, which does not exist`);
      assert.equal(layer.visibility, "none", `${group.id} off must hide ${layerId}`);
    }
    // And nothing outside the group changed.
    const others = style.layers.filter((l) => !group.layers.includes(l.id) && l.visibility === "none");
    assert.deepEqual(others, [], `${group.id} off also hid ${others.map((l) => l.id).join(", ")}`);
  }
});

await check("every toggle group names layers that exist", () => {
  const builder = readBuilder();
  const known = new Set(builder.template.layers.map((l) => l.id));
  for (const group of TOGGLE_GROUPS) {
    assert.ok(group.layers.length > 0, `group ${group.id} covers nothing`);
    for (const layerId of group.layers) {
      assert.ok(known.has(layerId), `group ${group.id} names unknown layer ${layerId}`);
    }
    // A group whose id is not in a template placeholder is a dead toggle.
    const placeholder = `{{show:${group.id}}}`;
    assert.ok(
      JSON.stringify(builder.template).includes(placeholder),
      `group ${group.id} has no ${placeholder} placeholder in the template`
    );
  }
});

await check("every colour control reaches the style", () => {
  // A control that changes nothing is worse than no control: it looks like it
  // works.
  const builder = readBuilder();
  for (const key of CONTROL_KEYS) {
    assert.ok(FLAVORS.light[key] !== undefined, `control ${key} is not a palette key`);
    const show = Object.fromEntries(builder.toggles.map((t) => [t.id, true]));
    const before = JSON.stringify(renderTemplate(builder.template, builder.palettes.light, show));
    const after = JSON.stringify(
      renderTemplate(builder.template, { ...builder.palettes.light, [key]: "#123456" }, show)
    );
    assert.notEqual(after, before, `control ${key} changes nothing in the rendered style`);
  }
});

await check("every control group names keys that exist", () => {
  for (const group of CONTROLS) {
    for (const key of group.keys) {
      assert.ok(FLAVORS.light[key] !== undefined, `control group ${group.group} names unknown ${key}`);
    }
  }
});

await check("the placeholder palette covers every colour key but the swatch", () => {
  const placeholders = placeholderPalette();
  assert.equal(placeholders.swatch, undefined, "swatch is not used by a style");
  for (const key of Object.keys(FLAVORS.light)) {
    if (key === "swatch") continue;
    assert.equal(placeholders[key], `{{${key}}}`, `placeholder for ${key}`);
  }
});

await check("an unknown key is left visible rather than silently blanked", () => {
  // A placeholder with no value must stay literal so the bug shows in the JSON
  // the user copies, instead of becoming a colour that does not exist.
  const partial = renderTemplate({ layers: [{ paint: { "fill-color": "{{nope}}" } }] }, { water: "#fff" });
  assert.equal(partial.layers[0].paint["fill-color"], "{{nope}}");
});

await check("a share link round trips", () => {
  const base = FLAVORS.light;
  const values = { ...base, water: "#ff00ff", label: "#112233" };
  const show = { landcover: false, buildings: false };
  const packed = packEdits(base, values, show);

  assert.ok(!/[+/=]/.test(packed), `not URL safe: ${packed}`);
  assert.ok(packed.length < 200, `a share link should stay short, got ${packed.length} characters`);

  const back = unpackEdits(base, packed);
  for (const key of Object.values(base)) {
    assert.equal(back.values[key], values[key], `colour ${key} did not round trip`);
  }
  assert.equal(back.show.landcover, false);
  assert.equal(back.show.buildings, false);
});

await check("an untouched palette packs small and changes nothing", () => {
  const base = FLAVORS.light;
  const packed = packEdits(base, base, {});
  // The floor is the base64 of {"c":{},"o":[]}. What matters is that it stays
  // short next to a full palette, and that unpacking it is a no-op.
  assert.ok(packed.length < 40, `no edits should pack small, got ${packed.length}`);
  const back = unpackEdits(base, packed);
  for (const key of Object.values(base)) {
    assert.equal(back.values[key], base[key], `colour ${key} changed on an empty pack`);
  }
  assert.deepEqual(Object.entries(back.show).filter(([, on]) => on === false), []);
});

await check("hasUnfilled spots a half rendered style", () => {
  assert.equal(hasUnfilled(renderTemplate({ a: "{{x}}" }, { x: "#fff" })), false);
  assert.equal(hasUnfilled(renderTemplate({ a: "{{x}}" }, {})), true);
});

await check("the page links the tiles URL the styles use", () => {
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(page.includes(TILES_URL), "the page never mentions the tiles URL");
  // The page must not leak how the archive is stored.
  for (const leak of ["snippet", "Snippet", "Static Assets", "wrangler", "Wrangler", "shard", "part file"]) {
    assert.ok(!page.includes(leak), `the page mentions ${leak}`);
  }
  // The refresh section has to say when, and must not promise an instant swap.
  assert.ok(page.includes("Refreshed on Sundays"), "the page does not say when it refreshes");
  assert.ok(/00:30 and\s+07:00 UTC/.test(page), "the page does not give the refresh window");
  assert.ok(
    page.includes("Archive metadata"),
    "the page should point at the archive's own metadata rather than a hard coded date"
  );
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);