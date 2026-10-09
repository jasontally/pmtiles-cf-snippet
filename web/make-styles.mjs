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

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The renderer is shared with the browser, so the page and the build agree.
export { renderTemplate, hasUnfilled, packEdits, unpackEdits } from "./render-template.mjs";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./render-template.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || join(ROOT, "public", "styles");

// The one place the archive is named.
const TILES_URL = "https://tiles.jasontally.com/basemap.pmtiles";
const SOURCE_NAME = "protomaps";
const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';

// Labels need glyphs, and a style has to name a host to get them from.
//
// It used to name demotiles.maplibre.org, which is MapLibre's demo tile server. It
// was the slowest thing on the page, it is a demo host used as a production
// dependency, and an outage there takes down every map that uses these tiles.
//
// So the glyphs are served from here, like everything else, at the same path the
// demo host uses. That is deliberate: a developer who has demotiles.maplibre.org
// in a style can replace the hostname and nothing else, and have it work. The
// path is /font/ and not /fonts/ for exactly that reason.
//
// Vendored by tools/fetch-assets.mjs. Noto Sans is SIL Open Font License 1.1, and
// the licence travels with the files at /font/OFL.txt.
export const GLYPHS = "https://tiles.jasontally.com/font/{fontstack}/{range}.pbf";

// Sprites, for anyone who wants icons: townspots, highway shields, points of
// place. These styles draw none, so MapLibre fetches no sprite and this costs
// nothing at request time. Derived from MIT licensed tangrams/icons, licence at
// /sprites/LICENSE.md.
export const SPRITES = "https://tiles.jasontally.com/sprites/v4";

const POI_ICONS = {
  aerodrome: "aerodrome", airport: "aerodrome", airfield: "aerodrome",
  animal: "animal", zoo: "zoo", artwork: "artwork", art: "artwork",
  attraction: "attraction", bar: "bar", cafe: "cafe", fast_food: "fast_food",
  restaurant: "restaurant", bench: "bench", beach: "beach", beauty: "beauty",
  books: "books", library: "library", bookmaker: "books",
  building: "building", bus_stop: "bus_stop", clothes: "clothes",
  convenience: "convenience", drinking_water: "drinking_water",
  electronics: "electronics", forest: "forest", garden: "garden",
  // No harbour and no port icon in the sheets, so both draw the marina. A POI with
  // the wrong icon is present on the map; a POI with no icon and no label is absent
  // from it.
  marina: "marina", harbour: "marina", port: "marina", ferry_terminal: "ferry_terminal",
  museum: "museum", park: "park", national_park: "park", peak: "peak",
  post_office: "post_office", school: "school", stadium: "stadium",
  supermarket: "supermarket", theatre: "theatre", toilets: "toilets",
  train_station: "train_station", station: "train_station", railway_station: "train_station",
  university: "university", college: "university",
};

/**
 * The icons the sheets carry, read from the sheets themselves.
 *
 * This was a hand-written list and it had drifted: it named `harbour` and `port`,
 * which the sprite does not have. Both were asked for by the poi icon layer, which
 * meant a 404 on the icon and no label at all for those features, because a symbol
 * layer with an icon it cannot fetch suppresses the text with it. The only honest
 * source for what the sprite has is the sprite.
 */
export function spriteIcons(sheets = ["light", "dark"]) {
  const names = new Set();
  for (const sheet of sheets) {
    const path = join(ROOT, "assets", "sprites", "v4", `${sheet}.json`);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    for (const name of Object.keys(doc)) names.add(name);
  }
  return [...names];
}

/**
 * Every icon name a style asks for that the sprite does not have.
 *
 * A missing icon is the quietest failure in the style: the request 404s, the
 * symbol layer drops the text label with it, and the feature is absent from the
 * map rather than mislabelled on it. Nothing in the page reports it and nothing in
 * the network log stands out, so it has to be caught here, against the real sheets.
 */
export function missingIcons(style, sheets = ["light", "dark"]) {
  const available = new Set(spriteIcons(sheets));
  const missing = new Set();
  for (const layer of style.layers || []) {
    const value = layer.layout && layer.layout["icon-image"];
    if (value === undefined) continue;
    const names = typeof value === "string"
      ? [value]
      : Array.isArray(value) && value[0] === "match"
        // a match alternates label, value, label, value, and ends in a fallback
        ? value.filter((_, i) => i > 1 && i % 2 === 1).concat(value[value.length - 1])
        : [];
    for (const name of names) {
      if (typeof name !== "string" || name === "") continue;
      if (!available.has(name)) missing.add(`${layer.id}: ${name}`);
    }
  }
  return [...missing];
}

