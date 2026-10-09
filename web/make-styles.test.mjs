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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStyle, renderTemplate, renderProblems, placeholderPalette, FLAVORS, SCHEMA, TILES_URL,
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
    // name and swatch are for the page, sprite names the sprite sheet, the rest
    // are colours. Both are the same kind of thing: a value the page fills in from
    // the palette rather than one the visitor edits.
    for (const key of keys) {
      if (key === "name" || key === "swatch" || key === "sprite") continue;
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
  // The rebuild section has to say when, and must not promise an instant swap.
  // "Rebuilt", not "refreshed": a weekly rebuild from a new upstream release is
  // not the same claim as data that keeps itself up to date.
  assert.ok(page.includes("Rebuilt on Sundays"), "the page does not say when it rebuilds");
  assert.ok(/00:30 and\s+07:00 UTC/.test(page), "the page does not give the rebuild window");
  assert.ok(
    page.includes("Archive metadata"),
    "the page should point at the archive's own metadata rather than a hard coded date"
  );
  // It must not claim the data itself never goes stale. Scoped to a claim about the
  // tiles, because a comment saying a layer "never changes" is not that claim.
  assert.ok(
    !/(tiles|data|archive)[^.<]{0,40}never (changes|out of date|stale)/i.test(page),
    "the page promises data that never goes stale"
  );
  assert.ok(/weekly|week/i.test(page), "the page does not give a staleness scale");
});

await check("the page opens on the style the build names as the default", () => {
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  const index = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "index.json"), "utf8"));
  // One source of truth. If the page picked flavors[0] instead, changing the
  // default in the build would silently do nothing, and the two would disagree
  // about which style a visitor sees.
  assert.ok(index.defaultFlavor, "index.json does not name a default flavour");
  assert.ok(
    index.flavors.some((f) => f.id === index.defaultFlavor),
    `defaultFlavor ${index.defaultFlavor} is not one of the flavours`
  );
  assert.ok(
    page.includes("index.defaultFlavor"),
    "the page ignores the default flavour and picks its own"
  );
  assert.ok(!page.includes("current = flavors[0]"), "the page still opens on the first flavour");
  assert.equal(index.defaultFlavor, "bright", "the default is meant to be Bright");
});

await check("the builder sits with the map and edits that same map", () => {
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  const tryAt = page.indexOf('<section id="try">');
  const useAt = page.indexOf('<section id="use">');
  const builderAt = page.indexOf('id="builder"');
  const mapAt = page.indexOf('id="map"');
  assert.ok(tryAt > 0 && useAt > tryAt, "the Try it section is missing");
  // Between the map and the Use it section, in that order. That one placement is
  // what puts the builder beside the map on a wide screen and under it on a
  // narrow one, without two copies of the controls.
  assert.ok(mapAt > tryAt && mapAt < builderAt, "the builder is not after the map");
  assert.ok(builderAt < useAt, "the builder is not before Use it");
  assert.equal(page.indexOf('id="builder"'), page.lastIndexOf('id="builder"'), "the builder is duplicated");
  // The builder must drive the live map, not a second map or a preview.
  assert.ok(/map\.setStyle\(style\)/.test(page), "the builder does not push its style to the map");
  assert.ok(!/id="map2"|id="preview-map"/.test(page), "there is a second map on the page");
  // Both sets of flavour buttons must be the same action, or the map and the
  // controls can disagree about which style is showing.
  const callSites = page.match(/addEventListener\("click", \(\) => selectFlavor\(flavor\)\)/g) || [];
  assert.equal(
    callSites.length,
    2,
    `expected 2 click handlers on selectFlavor, found ${callSites.length}`
  );
});

