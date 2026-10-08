#!/usr/bin/env node
/**
 * Fetch the fonts and sprites once, into assets/, so the build never depends on
 * somebody else's uptime.
 *
 *   node tools/fetch-assets.mjs            download anything missing or changed
 *   node tools/fetch-assets.mjs --check    report what is missing, fetch nothing
 *
 * WHY THESE ARE VENDORED RATHER THAN LINKED
 *
 * The styles have to name a host for glyphs. Pointing that at somebody else's
 * server makes every map that uses these tiles depend on that server being up,
 * which is exactly the coupling this project exists to remove. The tile archive
 * is ours to serve, so the fonts and sprites should be too.
 *
 * WHAT IS FETCHED, AND WHY THESE TWO
 *
 * Protomaps ships the fontstacks its styles actually use in
 * github.com/protomaps/basemaps-assets, licensed SIL Open Font License 1.1:
 *
 *   Noto Sans Regular   256 ranges, 6.24 MB
 *   Noto Sans Medium    256 ranges, 3.61 MB
 *   Noto Sans Italic    256 ranges, 1.22 MB   not used by these styles
 *
 * Noto Sans Medium is what upstream uses for bold. These styles used to ask for
 * "Noto Sans Bold", which does not exist in that set, so every label fetched a
 * glyph range from demotiles.maplibre.org instead: MapLibre's demo tile server.
 * That is the wrong dependency for anything other than a demo, and it is the
 * slowest thing on the page.
 *
 * All 256 ranges are vendored, not just the Latin ones. Protomaps labels
 * features with their local name, so panning to Tokyo or Cairo asks for ranges
 * in the tens of thousands. Trimming the set to what an English-language map
 * looks like would turn those labels into 404s, which is a silent failure in a
 * map: the name is simply not drawn.
 *
 * SPRITES
 *
 * The v4 sheets for all five upstream flavours, 20 files and 127 KB. These
 * styles draw no icons, so MapLibre fetches no sprite at all and this costs
 * nothing at runtime. It is here so that a developer who wants townspots,
 * highway shields or point of place icons can point `sprite` at this host
 * instead of shipping a third one.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");

const SOURCE = "https://protomaps.github.io/basemaps-assets";

/** The fontstacks these styles ask for. Both under the OFL. */
const FONTSTACKS = ["Noto Sans Regular", "Noto Sans Medium"];

/** MapLibre asks for 256 codepoints at a time, so a fontstack is 256 files. */
const RANGES = 256;

/** v4 sheets, for every upstream flavour. */
const SPRITES = ["light", "dark", "grayscale", "black", "white"];
const SPRITE_SUFFIXES = ["", "@2x"];
const SPRITE_EXTS = ["json", "png"];

/**
 * Licences, copied next to the assets they cover. Redistribution is allowed by
 * both, and both require the licence to travel with the files.
 */
const LICENCES = [
  {
    // raw.githubusercontent, not the pages site: the licence is in the repo but is
    // not published under fonts/ on the site.
    from: "https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/OFL.txt",
    to: "assets/fonts/OFL.txt",
    note: "SIL Open Font License 1.1, covers the fonts",
  },
  {
    from: "https://raw.githubusercontent.com/tangrams/icons/master/LICENSE.md",
    to: "assets/sprites/LICENSE.md",
    note: "MIT, covers the icons the sprites are built from",
  },
];

const checkOnly = process.argv.includes("--check");

/** Every file this script is responsible for, as repo-relative paths. */
function wanted() {
  const files = [];
  for (const stack of FONTSTACKS) {
    // A real space in the directory name, not %20. A request arrives as
    // /font/Noto%20Sans%20Regular/0-255.pbf and every HTTP server decodes the
    // path before it looks for a file, so a directory called "Noto%20Sans%20..."
    // would never match. Checked against the live host after the first deploy,
    // because it is the kind of thing that is easy to get backwards.
    const dir = join("fonts", stack);
    for (let i = 0; i < RANGES; i++) {
      const start = i * 256;
      files.push(`${dir}/${start}-${start + 255}.pbf`);
    }
  }
  for (const flavor of SPRITES) {
    for (const suffix of SPRITE_SUFFIXES) {
      for (const ext of SPRITE_EXTS) {
        files.push(`sprites/v4/${flavor}${suffix}.${ext}`);
      }
    }
  }
  // The licences are not under the assets path upstream, so they are counted and
  // fetched separately rather than folded in here. Adding one to this list would
  // build a URL under fonts/ that does not exist.
  return files;
}

/**
 * How a vendored file must match its source.
 *
 * Size alone would let a truncated download through, so a digest goes in one
 * manifest for the whole tree. One file, not one per asset: a sidecar for each of
 * 532 assets is 4 MB of digests and 532 extra files to carry around, for the same
 * guarantee. A build that has the files but no manifest is not verified, and that
 * is reported rather than assumed.
 */