// Noto Sans Medium is what upstream Protomaps uses for bold, and it is the only
// bold-ish stack in the OFL set we vendor. "Noto Sans Bold" does not exist there,
// which is the other half of why the glyphs had to come from the demo host.
export const FONT = ["Noto Sans Regular"];
export const FONT_BOLD = ["Noto Sans Medium"];

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

/**
 * [id, the `kind` value, first zoom, line width] for each road class.
 *
 * `kind`, not `kind_detail`. This was wrong for most of this project's life. The
 * fine-grained class names from the upstream documentation — motorway, trunk,
 * primary, residential — are `kind_detail` values, and the map was filtering
 * `kind` against them. So the public map drew paths and railways, which share
 * their `kind` name with the filter, and drew no motorway, no primary road, no
 * residential street and no service road at all.
 *
 * `roads.kind` is the coarse class and it is one of five values: highway,
 * major_road, minor_road, path, rail.
 *
 * Nothing caught this. Every layer loaded, every request succeeded, and the map
 * looked like a map. The only way to see it is to ask the map what it drew, which
 * is what tools/check-style.mjs does and what every offline check failed to.
 */
const ROADS = [
  ["road-highway", ["highway"], 3, 2.2],
  ["road-major", ["major_road"], 4, 1.7],
  ["road-minor", ["minor_road"], 7, 0.8],
  ["road-path", ["path"], 12, 0.35],
  ["road-rail", ["rail"], 11, 0.5],
];

/**
 * A road class narrowed by its fine-grained `kind_detail`.
 *
 * The two are different vocabularies on the same feature, so a class is "this kind,
 * and not that detail". A service road is kind_detail=service inside kind=minor_road.
 */
const roadFilter = (kinds, detailNot) =>
  ["all", ["match", ["get", "kind"], kinds, true, false],
    ["!=", ["get", "kind_detail"], detailNot]];

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
/**
 * The `places` kinds this archive carries: country, region, locality, macrohood,
 * neighbourhood. One id and its label layer for each.
 *
 * `settlement` was in this list and is gone. It is not one of the five kinds, so
 * the layer it built drew nothing, in 2208 sampled tiles and nothing in a browser
 * from z1 to z15. A layer for a kind the data does not have is dead code that
 * looks load bearing.
 */
const PLACE_LAYER_IDS = [
  "country", "region", "locality", "macrohood", "neighbourhood",
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
  // Names of things. A map with shapes and no names is a background.
  { id: "waterNames", label: "Water names", layers: ["water-label-ocean", "water-label-lake", "water-label-river"] },
  { id: "roadLabels", label: "Road names", layers: ["road-label-major", "road-label-mid", "road-label-local"] },
  // Icons. The styles drew none at all until now, and the sheets were published and
  // never referenced, which is the sprite version of the fonts problem.
  { id: "icons", label: "Icons", layers: ["poi-icon", "townspot"] },
];

/**
 * Layers that stay in the style but get no toggle.
 *
 * Both of these need a field the archive being served does not carry, and both
 * drew nothing in 2208 sampled tiles and nothing in a browser at z1 through z15.
 * A toggle for a layer that cannot draw is worse than no toggle: it looks broken
 * and there is no way for a visitor to tell it from a real fault, which is the
 * same problem the zoom badges exist to solve.
 *
 * They stay in the style, filtered on ["has", field], so they start drawing on
 * their own the day a refresh brings the field in. No release, no second edit.
 */
export const TOGGLE_EXCLUSIONS = ["place-settlement", "road-shield", "address-label"];

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

/**
 * The lowest zoom at which any layer in a toggle group is drawn.
 *
 * A group with nothing below it is on screen everywhere, so 0. The page uses this
 * to say why crossing a layer out changed nothing: Buildings are not drawn below
 * z12, so at z5 the toggle is correct and the map is correct and the screen looks
 * like the control is broken. Saying so is the whole fix.
 */
