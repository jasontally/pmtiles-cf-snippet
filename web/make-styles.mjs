#!/usr/bin/env node
/**
 * Write the MapLibre styles for the documentation map.
 *
 * One archive, several styles. The archive holds one set of tiles with every
 * cartographic class already in the data, so a "flavour" is only a different set
 * of colours and label rules over the same tiles. That is why a flavour switch
 * costs nothing: the browser keeps the tiles it already has.
 *
 *   node web/make-styles.mjs [outDir]
 *
 * Writes index.json, light.json, dark.json and bright.json. index.json is the
 * list the documentation page builds its flavour buttons from, so adding a
 * flavour here needs no change to the page.
 *
 * The tile URL and the schema are the only two things this file knows about the
 * data. Everything else is styling.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The renderer is shared with the browser, so the page and the build agree.
export { renderTemplate, hasUnfilled, packEdits, unpackEdits } from "./render-template.mjs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || join(ROOT, "public", "styles");

// The one place the archive is named.
const TILES_URL = "https://tiles.jasontally.com/basemap.pmtiles";
const SOURCE_NAME = "protomaps";
const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';

// Labels need glyphs. This is the public glyph server from the MapLibre demo
// tiles, which serves the Noto Sans stacks used below. Nothing here is on our
// origin, so a glyph outage does not take the map down.
const GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

/**
 * The nine source layers in this archive, with the zoom range each one carries.
 * A style layer may only reference a layer that exists, so the test suite checks
 * every source-layer named here against the archive metadata.
 */
export const SCHEMA = {
  boundaries: [0, 15],
  buildings: [11, 15],
  earth: [0, 15],
  landcover: [0, 7],
  landuse: [2, 15],
  places: [0, 15],
  pois: [5, 15],
  roads: [3, 15],
  water: [0, 15],
};

/** [id, kind values, first zoom, line width] for each road class. */
const ROADS = [
  ["road-highway", ["motorway", "trunk"], 3, 2.2],
  ["road-major", ["primary"], 4, 1.7],
  ["road-medium", ["secondary", "tertiary"], 5, 1.2],
  ["road-minor", ["residential", "unclassified", "living_street"], 7, 0.8],
  ["road-service", ["service", "road"], 10, 0.4],
  ["road-path", ["footway", "path", "cycleway", "steps", "pedestrian"], 12, 0.35],
  ["road-rail", ["rail", "light_rail", "subway", "tram", "narrow_gauge"], 11, 0.5],
];

/** [id, kind values] for the water features that are lines, not polygons. */
const WATER_LINES = [["river", "stream", "canal", "drain", "ditch"]];

const inKind = (kinds) => ["match", ["get", "kind"], kinds, true, false];
const inKindAny = (kinds) => ["match", ["get", "kind"], kinds, 1, 0];

/** The localised name if the tile has it, else the plain name. */
const NAME = ["coalesce", ["get", "name:en"], ["get", "name"]];

/** Show a feature when its own min_zoom says the map is zoomed in far enough. */
const shownAt = (zoom) => ["<=", ["get", "min_zoom"], zoom];

// One id and its casing per road class. A stray id here names a layer that
// does not exist, and the toggle that covers it silently does nothing.
const PLACE_IDS = ROADS.flatMap(([id]) => [id, `${id}-casing`]);
const PLACE_LAYER_IDS = [
  "country", "region", "locality", "macrohood", "neighbourhood", "settlement",
].map((kind) => `place-${kind}`);

/**
 * The toggles the documentation page offers, and the layers each one covers.
 *
 * `layers` must name real layer ids. The test suite checks that, because a typo
 * here is a toggle that silently does nothing.
 */