const MANIFEST = "assets/MANIFEST.sha256";

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The digests recorded so far, or an empty map. */
function readManifest() {
  const path = join(ROOT, MANIFEST);
  if (!existsSync(path)) return new Map();
  const out = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([0-9a-f]{64})\s+(.*)$/.exec(line.trim());
    if (match) out.set(match[2], match[1]);
  }
  return out;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const files = wanted();
  const missing = [];
  const unverifiable = [];
  const corrupted = [];
  const known = readManifest();

  for (const relative of files) {
    const path = join(ASSETS, relative);
    if (!existsSync(path)) {
      missing.push(relative);
      continue;
    }
    // Not just presence. A truncated or half-written file is the failure that
    // matters, and it is invisible to a size check.
    const recorded = known.get(relative);
    if (recorded === undefined) unverifiable.push(relative);
    else if (recorded !== digestOf(path)) corrupted.push(relative);
  }

  const licenceMissing = LICENCES.filter((l) => !existsSync(join(ROOT, l.to)));
  console.log(`  ${files.length + LICENCES.length} files`);
  if (missing.length) console.log(`  ${missing.length} missing`);
  if (licenceMissing.length) console.log(`  ${licenceMissing.length} licence(s) missing`);
  if (corrupted.length) {
    console.log(`  ${corrupted.length} do not match their digest:`);
    for (const name of corrupted.slice(0, 5)) console.log(`    ${name}`);
    if (corrupted.length > 5) console.log(`    ...and ${corrupted.length - 5} more`);
  }
  if (unverifiable.length) {
    console.log(`  ${unverifiable.length} present with no digest, so not verified:`);
    for (const name of unverifiable.slice(0, 5)) console.log(`    ${name}`);
  }

  if (checkOnly) {
    const bad = missing.length + licenceMissing.length + unverifiable.length + corrupted.length;
    console.log(bad ? "  NOT complete" : "  complete");
    process.exit(bad ? 1 : 0);
  }

  // A digest mismatch means the file on disk is not what was fetched, so the only
  // honest thing is to take it again rather than trust either copy.
  if (corrupted.length) {
    // Taken away and put back in the missing list, so the fetch loop below is the
    // single path that writes a file. Repaired in place would leave the stale
    // digest in the manifest and the next --check would fail on a good file.
    for (const relative of corrupted) rmSync(join(ASSETS, relative));
    missing.push(...corrupted);
  }

  let fetched = 0;
  for (const relative of missing) {
    const url = `${SOURCE}/${relative}`;
    const bytes = await fetchText(url);
    const path = join(ASSETS, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    known.set(relative, digestOf(path));
    fetched++;
    if (fetched % 64 === 0) console.log(`    ${fetched} fetched`);
  }

  for (const licence of LICENCES) {
    if (existsSync(join(ROOT, licence.to))) continue;
    const bytes = await fetchText(licence.from);
    const path = join(ROOT, licence.to);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    console.log(`  licence  ${licence.to}  ${licence.note}`);
    fetched++;
  }

  // Digests for files that exist but are not in the manifest yet. Cheap, and it
  // means the next run has something to compare against.
  for (const relative of unverifiable) {
    known.set(relative, digestOf(join(ASSETS, relative)));
  }

  // Only files that are actually there. A digest for a deleted asset would keep
  // the manifest claiming to cover it, and the next run would report a missing
  // file that no longer exists in wanted() at all.
  const manifestLines = [...known.entries()]
    .filter(([relative]) => existsSync(join(ASSETS, relative)))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([relative, digest]) => `${digest}  ${relative}`);
  if (manifestLines.length) {
    writeFileSync(join(ROOT, MANIFEST), `${manifestLines.join("\n")}\n`);
    console.log(`  manifest ${MANIFEST}, ${manifestLines.length} entries`);
  }

  const bytes = files.reduce((sum, relative) => {
    const path = join(ASSETS, relative);
    return sum + (existsSync(path) ? readFileSync(path).length : 0);
  }, 0);
  const have = files.filter((relative) => existsSync(join(ASSETS, relative))).length;
  // Recounted, not reused: licenceMissing was true before the licences were
  // fetched, so trusting it here would report 0 every run.
  const licences = LICENCES.filter((l) => existsSync(join(ROOT, l.to))).length;
  console.log(`  ${have}/${files.length} assets and ${licences}/${LICENCES.length} licences, ` +
    `${(bytes / 1e6).toFixed(2)} MB`);
}

main().catch((error) => {
  console.error(`fetch-assets failed: ${error.message}`);
  process.exit(1);
});