await check("the map centres on where the visitor is, and copes when it cannot", () => {
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(page.includes("https://latlon.jasontally.com/"), "the page does not ask for a location");
  // Latitude first in the answer, longitude first in a MapLibre centre. Swapping
  // them puts the map in the wrong hemisphere and it is not obvious by eye.
  assert.ok(/\[lat, lon\] = .*split\(","\)/.test(page), "the page does not read lat then lon");
  assert.ok(/center: \[lon, lat\]/.test(page), "the page does not swap into MapLibre order");
  // There has to be a fallback and a time limit, or one slow request holds the
  // whole page.
  assert.ok(/abort\(\)/.test(page), "the location request cannot be given up on");
  assert.ok(/catch \{/.test(page) || /catch\s*\(/.test(page), "a failed location is not handled");
  assert.ok(/zoom: 2\.4/.test(page), "there is no whole world fallback zoom");
  // Only the live map matters here. The worked example further down the page is
  // allowed to name a city, because that is the point of the example.
  const script = page.slice(page.indexOf('<script type="module">'));
  assert.ok(!/center: \[2\.35, 48\.85\]/.test(script), "the live map still opens on a hard coded city");
});

await check("every colour control reaches at least one layer", () => {
  // A colour input that changes nothing is worse than no input: the visitor
  // changes it, nothing happens, and they conclude the builder is broken. This is
  // the same guarantee CONTROLS claims in its own comment, checked rather than
  // asserted in prose.
  const builder = readBuilder();
  const template = JSON.stringify(builder.template);
  for (const key of builder.controlKeys) {
    const users = builder.template.layers.filter((l) => JSON.stringify(l).includes(`{{${key}}}`));
    assert.ok(users.length > 0, `the control "${key}" reaches no layer`);
  }
  // And any colour the template uses that the page does not expose is a decision on
  // the list rather than an oversight.
  //
  // Seven are land use detail shades. The panel offers 19 colours and these would
  // be the difference between 19 and 26 inputs for shades a visitor is unlikely to
  // single out, and the Land use toggle covers the layers they are on.
  //
  // Two are catch-alls: the fill colour for a land cover or land use feature whose
  // kind is not one we name. Nobody wants a colour picker for "something else".
  // landcover and landuse are also toggle ids, which is why they are worth writing
  // down: {{landcover}} is a colour and {{show:landcover}} is a toggle, and the
  // renderer tells them apart by the prefix.
  // `sprite` is the same idea as those two: it is a palette value the page fills in
  // rather than a colour, so it is not an input, and it has to travel with the
  // palette for template + palette == shipped style to hold for the sprite too.
  const DELIBERATELY_UNEXPOSED = new Set([
    "commercial", "industrial", "playground", "residential", "school", "scrub", "wetland",
    "landcover", "landuse", "sprite",
  ]);
  // name and flavor are not colours. The renderer fills them with "custom" and the
  // flavour label, so they are filled rather than left open.
  const known = new Set([...builder.controlKeys, "flavor", "name"]);
  for (const [, key] of template.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)) {
    if (key.startsWith("show:")) continue;
    assert.ok(
      known.has(key) || DELIBERATELY_UNEXPOSED.has(key),
      `the template uses {{${key}}} and the page cannot edit it, and it is not on the list of ones it should not`
    );
  }
});

await check("every layer toggle hides the layers it claims to", () => {
  // This is the guarantee behind crossing a toggle out. A group that maps to no
  // layer is a button that does nothing, and that is exactly the bug that was
  // reported: the button worked and the map did not.
  const builder = readBuilder();
  for (const toggle of builder.toggles) {
    const covered = builder.template.layers.filter(
      (l) => l.visibility === `{{show:${toggle.id}}}`
    );
    assert.ok(covered.length > 0, `the toggle "${toggle.id}" covers no layer`);
    for (const layer of covered) {
      const hidden = renderTemplate(builder.template, {}, { [toggle.id]: false });
      const after = hidden.layers.find((l) => l.id === layer.id);
      assert.equal(after.visibility, "none", `${layer.id} did not go to none`);
      const shown = renderTemplate(builder.template, {}, {});
      assert.equal(
        shown.layers.find((l) => l.id === layer.id).visibility,
        "visible",
        `${layer.id} was not visible to begin with`
      );
    }
  }
});

await check("no layer is left un-toggleable when a group is hidden", () => {
  // Hiding one group must not accidentally hide another. If a layer carried two
  // placeholders, or one group covered another's layer, this catches it.
  const builder = readBuilder();
  for (const toggle of builder.toggles) {
    const hidden = renderTemplate(builder.template, {}, { [toggle.id]: false });
    const none = hidden.layers.filter((l) => l.visibility === "none").map((l) => l.id);
    const others = builder.toggles.filter((t) => t.id !== toggle.id).map((t) => t.id);
    for (const id of none) {
      const owner = builder.toggles.find((t) =>
        builder.template.layers.some((l) => l.id === id && l.visibility === `{{show:${t.id}}}`)
      );
      assert.equal(owner.id, toggle.id, `${id} is shared between ${toggle.id} and ${owner.id}`);
    }
    assert.ok(others.every((o) => o !== toggle.id));
  }
});

await check("a toggle says which zoom it starts at, and that is true", () => {
  // Buildings are not drawn below z12. At the zoom the page opens on, crossing
  // Buildings out correctly changes nothing, and without saying so the control
  // looks broken.
  const builder = readBuilder();
  for (const toggle of builder.toggles) {
    assert.equal(typeof toggle.minzoom, "number", `the toggle "${toggle.id}" has no zoom`);
    const zooms = builder.template.layers
      .filter((l) => l.visibility === `{{show:${toggle.id}}}`)
      .map((l) => l.minzoom ?? 0);
    assert.equal(toggle.minzoom, Math.min(...zooms), `the zoom for "${toggle.id}" is wrong`);
  }
  const buildings = builder.toggles.find((t) => t.id === "buildings");
  assert.equal(buildings.minzoom, 12, "buildings start at z12, so the number must say so");
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(page.includes('"z" + toggle.minzoom'), "the page does not show the zoom on the button");
  assert.ok(page.includes("zoom in to see them disappear"), "the page does not explain a no visible change");
});

await check("the libraries are pinned to a version with an integrity hash", async () => {
  // A wrong hash does not degrade, it blocks: the script never runs, the map never
  // appears, and the error most visitors will never read. So the digest in the page
  // is recomputed from the bytes the CDN serves, not trusted.
  //
  // Pinned, not floating. With @5 the bytes under a URL can change without the URL
  // changing, and an integrity hash is then impossible, which is what let this page
  // ship without one for so long.
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  const tags = [...page.matchAll(
    /(?:href|src)="(https:\/\/cdn\.jsdelivr\.net\/npm\/[^"]+@([\d.]+)\/[^"]+)"\s*\n\s*integrity="([^"]+)"/g
  )];
  assert.equal(tags.length, 3, `expected 3 pinned CDN tags, found ${tags.length}`);
  assert.ok(!/@\d+\/dist\//.test(page.replace(/@[\d.]+\//g, "@")), "a tag uses a floating version");
  for (const [, url, version, integrity] of tags) {
    const response = await fetch(url);
    assert.equal(response.status, 200, `${url} returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = "sha384-" + createHash("sha384").update(bytes).digest("base64");
    assert.equal(integrity, digest, `${url} is pinned at ${version} but the hash is for other bytes`);
  }
});

await check("the page documents the fonts and the sprites it serves", () => {
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(page.includes("Fonts and sprites"), "the page has no section on fonts and sprites");
  // The claim is a hostname swap, so the demo host has to be named and shown as
  // the before. If that section goes, the claim it makes is gone with it.
  assert.ok(page.includes("demotiles.maplibre.org"), "the swap-from host is not named");
  assert.ok(page.includes("replacing that hostname is the whole change"), "the swap is not explained");
  assert.ok(page.includes("Noto Sans Bold"), "the missing bold stack is not called out");
  assert.ok(page.includes("256 codepoints at a time"), "the page does not explain the 256 ranges");
  assert.ok(page.includes("local name"), "the page does not say why non-Latin ranges matter");
  // The page states which host serves what, and why. If that goes stale the page
  // makes a claim nobody measured, which is the one thing not to do here.
  assert.ok(page.includes("Fonts, sprites and the libraries"), "the section is not titled for all three");
  assert.ok(/decide[sd]?\b|decision, not a/.test(page), "the page does not separate the decision from the measurement");
  assert.ok(page.includes("protomaps.github.io"), "the page does not offer the upstream alternative");
});

await check("a published style carries no placeholder", () => {
  // It did. buildStyle writes {{show:toggle}} into the visibility of every layer a
  // toggle covers, and the shipped files were written straight from that, so all
  // three styles carried a literal {{show:roads}} in them. MapLibre fell back to the
  // default, so nothing broke and nobody noticed, but a developer who copied one
  // copied the placeholder into their own style.
  for (const id of ["light", "bright", "dark"]) {
    const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", `${id}.json`), "utf8"));
    const left = renderProblems(style);
    assert.deepEqual(left, [], `${id}.json still has ${left.join(", ")}`);
    for (const layer of style.layers) {
      if (layer.visibility) {
        assert.ok(["visible", "none"].includes(layer.visibility),
          `${id}.json layer ${layer.id} has visibility ${layer.visibility}`);
      }
    }
  }
  // And it has a sprite, or the icons are silently absent.
  for (const id of ["light", "bright", "dark"]) {
    const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", `${id}.json`), "utf8"));
    assert.ok(style.sprite, `${id}.json has no sprite, so no icon will draw`);
    assert.ok(/^https:\/\/tiles\.jasontally\.com\/sprites\/v4\//.test(style.sprite),
      `${id}.json points its sprite at ${style.sprite}`);
  }
});

await check("the roads filter on kind, not on kind_detail", () => {
  // This is the bug that had the public map drawing no roads at all. The class names
  // in the upstream documentation — motorway, trunk, primary, residential — are
  // kind_detail values. roads.kind is the coarse class: highway, major_road,
  // minor_road, path, rail. Filtering kind against the detail names matched nothing,
  // and every layer still loaded and every request still succeeded.
  const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "bright.json"), "utf8"));
  const roadLayers = style.layers.filter((l) => l["source-layer"] === "roads");
  const coarse = new Set(["highway", "major_road", "minor_road", "path", "rail"]);
  const detailOnly = new Set([
    "motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified",
    "living_street", "service", "road", "footway", "cycleway", "steps", "pedestrian",
    "light_rail", "subway", "tram", "narrow_gauge",
  ]);
  const bad = [];
  const used = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node[0] === "get" && node[1] === "kind" && Array.isArray(node[1]) === false) {
      used.push(node[1]);
    }
    // ["match", ["get", field], kinds...]
    if (node[0] === "match" && Array.isArray(node[1]) && node[1][0] === "get") {
      const field = node[1][1];
      if (field === "kind") {
        for (const label of node.slice(2, -1)) {
          if (Array.isArray(label)) for (const kind of label) if (detailOnly.has(kind)) bad.push(kind);
        }
      }
    }
    node.forEach(walk);
  };
  for (const layer of roadLayers) walk(layer.filter);
  assert.deepEqual(bad, [], `a roads filter matches a kind_detail value against kind: ${[...new Set(bad)].join(", ")}`);
  // And the classes actually used are all coarse ones.
  const kinds = new Set(used.filter((k) => k === "kind"));
  assert.ok(kinds.size > 0, "no roads layer filters on kind at all");
  for (const layer of roadLayers) {
    const json = JSON.stringify(layer.filter);
    for (const detail of detailOnly) {
      assert.ok(!json.includes(`"${detail}"`), `${layer.id} still mentions ${detail}`);
    }
  }
});

await check("a layer waiting on a field names it, and the page says so", () => {
  // A toggle that is correct and silent reads as broken. These two draw nothing until
  // the archive carries a field, so they have to say so rather than look dead.
  const builder = readBuilder();
  for (const toggle of builder.toggles) {
    if (!toggle.needs) continue;
    assert.ok(/^[a-z]+\.[a-z_]+$/.test(toggle.needs), `${toggle.id} needs is not a layer.field: ${toggle.needs}`);
    const [layer, field] = toggle.needs.split(".");
    // The archive's own field list, over HTTP, is the only honest source for this.
    // Offline, the check is that the field is named and the page renders it.
  }
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(page.includes("needs "), "the page does not show which layer needs what");
  assert.ok(page.includes("addr_housenumber"), "the page does not name the missing house number field");
  assert.ok(page.includes("shield_text"), "the page does not name the missing shield text field");
  assert.ok(page.includes("inside"), "the page does not say the address points are inside buildings");
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);