export function groupMinzoom(template, groupId) {
  const zooms = template.layers
    .filter((layer) => layer.visibility === `{{show:${groupId}}}`)
    .map((layer) => layer.minzoom ?? 0);
  return zooms.length ? Math.min(...zooms) : 0;
}

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
  const PLACE_KINDS = ["country", "region", "locality", "macrohood", "neighbourhood"];

  for (const [kind, minzoom, size, halo] of [
    ["country", 0, 13, 1.4],
    ["region", 4, 10, 1.2],
    ["locality", 5, 11, 1.3],
    ["macrohood", 11, 10, 1.2],
    ["neighbourhood", 13, 10, 1.2],
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

  // Only the kinds with no icon. poi-icon carries the rest, so a point of place is
  // labelled once and not twice.
  const NAMED_ONLY_KINDS = POI_KINDS.filter((kind) => !(kind in POI_ICONS));

  layers.push({
    id: "poi",
    type: "symbol",
    source: SOURCE_NAME,
    "source-layer": "pois",
    minzoom: 11,
    filter: ["all", inKind(NAMED_ONLY_KINDS), shownAt(12)],
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


  // ---- names of water ----
  //
  // The map drew water and named none of it. Every ocean, lake and river was an
  // unnamed shape, which is the most obvious thing a basemap does and this was not.
  //
  // Split by zoom rather than by kind, because the name worth showing at each zoom
  // is a different feature: an ocean name belongs at the bottom of the range, a
  // lake appears once you are zoomed in, and a river is only a label once there is
  // room.
  for (const [id, kinds, minzoom, size] of [
    ["water-label-ocean", ["ocean"], 0, 12.5],
    ["water-label-lake", ["lake", "reservoir", "playa", "bay", "strait", "sea"], 6, 11],
    ["water-label-river", ["river", "stream", "canal"], 9, 10],
  ]) {
    const isRiver = id === "water-label-river";
    layers.push({
      id,
      type: "symbol",
      source: SOURCE_NAME,
      "source-layer": "water",
      filter: inKind(kinds),
      minzoom,
      layout: {
        "text-field": NAME,
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], minzoom, size * 0.7, minzoom + 3, size],
        // A river name follows the river. Everything else is read flat.
        "text-rotation-alignment": isRiver ? "map" : "viewport",
        "symbol-placement": isRiver ? "line" : "point",
        "text-offset": [0, isRiver ? 0.9 : 0],
        "text-anchor": "top",
        "text-max-width": 8,
        "text-letter-spacing": id === "water-label-ocean" ? 0.14 : 0,
      },
      paint: { "text-color": p.label, "text-halo-color": p.halo, "text-halo-width": 1.1 },
    });
  }

  // ---- names of roads ----
  //
  // Three layers rather than one, because road names have to reappear as you zoom
  // in: a motorway from z11, a mid road from z13 and a street only at z15, and one
  // layer has one minzoom. Filtered on `kind`, the coarse class, not on the
  // kind_detail names, for the reason set out on ROADS.
  for (const [id, kinds, minzoom, size] of [
    ["road-label-major", ["highway", "major_road"], 11, 10.5],
    ["road-label-mid", ["minor_road"], 13, 10],
    ["road-label-local", ["minor_road"], 15, 9.5],
  ]) {
    layers.push({
      id,
      type: "symbol",
      source: SOURCE_NAME,
      "source-layer": "roads",
      filter: ["all", inKind(kinds), shownAt(minzoom)],
      minzoom,
      layout: {
        "text-field": NAME,
        "text-font": FONT,
        "text-size": size,
        "symbol-placement": "line",
        "symbol-spacing": 250,
        "text-rotation-alignment": "map",
        "text-max-width": 6,
        "text-padding": 1,
      },
      paint: { "text-color": p.label, "text-halo-color": p.halo, "text-halo-width": 1.1 },
    });
  }

  // ---- icons on points of place, and a townspot ----
  //
  // An icon with the name under it. Only the kinds with an icon reach this layer,
  // so a label is never drawn twice: the poi layer below carries the ones without.
  //
  // POI_ICONS flattened into the alternating label and value pairs a `match`
  // expression takes. Spelling it any other way gives an expression MapLibre
  // refuses, which takes the whole style down and leaves a blank map with nothing
  // on the page to say why.
  const ICON_KINDS = Object.keys(POI_ICONS).filter((kind) => POI_KINDS.includes(kind));
  layers.push({
    id: "poi-icon",
    type: "symbol",
    source: SOURCE_NAME,
    "source-layer": "pois",
    filter: ["all", inKind(ICON_KINDS), shownAt(13)],
    minzoom: 13,
    layout: {
      "icon-image": ["match", ["get", "kind"], ...Object.entries(POI_ICONS).flat(), ""],
      "text-field": NAME,
      "text-font": FONT,
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 9.5, 16, 11],
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-max-width": 8,
      "icon-allow-overlap": false,
    },
    paint: { "text-color": p.poiLabel, "text-halo-color": p.halo, "text-halo-width": 1.1 },
  });

  // A dot where people are, which survives a crowded map and makes an unfamiliar
  // area readable at a glance.
  layers.push({
    id: "townspot",
    type: "symbol",
    source: SOURCE_NAME,
    "source-layer": "places",
      // `kind_detail`, not `kind`. The places layer puts the size in kind_detail —
      // town, village, hamlet, suburb, quarter — while kind is one of country, region,
      // locality, macrohood, neighbourhood. The first version filtered `kind` against
      // the size names and drew nothing, the same mistake the road filters made.
      filter: ["all",
        ["match", ["get", "kind_detail"],
          ["town", "village", "hamlet", "suburb", "quarter"], true, false],
        [">", ["coalesce", ["get", "population"], 0], 0]],
    minzoom: 8,
    layout: {
      "icon-image": "townspot",
      "text-field": NAME,
      "text-font": FONT,
      "text-size": 11,
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-max-width": 8,
    },
    paint: { "text-color": p.label, "text-halo-color": p.halo, "text-halo-width": 1.1 },
  });

  // ---- route shields ----
  //
  // Waits for roads.shield_text, which the archive being served does not carry. It
  // has shield_text_length, which is how many characters the number is and not what
  // they are, so a shield drawn from that would be a blank shape on every motorway.
  //
  // `has` is what makes waiting safe. `["get", "shield_text"]` on an absent property
  // is null, and null compares equal to a disheartening number of things, so the
  // usual filter would match everything. `has` is true only when the property is
  // genuinely there, so this draws nothing today and draws itself the moment the
  // archive is refreshed.
  layers.push({
    id: "road-shield",
    type: "symbol",
    source: SOURCE_NAME,
    "source-layer": "roads",
    filter: ["all", ["has", "shield_text"], inKind(["highway", "major_road"])],
    minzoom: 7,
    layout: {
      // Which of the five shield blanks to use, by how long the number is. The
      // blanks are different widths, and the wrong one puts a four digit number in
      // a two digit shape.
      "icon-image": ["match", ["length", ["coalesce", ["get", "shield_text"], ""]],
        1, "generic_shield-1char",
        2, "generic_shield-2char",
        3, "generic_shield-3char",
        4, "generic_shield-4char",
        "generic_shield-5char"],
      "text-field": ["get", "shield_text"],
      "text-font": FONT_BOLD,
      "text-size": 9,
      "text-allow-overlap": true,
      "icon-allow-overlap": true,
      "text-rotation-alignment": "map",
    },
    paint: {
      "text-color": p.label,
      "text-halo-color": p.halo,
      "text-halo-width": 1.1,
    },
  });

  // ---- house numbers ----
  //
  // Waits for buildings.addr_housenumber. Not a separate source layer: Protomaps
  // puts address points inside buildings with kind=address, so there is no second
  // thing to fetch. Same `has` test, same reasoning.
  layers.push({
    id: "address-label",
    type: "symbol",
    source: SOURCE_NAME,
    "source-layer": "buildings",
    // minzoom 15, not 18. The archive stops at z15, and a layer whose minzoom is
    // above the tile's zoom is never drawn at all, so this would have stayed dark
    // even after the field arrived, and the failure would have looked exactly like
    // the data missing when it was not.
    filter: ["all", ["has", "addr_housenumber"], ["==", ["get", "kind"], "address"]],
    minzoom: 15,
    layout: {
      "text-field": ["get", "addr_housenumber"],
      "text-font": FONT,
      "text-size": 9,
      "text-allow-overlap": true,
      "text-anchor": "center",
    },
    paint: { "text-color": p.label, "text-halo-color": p.halo, "text-halo-width": 1 },
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
    // Icons. Absent for most of this project's life, while the sheets were published
    // and nothing referenced them. Naming one has MapLibre fetch the sheet and its
    // JSON, which only pays off now that icon layers use it.
    sprite: `${SPRITES}/${p.sprite || "light"}`,
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
    // Which sprite sheet. Not a colour, so the page never shows it as an input, but
    // it travels with the palette so that template + palette == shipped style stays
    // true for the sprite as well as for the colours.
    sprite: "light",
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
    sprite: "light",
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
    sprite: "dark",
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

/**
 * Every placeholder left in a rendered style. An empty array is the answer we want.
 *
 * An earlier version of this shipped all three styles with `{{show:roads}}` sitting
 * in their visibility, because buildStyle writes that and the shipped files were
 * written straight from buildStyle. Nothing caught it. MapLibre fell back to the
 * default for an unrecognised visibility and the map looked fine, so the only way it
 * could ever have been found was somebody reading the JSON they had copied.
 */
export function renderProblems(style) {
  const found = new Set();
  for (const match of JSON.stringify(style).matchAll(/\{\{([a-zA-Z0-9:_-]+)\}\}/g)) {
    found.add(match[1]);
  }
  return [...found];
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
    // Published on the same host, at the paths a style expects. On the page so a
    // developer can see them without reading this file.
    // Everything a map needs beyond the tiles, and where each one is. Rendered into
    // the page rather than written out there, so the page cannot disagree with the
    // build about a URL.
    assets: {
      glyphs: GLYPHS,
      sprite: SPRITES,
      fonts: ["Noto Sans Regular", "Noto Sans Medium"],
      sprites: ["light", "dark", "grayscale", "black", "white"],
      // The libraries, published here as well as on jsDelivr. The page itself loads
      // them from jsDelivr because that measured faster; these are here so a
      // developer can serve a whole map from one hostname.
      libraries: [
        { name: "MapLibre GL JS", version: "5.24.0", path: "/vendor/maplibre-gl.js", licence: "BSD-3-Clause" },
        { name: "MapLibre GL CSS", version: "5.24.0", path: "/vendor/maplibre-gl.css", licence: "BSD-3-Clause" },
        { name: "PMTiles JS", version: "3.2.1", path: "/vendor/pmtiles.js", licence: "BSD-3-Clause" },
      ],
      // Each licence travels with the files it covers. All four allow
      // redistribution.
      licences: {
        fonts: { label: "SIL OFL 1.1", path: "/font/OFL.txt" },
        sprites: { label: "MIT", path: "/sprites/LICENSE.md" },
        libraries: { label: "BSD-3-Clause", path: "/vendor/maplibre-gl-LICENSE.txt" },
      },
    },
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

  // Checked once before any style is written: a name missing from the sprite is
  // the same in every flavour and there is nothing to gain from failing three times.
  const probe = renderTemplate(buildStyle("{{flavor}}", placeholderPalette()), FLAVORS.light, {});
  const iconsMissing = missingIcons(probe);
  if (iconsMissing.length) {
    throw new Error(
      `the style asks the sprite for ${iconsMissing.join(", ")}, which the sheets do not ` +
      `have. A missing icon suppresses the label with it, so the feature would be ` +
      `absent from the map rather than mislabelled on it.`
    );
  }

  for (const flavor of Object.keys(FLAVORS)) {
    const style = buildStyle(flavor);
    // Rendered before it is written, so a shipped style has no placeholder in it.
    // The page's builder and this file use the same renderer, so the style a
    // developer copies is the style the map draws.
    const rendered = renderTemplate(style, FLAVORS[flavor], {});
    const problems = renderProblems(rendered);
    if (problems.length) {
      throw new Error(`${flavor}.json would ship with ${problems.join(", ")} in it`);
    }
    for (const layer of rendered.layers) {
      if (layer.visibility && !["visible", "none"].includes(layer.visibility)) {
        throw new Error(`${flavor}.json layer ${layer.id} has visibility ${layer.visibility}`);
      }
    }
    const text = `${JSON.stringify(rendered, null, 2)}\n`;
    writeFileSync(join(OUT, `${flavor}.json`), text);
    console.log(`  ${flavor}.json  ${Buffer.byteLength(text).toLocaleString()} bytes, ${style.layers.length} layers`);
  }
  writeFileSync(join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`  index.json  ${Object.keys(FLAVORS).length} flavors, assets on ${new URL(GLYPHS).host}`);

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
    toggles: TOGGLE_GROUPS.map(({ id, label, needs }) => ({
      id,
      label,
      minzoom: groupMinzoom(template, id),
      // Carried through so the page can say a layer is waiting on a field rather
      // than looking like a toggle that does nothing.
      ...(needs ? { needs } : {}),
    })),
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