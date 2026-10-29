/**
 * Validate the rendered pages. Run: node web/i18n/validate.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { languages } from "./render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PUBLIC = join(ROOT, "public");

const english = readFileSync(join(PUBLIC, "en", "index.html"), "utf8");
const englishPres = english.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/g) || [];
const leak = ["shard", "snippet", "wrangler", "Static Assets", "Worker"];

let failed = 0;
function fail(name) { failed++; console.error(`FAIL  ${name}`); }

for (const lang of languages) {
  const path = join(PUBLIC, lang.path.replace(/^\/|\/$/g, ""), "index.html");
  let html;
  try { html = readFileSync(path, "utf8"); }
  catch (e) { fail(`${lang.code}: missing page`); continue; }

  if (!new RegExp(`<html lang="${lang.code}"`).test(html)) fail(`${lang.code}: lang attribute`);
  if (lang.dir === "rtl" && !/dir="rtl"/.test(html)) fail(`${lang.code}: missing dir=rtl`);
  if (!html.includes(`rel="canonical" href="${SITE_URL(lang.path)}"`)) fail(`${lang.code}: canonical`);
  if (!html.includes('hreflang="x-default"')) fail(`${lang.code}: x-default`);
  for (const other of languages) {
    if (!html.includes(`hreflang="${other.code}"`)) fail(`${lang.code}: missing hreflang ${other.code}`);
  }
  if (/data-i18n(?:-attr)?="/.test(html)) fail(`${lang.code}: untranslated marker left`);
  if (/styles\/index\.json/.test(html) && /(?<!\/)styles\/index\.json/.test(html)) fail(`${lang.code}: relative style url`);
  if (html.includes('src="styles/') || html.includes('href="styles/')) fail(`${lang.code}: relative asset url`);
  for (const word of leak) {
    if (html.includes(word)) fail(`${lang.code}: leaked "${word}"`);
  }
  const pres = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/g) || [];
  if (pres.length !== englishPres.length) fail(`${lang.code}: pre block count ${pres.length} vs ${englishPres.length}`);
  for (let i = 0; i < pres.length; i++) {
    if (pres[i] !== englishPres[i]) fail(`${lang.code}: pre block ${i} differs`);
  }
  const links = (html.match(/\.lang li a/g) || []).length;
  if (links === 0) fail(`${lang.code}: no language menu links`);
}

// chooser
const chooser = readFileSync(join(PUBLIC, "index.html"), "utf8");
if (!chooser.includes('name="robots" content="noindex"')) fail("chooser: missing noindex");
if (!chooser.includes('hreflang=')) {} // chooser is intentionally a utility page

// sitemap
const sitemap = readFileSync(join(PUBLIC, "sitemap.xml"), "utf8");
for (const lang of languages) {
  if (!sitemap.includes(`${SITE_URL(lang.path)}`)) fail(`sitemap: missing ${lang.code}`);
}
if (/<loc>https:\/\/tiles\.jasontally\.com\/<\/loc>/.test(sitemap)) fail("sitemap: the gateway is listed");

console.log(failed ? `${failed} problem(s)` : "all pages valid");
process.exit(failed ? 1 : 0);

function SITE_URL(path) { return "https://tiles.jasontally.com" + path; }