export const TOGGLE_GROUPS = [
  { id: "landcover", label: "Land cover", layers: ["landcover"] },
  { id: "landuse", label: "Land use", layers: ["landuse"] },
  { id: "water", label: "Water", layers: ["water", "water-line"] },
  { id: "boundaries", label: "Boundaries", layers: ["boundary-region", "boundary-country"] },
  { id: "roads", label: "Roads", layers: PLACE_IDS },
  { id: "buildings", label: "Buildings", layers: ["buildings"] },
  { id: "labels", label: "Place labels", layers: [...PLACE_LAYER_IDS, "poi"] },
];

/**
 * The palette keys the page exposes as colour inputs, grouped for the form.
 *
 * Only keys that reach a visible layer are listed. A key that no layer reads
 * would give the user a control that changes nothing.
 */
export const CONTROLS = [
  { group: "Background", keys: ["background", "earth"] },
  { group: "Land", keys: ["forest", "grass", "farmland", "park", "sand", "rock", "ice"] },
  { group: "Water", keys: ["water"] },
  { group: "Roads", keys: ["road", "roadMajor", "roadCasing"] },
  { group: "Boundaries and labels", keys: ["boundary", "label", "halo", "poiLabel"] },
  { group: "Buildings", keys: ["building", "buildingOutline"] },
];

/** Every colour key the page may edit, from CONTROLS. */
export const CONTROL_KEYS = [...new Set(CONTROLS.flatMap((group) => group.keys))];

/**
 * A palette whose every value is a `{{key}}` placeholder.
 *
 * `swatch` never reaches a style, so it is left out: a placeholder the renderer
 * would fail to fill is worse than no placeholder.
 */
export function placeholderPalette() {
  const out = {};
  for (const key of Object.keys(FLAVORS.light)) {
    if (key === "swatch") continue;
    out[key] = `{{${key}}}`;
  }
  return out;
}

/**
 * Build the style for one flavour.
 *
 * Colours come from `palette`. Everything else is shared, so a flavour cannot
 * drift away from the others in structure.
 *
 * Passing a palette of `{{key}}` placeholders instead of colours gives the
 * template the browser side builder edits. One code path, so the template can
 * never describe a different map from the styles that ship.
 */
