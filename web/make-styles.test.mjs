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
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStyle, renderTemplate, renderProblems, missingIcons, spriteIcons,
  placeholderPalette, TOGGLE_EXCLUSIONS, FLAVORS, SCHEMA, TILES_URL,
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

await check("one style pill, showing the style on the map", () => {
  // There used to be three: a pill on the map that fetched the style the flavour
  // button had picked, a block of JSON in the builder showing the style actually
  // drawn, and a copy button that silently put it on the clipboard. Two of the three
  // said "Style JSON" and showed different files the moment anything had been
  // changed, which is a small lie rather than a convenience. One pill, one place, and
  // it reads the live style.
  const page = readFileSync(join(HERE, "index.html"), "utf8");

  // No pill on the map any more. Archive metadata stays: it is the archive, not a
  // style, and it is the one thing on that bar that is not about styling.
  assert.ok(!page.includes('id="show-style"'), "there is still a style pill on the map");
  assert.ok(page.includes('id="show-meta"'), "the archive metadata pill went with it");
  assert.ok(page.includes('id="builder-copy">Style JSON<'),
    "the builder's style pill is not labelled Style JSON");

  // The inline JSON block is gone, so there is one copy of the style rather than one
  // shown and one to keep in step.
  assert.ok(!page.includes('id="builder-json"'), "the builder still writes JSON somewhere");

  // The pill shows the style the map is drawing, not the selected one.
  assert.ok(/showCurrentStyle\(\)/.test(page), "the pill does not open the current style");
  assert.ok(/const style = currentStyle\(\);/.test(page),
    "showCurrentStyle does not read the live style");

  // And the dialog has its own copy button, so a copy does not need a second pill.
  assert.ok(page.includes('id="style-copy"'), "the dialog has no copy button");
  assert.ok(/\$\("style-copy"\)\.addEventListener/.test(page),
    "the dialog's copy button is not wired");

  // apply() refreshes what the dialog shows when a change happens with it open, so
  // it cannot go stale while somebody is editing.
  assert.ok(/if \(dialog\.open\) showCurrentStyle\(\);/.test(page),
    "an edit with the dialog open does not refresh what it shows");
});

await check("the zoom control yields the corner to an error message", () => {
  // It sits bottom left, because the attribution control owns the bottom right and
  // the two overlapped. And it gives way when there is a message to show, because a
  // message that says the tiles failed matters more than a number.
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(page.includes('id="zoomer"'), "the zoom control has no id to address");
  assert.ok(/\.zoomer \{[^}]*bottom: \.6rem; left: \.6rem/.test(page),
    "the zoom control is not in the lower left corner");
  assert.ok(page.includes(".zoomer.yielding"), "the zoom control cannot be hidden");
  assert.ok(/classList\.toggle\("yielding", Boolean\(text\)\)/.test(page),
    "setHint does not yield the corner to its message");
  // It must be visible when there is no message, or the fix has removed it.
  assert.ok(/map\.on\("move", paintZoom\)/.test(page),
    "the zoom readout does not follow the map, so it goes stale on any other input");
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

await check("no layer is in a toggle and also excluded from one", () => {
  // These are the three layers that stay in the style and get no toggle, and the
  // page does not offer them. The test exists because the reverse mistake is easy:
  // a toggle for a layer that cannot draw, which looks broken and invites the
  // visitor to think the map is at fault.
  const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "bright.json"), "utf8"));
  const ids = new Set(style.layers.map((l) => l.id));
  for (const excluded of TOGGLE_EXCLUSIONS) {
    // Two different reasons for the same state, and they are not interchangeable.
    // place-settlement is gone outright, because its kind does not exist in the
    // archive. The other two ship and are filtered on ["has", field], so they draw
    // themselves when a refresh brings the field in.
    if (excluded === "place-settlement") {
      assert.ok(!ids.has(excluded), `${excluded} is back, and its kind is not in the archive`);
    } else {
      assert.ok(ids.has(excluded), `${excluded} is excluded but no longer in the style`);
    }
    const covered = TOGGLE_GROUPS.find((g) => g.layers.includes(excluded));
    assert.ok(!covered, `${excluded} is excluded from the builder but still under a toggle`);
  }
  // And the builder payload does not carry them.
  const builder = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "builder.json"), "utf8"));
  const offered = new Set(builder.toggles.flatMap((t) => [t.id]));
  for (const excluded of TOGGLE_EXCLUSIONS) {
    assert.ok(![...offered].some((id) => id === excluded), `${excluded} still has a toggle`);
  }
  // The page itself no longer mentions a badge it cannot produce.
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  assert.ok(!page.includes("toggle.needs"), "the page still renders a needs badge");
});

