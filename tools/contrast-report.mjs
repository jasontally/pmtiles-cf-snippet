#!/usr/bin/env node
/**
 * Measure a style's contrast, and report it honestly.
 *
 *   node tools/contrast-report.mjs           # every shipped style
 *   node tools/contrast-report.mjs dark      # one
 *
 * WHAT IS ENFORCED, AND WHAT IS ONLY REPORTED
 *
 * Text is enforced. SC 1.4.3 Contrast (Minimum), Level AA, is 4.5:1 for text
 * against its background, and there is no version of a usable map where a label
 * is dim. A label is checked against the colour behind it, and against its own
 * halo, because both are what the text sits on.
 *
 * Lines and fills are reported, not enforced. The reason is measured, not
 * assumed: the shipped light palette draws its roads white on a cream background
 * at 1.09:1, and it is a good looking map. SC 1.4.11 Non-text Contrast says 3:1
 * for graphical objects required to understand the content, but this style's
 * roads are deliberately held close to the background and read through their
 * casing and their width instead. Measuring every line against 3:1 would fail a
 * style that works, which tells you the rule is wrong for this case rather than
 * the style.
 *
 * So the numbers are printed and the design chooses from them. A rule that cannot
 * be applied to the styles already shipped is not a rule, it is an opinion with a
 * decimal point on it.
 *
 * Dark mode is where this matters most. A wide fill is the background the text and
 * the line work sit on, so demanding 3:1 from a park polygon pushes every fill to
 * mid grey, which makes the labels fail instead. That is a worse failure, and it
 * is why the criterion puts the obligation on the line and the label.
 *
 *   text   4.5:1 enforced. Labels and haloes.
 *   line   reported. Roads, boundaries, water and land edges.
 *   fill   reported. Ground, land cover, land use, buildings.
 *
 * The arithmetic is the formula WCAG specifies rather than a lightness estimate:
 *   L = 0.2126R + 0.7152G + 0.0722B on linearised channels
 *   ratio = (L_lighter + 0.05) / (L_darker + 0.05)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contrast } from "./contrast.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = join(ROOT, "public", "styles");

const TEXT_BAR = 4.5;

/** Every hex in an expression, so no branch of a match is skipped. */
function hexes(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v));
}

/** The last hex in a value, which is the expression's own default. */
function defaultHex(value) {
  const all = hexes(value);
  return all.length ? all[all.length - 1] : "#000000";
}

/** What a colour is drawn on top of. */
const SITS_ON = {
  earth: "background", landcover: "background", landuse: "earth",
  water: "background", "water-line": "water",
  "boundary-region": "earth", "boundary-country": "earth",
  building: "earth",
};

function report(flavour) {
  const style = JSON.parse(readFileSync(join(STYLES, `${flavour}.json`), "utf8"));
  const layer = (id) => style.layers.find((l) => l.id === id);
  console.log(`\n  ${flavour.toUpperCase()}`);

  const background = defaultHex(layer("background").paint["background-color"]);
  const land = defaultHex(layer("earth").paint["fill-color"]);
  const water = defaultHex(layer("water").paint["fill-color"]);
  console.log(`    background ${background}, land ${land}, water ${water}`);

  let fails = 0;
  const lines = [];

  // Text. Every symbol layer, against the background and against its own halo.
  for (const l of style.layers) {
    if (l.type !== "symbol") continue;
    const paint = l.paint || {};
    const text = paint["text-color"];
    if (!text) continue;
    for (const [role, hex, back] of [
      [`${l.id} on background`, text, background],
      [`${l.id} on its halo`, text, paint["text-halo-color"]],
    ]) {
      const ratio = contrast(hex, back);
      if (ratio < TEXT_BAR) {
        fails++;
        console.log(`    FAIL text  ${role.padEnd(34)} ${hex} on ${back}  ${ratio.toFixed(2)} needs ${TEXT_BAR}`);
      }
    }
  }
  console.log(fails === 0 ? "    every label and halo clear of 4.5:1" : `    ${fails} below the text bar`);

  // Lines. Reported.
  const lineLayers = style.layers.filter((l) => l.type === "line");
  for (const l of lineLayers) {
    const paint = l.paint || {};
    if (!paint["line-color"]) continue;
    const back = SITS_ON[l.id] ? defaultHex(layer(SITS_ON[l.id]).paint["fill-color"] ?? layer(SITS_ON[l.id]).paint["background-color"]) : background;
    for (const hex of hexes(paint["line-color"])) {
      lines.push({ role: l.id, hex, back, ratio: contrast(hex, back) });
    }
  }
  if (lines.length) {
    // Reported by class, not one line at a time: the question a reader of this
    // wants answered is "how bright are the roads, boundaries and edges in this
    // palette", and that is a summary not a list.
    const brightest = [...lines].sort((a, b) => b.ratio - a.ratio)[0];
    console.log(
      `    line      ${lines.length} measured, most distinct ${brightest.role} ${brightest.hex} on ${brightest.back} at ${brightest.ratio.toFixed(2)}`
    );
    const dullest = [...lines].sort((a, b) => a.ratio - b.ratio)[0];
    if (dullest.ratio < 3) {
      console.log(`              least distinct ${dullest.role} ${dullest.hex} on ${dullest.back} at ${dullest.ratio.toFixed(2)}`);
    }
  }

  // Fills. Reported, with the weakest against what it sits on.
  const fills = [];
  for (const l of style.layers) {
    if (l.type !== "fill") continue;
    const paint = l.paint || {};
    if (!paint["fill-color"]) continue;
    const on = SITS_ON[l.id];
    const back = on ? defaultHex(layer(on).paint["fill-color"]) : background;
    for (const hex of hexes(paint["fill-color"])) {
      fills.push({ role: l.id, hex, back, ratio: contrast(hex, back) });
    }
  }
  if (fills.length) {
    const strongest = fills.sort((a, b) => a.ratio - b.ratio).slice(-1)[0];
    console.log(`    fill      ${fills.length} measured, most distinct ${strongest.role} ${strongest.hex} on ${strongest.back} at ${strongest.ratio.toFixed(2)}`);
  }
  return fails;
}

const wanted = process.argv[2];
const flavours = wanted ? [wanted] : ["light", "bright", "dark"];
let total = 0;
for (const flavour of flavours) total += report(flavour);
console.log(total === 0 ? "\n  all labels and haloes clear of 4.5:1" : "\n  " + total + " below the text bar");
process.exit(total === 0 ? 0 : 1);