export function buildStyle(flavor, palette = FLAVORS[flavor]) {
  const p = palette;
  const layers = [];

  layers.push({ id: "background", type: "background", paint: { "background-color": p.background } });

  // ---- land ----
  layers.push({
    id: "earth",
    type: "fill",
    source: SOURCE_NAME,
    "source-layer": "earth",
    paint: {
      "fill-color": ["match", ["get", "kind"], "glacier", p.ice, "bare_rock", p.rock, "sand", p.sand, p.earth],
    },
  });

  layers.push({
    id: "landcover",
    type: "fill",
    source: SOURCE_NAME,
    "source-layer": "landcover",
    paint: {
      "fill-color": [
        "match",
        ["get", "kind"],
        "forest", p.forest,
        "grass", p.grass,
        "farmland", p.farmland,
        "scrub", p.scrub,
        "ice", p.ice,
        "sand", p.sand,
        "wetland", p.wetland,
        p.landcover,
      ],
      "fill-opacity": 0.9,
    },
  });

  layers.push({
    id: "landuse",
    type: "fill",
    source: SOURCE_NAME,
    "source-layer": "landuse",
    paint: {
      "fill-color": [
        "match",
        ["get", "kind"],
        "park", p.park,
        "forest", p.forest,
        "wood", p.forest,
        "farmland", p.farmland,
        "grass", p.grass,
        "meadow", p.grass,
        "residential", p.residential,
        "commercial", p.commercial,
        "industrial", p.industrial,
        "school", p.school,
        "university", p.school,
        "hospital", p.school,
        "cemetery", p.park,
        "nature_reserve", p.park,
        "protected_area", p.park,
        "golf_course", p.grass,
        "garden", p.park,
        "playground", p.playground,
        "pitch", p.playground,
        "stadium", p.playground,
        "recreation_ground", p.playground,
        "zoo", p.park,
        "beach", p.sand,
        "village_green", p.grass,
        "allotments", p.farmland,
        "scrub", p.scrub,
        "wetland", p.wetland,
        "glacier", p.ice,
        "aerodrome", p.industrial,
        "military", p.industrial,
        "landfill", p.industrial,
        "quarry", p.rock,
        p.landuse,
      ],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0, 6, 0.55],
    },
  });

  // ---- water ----
  layers.push({
    id: "water",
    type: "fill",
    source: SOURCE_NAME,
    "source-layer": "water",
    filter: inKind(["ocean", "lake", "water", "reservoir", "playa", "swimming_pool"]),
    paint: { "fill-color": p.water },
  });

  layers.push({
    id: "water-line",
    type: "line",
    source: SOURCE_NAME,
    "source-layer": "water",
    filter: inKind(WATER_LINES[0]),
    paint: { "line-color": p.water, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 10, 1.6] },
  });

  // ---- boundaries, under the roads ----
  layers.push({
    id: "boundary-region",
    type: "line",
    source: SOURCE_NAME,
    "source-layer": "boundaries",
    filter: inKind(["region"]),
    paint: { "line-color": p.boundary, "line-width": 1, "line-dasharray": [3, 2], "line-opacity": 0.7 },
  });

  layers.push({
    id: "boundary-country",
    type: "line",
    source: SOURCE_NAME,
    "source-layer": "boundaries",
    filter: inKind(["country"]),
    paint: { "line-color": p.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 6, 1.8] },
  });

  // ---- roads: every class gets a casing and a fill, casings first ----
  for (const [id, kinds, minzoom, width] of ROADS) {
    layers.push({
      id: `${id}-casing`,
      type: "line",
      source: SOURCE_NAME,
      "source-layer": "roads",
      minzoom,
      filter: inKind(kinds),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], minzoom, width, 15, width * 3.2],
      },
    });
    layers.push({
      id,
      type: "line",
      source: SOURCE_NAME,
      "source-layer": "roads",
      minzoom,
      filter: inKind(kinds),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", ["in", ["get", "kind"], ["literal", ["motorway", "trunk"]]], p.roadMajor, p.road],
        "line-width": ["interpolate", ["linear"], ["zoom"], minzoom, width, 15, width * 3.2],
      },
    });
  }

  // ---- buildings ----
  layers.push({
    id: "buildings",
    type: "fill",
    source: SOURCE_NAME,
    "source-layer": "buildings",
    minzoom: 12,
    paint: {
      "fill-color": p.building,
      "fill-outline-color": p.buildingOutline,
      // Tall buildings read darker, which makes a downtown legible at a glance.
      "fill-opacity": [
        "interpolate",
        ["linear"],
        ["coalesce", ["to-number", ["get", "height"], 0], 0],
        0, 0.55,
        40, 0.9,
      ],
    },
  });

  // ---- place labels ----
  const PLACE_KINDS = ["country", "region", "locality", "macrohood", "neighbourhood", "settlement"];

  for (const [kind, minzoom, size, halo] of [
    ["country", 0, 13, 1.4],
    ["region", 4, 10, 1.2],
    ["locality", 5, 11, 1.3],
    ["macrohood", 11, 10, 1.2],
    ["neighbourhood", 13, 10, 1.2],
    ["settlement", 11, 10, 1.2],
  ]) {
    layers.push({
      id: `place-${kind}`,
      type: "symbol",
      source: SOURCE_NAME,
      "source-layer": "places",
      filter: ["all", inKind([kind]), shownAt(minzoom + 1)],
      layout: {
        "text-field": NAME,
        "text-font": FONT_BOLD,
        "text-size": ["interpolate", ["linear"], ["zoom"], minzoom, size * 0.75, minzoom + 4, size],
        "text-transform": kind === "country" ? "uppercase" : "none",
        "text-letter-spacing": 0.08,
        "text-max-width": 7,
      },
      paint: {
        "text-color": p.label,
        "text-halo-color": p.halo,
        "text-halo-width": halo,
      },
    });
  }

  // ---- point of interest labels, no icons so no sprite is needed ----
  const POI_KINDS = [
    "park", "national_park", "garden", "airport", "railway_station", "peak", "volcano",
    "museum", "zoo", "university", "hospital", "place_of_worship", "castle", "fort",
    "marina", "harbour", "port", "stadium", "aquarium", "library",
  ];

  layers.push({
    id: "poi",
    type: "symbol",
    source: SOURCE_NAME,
    "source-layer": "pois",
    minzoom: 11,
    filter: ["all", inKind(POI_KINDS), shownAt(12)],
    layout: {
      "text-field": NAME,
      "text-font": FONT,
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 16, 12],
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-max-width": 8,
    },
    paint: { "text-color": p.poiLabel, "text-halo-color": p.halo, "text-halo-width": 1.2 },
  });

  // A page toggle has to set `visibility` on every layer in the group, because
  // visibility does not cascade. The groups are named here once and expanded, so
  // the page and the styles cannot disagree about what a toggle covers.
  for (const layer of layers) {
    const group = TOGGLE_GROUPS.find((g) => g.layers.includes(layer.id));
    if (group) layer.visibility = `{{show:${group.id}}}`;
  }

  return {
    version: 8,
    name: `Protomaps Basemap — ${p.name}`,
    metadata: {
      "jasontally:tiles": TILES_URL,
      "jasontally:flavor": flavor,
      "jasontally:note":
        "Free to use, no API key, no rate limit, no service level guarantee. " +
        "Tiles are Protomaps Basemap derived from OpenStreetMap.",
    },
    // Somewhere with detail in every flavour, for the documentation page.
    center: [2.35, 48.85],
    zoom: 4.2,
    bearing: 0,
    pitch: 0,
    glyphs: GLYPHS,
    sources: {
      [SOURCE_NAME]: {
        type: "vector",
        url: `pmtiles://${TILES_URL}`,
        attribution: ATTRIBUTION,
      },
    },
    layers,
  };
}