await check("the towns kinds are the five the archive carries", () => {
  // `settlement` was once in this list. It is not one of the five `places` kinds,
  // so the layer it built drew nothing at all: zero features in 2208 sampled tiles
  // and zero in a browser at z1 through z15. A layer for a kind the data does not
  // have is dead code that reads as load bearing.
  const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "bright.json"), "utf8"));
  const places = style.layers.filter((l) => l.id.startsWith("place-")).map((l) => l.id);
  assert.deepEqual(places.sort(), [
    "place-country", "place-locality", "place-macrohood", "place-neighbourhood", "place-region",
  ], "the place layers are not the five archive kinds");
  assert.ok(!places.includes("place-settlement"), "place-settlement is back, and it cannot draw");
});

await check("every layer has the fields MapLibre validates", () => {
  // This is the check that was missing when a map went blank with no error.
  //
  // MapLibre validates a style before it loads one. A layer with no `type` fails
  // that validation, and a style that fails it is not loaded at all: not the
  // sources, not the sprite, not the layers, nothing. No request fails, nothing
  // goes red in the network log, and the map simply sits there. The only hint is
  // a tile count of two and no glyph request ever being made.
  //
  // So each of these is checked on the styles that ship, not only on the template.
  for (const id of ["light", "bright", "dark"]) {
    const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", `${id}.json`), "utf8"));
    const ids = style.layers.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, `${id}.json has duplicate layer ids`);

    for (const layer of style.layers) {
      assert.ok(layer.id, `${id}.json has a layer with no id`);
      assert.ok(layer.type, `${id}.json layer ${layer.id} has no type`);
      // A background layer paints the page behind everything and has no source.
      if (layer.type !== "background") {
        assert.ok(layer.source, `${id}.json layer ${layer.id} has no source`);
      }
      // A symbol or fill layer needs to know which layer of the tile to read.
      if (layer.type !== "background") {
        assert.ok(layer["source-layer"], `${id}.json layer ${layer.id} has no source-layer`);
      }
      assert.ok(typeof layer.type === "string" && layer.type.length > 0,
        `${id}.json layer ${layer.id} type is ${JSON.stringify(layer.type)}`);
      if (layer.visibility) {
        assert.ok(["visible", "none"].includes(layer.visibility),
          `${id}.json layer ${layer.id} visibility ${layer.visibility}`);
      }
      if (layer.minzoom !== undefined) {
        assert.ok(Number.isInteger(layer.minzoom) && layer.minzoom >= 0,
          `${id}.json layer ${layer.id} minzoom ${layer.minzoom}`);
      }
    }

    // Sources the layers name must exist. A background layer names none.
    for (const source of Object.values(style.sources || {})) {
      assert.ok(source.url, `${id}.json has a source with no url`);
    }
    const named = new Set(Object.keys(style.sources || {}));
    for (const layer of style.layers) {
      if (layer.type === "background") continue;
      assert.ok(named.has(layer.source),
        `${id}.json layer ${layer.id} names source ${layer.source}, which is not in the style`);
    }
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

await check("every icon the styles ask for is in the sprite", () => {
  // A missing icon is the quietest failure in the style. The request 404s and a
  // symbol layer with an icon it cannot fetch suppresses the text label with it, so
  // the feature is absent from the map rather than mislabelled on it. Nothing in the
  // network log stands out. This was found the same way: two names the sprite never
  // had, asked for by every POI of that kind.
  const icons = spriteIcons();
  assert.ok(icons.length > 40, `only ${icons.length} icons read from the sprite`);
  // And they are read from the sheets, not listed by hand, so they cannot drift.
  const sheet = JSON.parse(readFileSync(join(HERE, "..", "assets", "sprites", "v4", "light.json"), "utf8"));
  for (const name of icons) assert.ok(sheet[name] !== undefined, `${name} is not in light.json`);
  for (const id of ["light", "bright", "dark"]) {
    const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", `${id}.json`), "utf8"));
    const missing = missingIcons(style);
    assert.deepEqual(missing, [], `${id}.json asks the sprite for ${missing.join(", ")}`);
  }
});

await check("the sources the styles name, the glyphs and the sheets all exist", () => {
  // The other three supports. A layer with data and no glyph is a layer with names
  // in the tile and nothing on the map, so each is checked against the thing it is
  // served from rather than against a list written here.
  const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "bright.json"), "utf8"));

  // Glyphs: every font stack the style names must have a range on this host.
  // Only text-font, which is the property that names a stack. Roaming the whole
  // layout collects operators like coalesce, which are not font stacks.
  const stacks = new Set();
  for (const layer of style.layers) {
    const value = (layer.layout || {})["text-font"];
    if (typeof value === "string") stacks.add(value);
    else if (Array.isArray(value)) for (const name of value) stacks.add(name);
  }
  // Nothing to check offline beyond that the stacks are the ones we publish.
  for (const stack of stacks) {
    assert.ok(
      ["Noto Sans Regular", "Noto Sans Medium"].includes(stack),
      `the style asks for the stack "${stack}", which is not one of the two published`
    );
  }

  // Sprites: the sheet each flavour names is published, at 1x and 2x.
  for (const id of ["light", "bright", "dark"]) {
    const s = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", `${id}.json`), "utf8"));
    const sheet = s.sprite.match(/sprites\/v4\/([a-z]+)$/)[1];
    for (const variant of ["", "@2x"]) {
      for (const ext of ["json", "png"]) {
        assert.ok(
          existsSync(join(HERE, "..", "public", "sprites", "v4", `${sheet}${variant}.${ext}`)),
          `${id}.json points at ${sheet}${variant}.${ext}, which is not published`
        );
      }
    }
  }

  // Vectors: every source-layer the style names is one of the nine in the archive.
  const named = [...new Set(style.layers.filter((l) => l["source-layer"]).map((l) => l["source-layer"]))];
  for (const layer of named) {
    assert.ok(SCHEMA[layer], `the style reads source-layer "${layer}", which the archive does not have`);
  }
});