/**
 * The three palettes.
 *
 * Every key used by buildStyle must exist in every flavour. A missing key
 * produces a `null` colour and a style that fails validation in the browser, so
 * the test suite compares the key sets.
 *
 * `name` is what the page shows on the button. `swatch` is the hex it paints in
 * the button. They are separate keys because an earlier version used `label` for
 * the hex, and the buttons rendered as "#f8f4f0".
 */
export const FLAVORS = {
  light: {
    name: "Light",
    swatch: "#f8f4f0",
    background: "#f8f4f0",
    earth: "#f6f2ec",
    rock: "#e8e2d8",
    sand: "#efe6d2",
    ice: "#ffffff",
    landcover: "#ece7de",
    landuse: "#f2ede5",
    forest: "#dce8cf",
    grass: "#e4edd6",
    farmland: "#eee9d5",
    scrub: "#e2e9d2",
    park: "#d9ead2",
    residential: "#efe8e0",
    commercial: "#eee3da",
    industrial: "#e6e2df",
    school: "#e9e4ee",
    playground: "#dfead8",
    wetland: "#d8e6e0",
    water: "#a8cbf0",
    boundary: "#8a8378",
    road: "#ffffff",
    roadMajor: "#fbd0a4",
    roadCasing: "#c9b8a2",
    building: "#e3ddd3",
    buildingOutline: "#d5cec2",
    label: "#3c3a35",
    poiLabel: "#6b675e",
    halo: "#ffffff",
  },
  bright: {
    name: "Bright",
    swatch: "#fdfdfb",
    background: "#fdfdfb",
    earth: "#fbfaf6",
    rock: "#eee8dc",
    sand: "#f6ecd4",
    ice: "#ffffff",
    landcover: "#f0ece2",
    landuse: "#f6f2e9",
    forest: "#c3e8c6",
    grass: "#d6efb8",
    farmland: "#f3eed6",
    scrub: "#dfecc8",
    park: "#bfe8bd",
    residential: "#f2e6dd",
    commercial: "#f5ddd0",
    industrial: "#e8e4e1",
    school: "#e6ddf2",
    playground: "#cfecc7",
    wetland: "#c9e8e2",
    water: "#8ecdf5",
    boundary: "#7b7468",
    road: "#ffffff",
    roadMajor: "#ffc44d",
    roadCasing: "#b0a48e",
    building: "#e6ded2",
    buildingOutline: "#d8cdbc",
    label: "#2b2a26",
    poiLabel: "#5d5a51",
    halo: "#ffffff",
  },
  dark: {
    name: "Dark",
    swatch: "#26282b",
    background: "#1c1e21",
    earth: "#24262a",
    rock: "#33363a",
    sand: "#3a3730",
    ice: "#3f454b",
    landcover: "#262a2c",
    landuse: "#212427",
    forest: "#24352a",
    grass: "#2b3527",
    farmland: "#32302a",
    scrub: "#2c332a",
    park: "#22342a",
    residential: "#2a2c30",
    commercial: "#2e2a2c",
    industrial: "#2b2e33",
    school: "#282a33",
    playground: "#233527",
    wetland: "#22322f",
    water: "#16323f",
    boundary: "#5b6169",
    road: "#3c4148",
    roadMajor: "#8a6a45",
    roadCasing: "#202225",
    building: "#2d3136",
    buildingOutline: "#3a3f45",
    label: "#d6d8db",
    poiLabel: "#a2a7ad",
    halo: "#141618",
  },
};

/** Byte size of a style file, without needing it written first. */
function styleBytes(id) {
  return Buffer.byteLength(`${JSON.stringify(buildStyle(id), null, 2)}\n`);
}

/** The /styles/ listing. One self contained page, no build step for the reader. */
function stylesIndexPage(palettes) {
  const rows = Object.entries(palettes)
    .map(
      ([id, p]) =>
        `      <tr><td><a href="${id}.json">${id}.json</a></td>` +
        `<td><span class="swatch" style="background:${p.swatch}"></span> ${p.name}</td>` +
        `<td class="mono">${styleBytes(id).toLocaleString()}</td></tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MapLibre styles — tiles.jasontally.com</title>
<meta name="description" content="MapLibre GL styles for the Protomaps Basemap tiles at tiles.jasontally.com.">
<style>
  :root { --bg:#fbfaf7; --panel:#fff; --ink:#24231f; --muted:#6d6a61; --line:#e2ded4; --accent:#1d6f5c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1b1d1f; --panel:#232629; --ink:#e6e4de; --muted:#a09c93; --line:#34383b; --accent:#63c9a8; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:44rem; margin:0 auto; padding:3rem 1.25rem 4rem; }
  h1 { font-size:1.8rem; margin:0 0 .4rem; letter-spacing:-.02em; }
  p.lede { color:var(--muted); margin:0 0 1.5rem; }
  table { border-collapse:collapse; width:100%; font-size:.92rem; }
  th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line); }
  th { font-size:.76rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  a { color:var(--accent); }
  code, .mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .swatch { display:inline-block; width:.8rem; height:.8rem; border-radius:3px; border:1px solid rgba(0,0,0,.2); vertical-align:-1px; }
  ul { padding-left:1.1rem; }
  li { margin:.25rem 0; }
  footer { margin-top:2.5rem; padding-top:1.2rem; border-top:1px solid var(--line); color:var(--muted); font-size:.88rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>MapLibre styles</h1>
  <p class="lede">
    Complete MapLibre GL styles for the Protomaps Basemap tiles served from
    <code>https://tiles.jasontally.com/basemap.pmtiles</code>. No API key, no rate
    limit, no service level guarantee.
  </p>

  <h2>Use one</h2>
<pre class="mono" style="background:#f3f1ea;border:1px solid #e2ded4;border-radius:8px;padding:1rem;overflow-x:auto;font-size:.82rem">new maplibregl.Map({
  container: "map",
  style: "https://tiles.jasontally.com/styles/light.json"
});</pre>
  <p>
    Register the PMTiles protocol first. The
    <a href="/">documentation page</a> has the complete example.
  </p>

  <h2>The styles</h2>
  <table>
    <thead><tr><th>File</th><th>Flavour</th><th>Size</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p>
    Also here: <a href="index.json">index.json</a> lists them for scripts, and
    <a href="builder.json">builder.json</a> carries the template and every palette
    that the style builder on the <a href="/">documentation page</a> edits.
  </p>

  <h2>Make your own</h2>
  <p>
    A flavour is only colours over one set of tiles, so there is nothing here that
    cannot be changed. Set any colour, switch layers off, and copy the resulting
    style from the builder. The style you get back is a normal MapLibre style, so
    you can host it yourself.
  </p>

  <footer>
    Tiles derived from
    <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors.
  </footer>
</div>
</body>
</html>
`;
}

function main() {
  mkdirSync(OUT, { recursive: true });

  const index = {
    tiles: TILES_URL,
    schema: SCHEMA,
    // Which style the page opens with. Stated here rather than in the page, so
    // changing it is one edit and the page cannot disagree with the build.
    // Bright is the one to lead with: it reads clearly on a screen and is the
    // least opinionated of the three.
    defaultFlavor: "bright",
    flavors: Object.entries(FLAVORS).map(([id, p]) => ({
      id,
      label: p.name,
      swatch: p.swatch,
      url: `styles/${id}.json`,
      style: `/styles/${id}.json`,
    })),
  };
  if (!FLAVORS[index.defaultFlavor]) {
    throw new Error(`defaultFlavor ${index.defaultFlavor} is not one of the flavours`);
  }
  writeFileSync(join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  for (const flavor of Object.keys(FLAVORS)) {
    const style = buildStyle(flavor);
    const text = `${JSON.stringify(style, null, 2)}\n`;
    writeFileSync(join(OUT, `${flavor}.json`), text);
    console.log(`  ${flavor}.json  ${Buffer.byteLength(text).toLocaleString()} bytes, ${style.layers.length} layers`);
  }
  writeFileSync(join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`  index.json  ${Object.keys(FLAVORS).length} flavors`);

  // The builder payload. One template, because the styles are structurally
  // identical and only the colours differ, plus every palette so the page can
  // switch flavour without another request.
  // The flavour id is a placeholder too, so the builder labels a custom style
  // with whatever the page is showing rather than a fixed word.
  const template = buildStyle("{{flavor}}", placeholderPalette());
  const builder = {
    tiles: TILES_URL,
    note:
      "template plus palettes. The page fills {{key}} placeholders with colours and " +
      "{{show:id}} with visible or none, so what it shows is exactly what you copy.",
    template,
    palettes: FLAVORS,
    controls: CONTROLS,
    controlKeys: CONTROL_KEYS,
    toggles: TOGGLE_GROUPS.map(({ id, label }) => ({ id, label })),
  };
  const builderText = `${JSON.stringify(builder, null, 2)}\n`;
  writeFileSync(join(OUT, "builder.json"), builderText);

  // The page imports this module directly, so the builder fills placeholders with
  // the same code the build used to prove the template matches the styles.
  copyFileSync(join(ROOT, "web", "render-template.mjs"), join(OUT, "render-template.mjs"));

  // /styles/ as a browsable page. Generated rather than hand written, so it
  // cannot list a style that was renamed or removed. Workers Static Assets serve
  // it: the Snippet only matches paths containing ".pmtiles", so nothing here
  // reaches it.
  writeFileSync(join(OUT, "index.html"), stylesIndexPage(FLAVORS));
  console.log("  index.html  the /styles/ listing");
  console.log(
    `  builder.json  ${Buffer.byteLength(builderText).toLocaleString()} bytes, ` +
      `${CONTROL_KEYS.length} colours, ${TOGGLE_GROUPS.length} toggles`
  );
  console.log(`\nwrote ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { TILES_URL, OUT };