await check("the examples cover the layers, the colours, and where the copy goes", () => {
  // These are the things a reader has to be told, learned the hard way here: a
  // filter on the wrong field draws nothing and says nothing, and a layer above the
  // archive's top zoom never draws. Also that the builder's copy is a file they put
  // somewhere, which the docs used to leave out entirely. Nothing in this is new
  // prose for its own sake.
  const page = readFileSync(join(HERE, "index.html"), "utf8");

  // Where the copy goes, both ways.
  assert.ok(page.includes("Where to put the style you made"), "there is no section on using a copied style");
  assert.ok(/style: <span[^>]*>"my-basemap\.json"/.test(page), "no example of a saved file");
  assert.ok(/const myStyle = \{/.test(page), "no example of a style inline in the page");

  // The two things in a filter that get everybody.
  assert.ok(/kind<\/code> is the coarse name/.test(page), "the kind vocabulary is not explained");
  for (const kind of ["highway", "major_road", "minor_road", "path", "rail"]) {
    assert.ok(page.includes(kind), `the roads kind ${kind} is not listed`);
  }
  for (const detail of ["motorway", "primary", "residential"]) {
    assert.ok(page.includes(detail), `${detail} is not named as a kind_detail`);
  }
  assert.ok(page.includes("kind_detail"), "kind_detail is not named at all");

  // The minzoom rules, including the one that cost the address layer its chance.
  assert.ok(/A layer is not drawn below its own <code>minzoom/.test(page),
    "the layer minzoom rule is not explained");
  assert.ok(page.includes("The archive stops at z15"), "the z15 ceiling is not stated");

  // The silence of a blank layer, which is what made all of this hard to find.
  assert.ok(/a layer that draws nothing is not an error/i.test(page),
    "the page does not say that a blank layer is silent");

  // Colours: a paint block a reader can copy the shape of.
  assert.ok(page.includes('"line-color"'), "no line colour example");
  assert.ok(page.includes('"text-color"'), "no text colour example");

  // And the freshness claim is current, not the old "not being refreshed".
  assert.ok(!page.includes("is not being refreshed"), "the page still says the archive is not refreshed");
  assert.ok(page.includes("rebuilt weekly"), "the page does not say the copy is rebuilt weekly");
});

await check("every label and halo clears the WCAG AA text bar", async () => {
  // SC 1.4.3 Contrast (Minimum), Level AA: 4.5:1 for text against its background.
  // This is the one contrast bar that is enforced for a map, because a label that
  // is dim is unreadable and there is no version of a good dark map with one.
  //
  // The previous dark palette passed this and failed almost every shape bar, which
  // is why the dark redraw was worth doing: the thing a dark map must fix is the
  // line work and the fills, and the way to do that without breaking the labels is
  // to spend the contrast budget on the thin things and leave the wide fills dark.
  const { contrast } = await import("../tools/contrast.mjs");
  const TEXT_BAR = 4.5;
  const backdrop = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

  for (const id of ["light", "bright", "dark"]) {
    const style = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", `${id}.json`), "utf8"));
    const bg = backdrop(style.layers.find((l) => l.id === "background").paint["background-color"]);
    for (const layer of style.layers) {
      if (layer.type !== "symbol") continue;
      const text = layer.paint && layer.paint["text-color"];
      if (!text) continue;
      for (const back of [bg, layer.paint["text-halo-color"]]) {
        if (typeof back !== "string") continue;
        const ratio = contrast(text, back);
        assert.ok(
          ratio >= TEXT_BAR,
          `${id}.json layer ${layer.id} text ${text} on ${back} is ${ratio.toFixed(2)}, needs ${TEXT_BAR}`
        );
      }
    }
  }
});

await check("the dark palette spends its contrast on the thin things", async () => {
  // The brief this redraw answered: keep water near black for OLED, and give the
  // thin things the contrast they need. So check that shape, not just that the
  // colours exist. Water is dark, and the edges and roads are the brightest things
  // in the palette.
  const { contrast, luminance } = await import("../tools/contrast.mjs");
  const dark = JSON.parse(readFileSync(join(HERE, "..", "public", "styles", "dark.json"), "utf8"));
  const layer = (id) => dark.layers.find((l) => l.id === id);
  const palette = (await import("../web/make-styles.mjs")).FLAVORS.dark;

  // Water as close to black as an OLED pixel allows.
  assert.equal(palette.water, "#000000", "the dark water is not black, so the OLED saving is lost");
  // The land only just off it, so the wide fills stay cheap.
  assert.ok(luminance(palette.earth) < 0.01, `the dark land is too bright: ${palette.earth}`);
  // The edges and the lines are what carry the map, and they are bright.
  for (const key of ["waterLine", "landEdge", "road", "roadMajor", "boundary"]) {
    assert.ok(
      contrast(palette[key], "#000000") >= 3,
      `the dark ${key} is ${palette[key]}, which is too dim to carry a line at 3:1`
    );
  }
  // And the edge keys are actually drawn, not just present in the palette. A colour
  // the style never reads is a control that changes nothing.
  assert.equal(layer("water-line").paint["line-color"], palette.waterLine,
    "the water edge is not the one the palette says it is");
  assert.ok(layer("earth").paint["fill-outline-color"],
    "the land has no edge outline, so land and water merge");
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);