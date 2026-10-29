/**
 * Render the help page in every language.
 *
 * The English page at web/index.html is the source. Translatable fragments are
 * found by walking the elements below, and each is keyed by a digest of its own
 * English text, not by a hand-written id and not by its position. That means:
 *
 *   - the source stays free of i18n attributes;
 *   - inserting a paragraph shifts nothing;
 *   - changing an English string changes its key, so the old translation is
 *     left behind and the build fails until it is translated again. Loud, not
 *     silently misaligned.
 *
 * Code is never touched: `pre`, `code`, `script` and `style` are outside the
 * walk, and a validator compares the code blocks of every page with the English
 * page byte for byte.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const SOURCE = join(ROOT, "web", "index.html");
export const SITE = "https://tiles.jasontally.com";

/** Elements whose inner HTML is prose. `pre` and `code` are deliberately absent. */
const ELEMENT =
  /<(h1|h2|h3|p|li|td|th|button|figcaption|dt|dd|label)\b([^>]*)>([\s\S]*?)<\/\1>/g;

/** Attributes that carry text a reader can see or a screen reader can read. */
const ATTRIBUTE = /\b(aria-label|title|alt|placeholder)="([^"]*)"/g;

export const languages = JSON.parse(readFileSync(join(HERE, "languages.json"), "utf8"));
export const runtimeSource = JSON.parse(readFileSync(join(HERE, "runtime.json"), "utf8"));

export function normalize(html) {
  return html.replace(/\s+/g, " ").trim();
}

export function keyFor(kind, value) {
  return createHash("sha1").update(`${kind}\n${normalize(value)}`).digest("hex").slice(0, 12);
}

function escapeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Every translatable string in the English page.
 *
 * Fragments are the inner HTML of prose elements, so inline `<a>`, `<code>` and
 * `<strong>` travel with the sentence and the translator can move them where
 * the target grammar needs them. `data-i18n-skip` marks a subtree that must keep
 * its English (the quoted error messages).
 */
export function extract(html) {
  const fragments = {};
  const attributes = {};

  html.replace(ELEMENT, (match, tag, attrs, inner) => {
    if (/\bdata-i18n-skip\b/.test(attrs)) return match;
    const text = normalize(inner);
    if (!text) return match;
    fragments[keyFor("f", inner)] = text;
    return match;
  });

  html.replace(ATTRIBUTE, (match, name, value) => {
    if (!value || !/[A-Za-z]/.test(value)) return match;
    attributes[keyFor("a", value)] = value;
    return match;
  });

  return { fragments, attributes, ui: uiFrom(runtimeSource), labels: { ...runtimeSource.labels } };
}

function uiFrom(runtime) {
  const { labels, ...ui } = runtime;
  return ui;
}

/** Replace fragments and attributes that are present in the catalogue. */
export function translate(html, catalogue) {
  let out = html.replace(ELEMENT, (match, tag, attrs, inner) => {
    if (/\bdata-i18n-skip\b/.test(attrs)) return match;
    const translated = catalogue.fragments?.[keyFor("f", inner)];
    return translated ? `<${tag}${attrs}>${translated}</${tag}>` : match;
  });
  out = out.replace(ATTRIBUTE, (match, name, value) => {
    const translated = catalogue.attributes?.[keyFor("a", value)];
    return translated ? `${name}="${escapeAttr(translated)}"` : match;
  });
  return out;
}

/** The language menu. Plain links, no JavaScript required. */
export function menuHtml(lang, catalogue) {
  const items = languages
    .map((entry) => {
      const current = entry.code === lang.code;
      const mark = current ? ' aria-current="true"' : "";
      return (
        `<li><a href="${entry.path}" hreflang="${entry.code}" lang="${entry.code}"${mark}>` +
        `${escapeText(entry.name)}</a></li>`
      );
    })
    .join("\n      ");
  return `<details class="lang">
  <summary aria-label="${escapeAttr(catalogue.ui["ui.language"] ?? "Language")}"><span>${escapeText(lang.name)}</span></summary>
  <ul>
      ${items}
  </ul>
</details>`;
}

function alternates(lang) {
  const lines = languages.map(
    (entry) =>
      `    <link rel="alternate" hreflang="${entry.code}" href="${SITE}${entry.path}">`
  );
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${SITE}/en/">`);
  return lines.join("\n");
}

function headFor(lang, catalogue) {
  const url = `${SITE}${lang.path}`;
  return [
    `    <link rel="canonical" href="${url}">`,
    alternates(lang),
    `    <meta property="og:url" content="${url}">`,
  ].join("\n");
}

/** One page, in one language. */
export function renderPage(html, lang, catalogue) {
  let out = translate(html, catalogue);
  const dir = lang.dir === "rtl" ? ' dir="rtl"' : "";
  out = out.replace(/<html lang="en">/, `<html lang="${lang.code}"${dir}>`);
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(catalogue.ui["meta.title"])}</title>`);
  out = out.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escapeAttr(catalogue.ui["meta.description"])}">`
  );
  out = out.replace("</head>", `${headFor(lang, catalogue)}\n</head>`);
  out = out.replace("<!-- i18n:menu -->", menuHtml(lang, catalogue));

  // Runtime strings for the inline script. `<` is escaped so a translation can
  // never close the script tag.
  const payload = JSON.stringify({ ui: catalogue.ui, labels: catalogue.labels }).replace(/</g, "\\u003c");
  out = out.replace("<!-- i18n:runtime -->", `<script>window.__I18N__ = ${payload};</script>`);
  return out;
}

/**
 * The root chooser. It is only seen when the gateway snippet is not running.
 * It repeats the gateway logic in the browser, from the stored choice and the
 * browser languages, so a visitor still lands on their language.
 */
export function chooserHtml(catalogue = { ui: uiFrom(runtimeSource) }) {
  const list = languages
    .map((entry) => `<li><a href="${entry.path}" hreflang="${entry.code}" lang="${entry.code}">${escapeText(entry.name)}</a></li>`)
    .join("\n      ");
  const table = JSON.stringify(languages.map(({ code, path }) => [code, path]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Language</title>
<style>
  body { margin: 0; padding: 3rem 1.25rem; font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; color: #24231f; background: #fbfaf7; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 1rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .35rem 1.5rem; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); }
  a { color: #1d6f5c; }
</style>
</head>
<body>
<main>
  <h1>Language</h1>
  <ul>
      ${list}
  </ul>
</main>
<script>
(function () {
  var LANGS = ${table};
  var stored = null;
  try { stored = localStorage.getItem("tiles.lang"); } catch (e) {}
  var want = [stored].concat(navigator.languages || [navigator.language || ""]);
  for (var i = 0; i < want.length; i++) {
    var tag = String(want[i] || "").toLowerCase();
    if (!tag) continue;
    var base = tag.split("-")[0];
    var match = LANGS.find(function (l) { return l[0].toLowerCase() === tag; })
      || LANGS.find(function (l) { return l[0].toLowerCase() === base; });
    if (tag.indexOf("zh") === 0) {
      match = /hant|hk|tw|mo/.test(tag)
        ? LANGS.find(function (l) { return l[0] === "zh-Hant"; })
        : LANGS.find(function (l) { return l[0] === "zh-Hans"; });
    }
    if (match) {
      location.replace(match[1]);
      return;
    }
  }
})();
</script>
</body>
</html>
`;
}

/** The sitemap for the language set. */
export function sitemapXml() {
  const entries = languages
    .map((lang) => {
      const links = languages
        .map(
          (other) =>
            `    <xhtml:link rel="alternate" hreflang="${other.code}" href="${SITE}${other.path}"/>`
        )
        .join("\n");
      return `  <url>
    <loc>${SITE}${lang.path}</loc>
${links}
  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries}
  <url>
    <loc>${SITE}/styles/</loc>
  </url>
</urlset>
`;
}

/** The shape of an HTML fragment, with the text removed. */
export function shape(html) {
  const tags = [];
  html.replace(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>/gi, (match, name, attrs) => {
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? "";
    tags.push(`${name.toLowerCase()}|${href}`);
    return match;
  });
  const code = [];
  html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/g, (match, inner) => {
    code.push(normalize(inner));
    return match;
  });
  return { tags, code };
}

export function preBlocks(html) {
  const blocks = [];
  html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, (block) => {
    blocks.push(block);
    return block;
  });
  return blocks;
}

/** Every problem with one language file, as strings. Empty means usable. */
export function problems(code) {
  const out = [];
  const en = JSON.parse(readFileSync(join(HERE, "en.json"), "utf8"));
  const path = join(HERE, `${code.toLowerCase()}.json`);
  if (!existsSync(path)) return [`${code}: no catalogue`];
  let cat;
  try {
    cat = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [`${code}: ${error.message}`];
  }
  for (const section of ["fragments", "attributes", "ui", "labels"]) {
    const want = Object.keys(en[section] ?? {});
    const got = Object.keys(cat[section] ?? {});
    const missing = want.filter((key) => !got.includes(key));
    const extra = got.filter((key) => !want.includes(key));
    if (missing.length) out.push(`${section}: missing ${missing.length} (${missing.slice(0, 3).join(", ")})`);
    if (extra.length) out.push(`${section}: ${extra.length} unknown key(s)`);
  }
  for (const [key, english] of Object.entries(en.fragments)) {
    const translated = cat.fragments?.[key];
    if (typeof translated !== "string") continue;
    const a = shape(english);
    const b = shape(translated);
    if (a.tags.slice().sort().join(",") !== b.tags.slice().sort().join(",")) {
      out.push(`fragment ${key}: tags differ`);
    }
    if (a.code.slice().sort().join("\u0000") !== b.code.slice().sort().join("\u0000")) {
      out.push(`fragment ${key}: code text changed`);
    }
    if (/\bon\w+=|<script/i.test(translated)) out.push(`fragment ${key}: unsafe markup`);
  }
  return out;
}

/** Write en.json from the page. */
export function writeSource() {
  const html = readFileSync(SOURCE, "utf8");
  const extracted = extract(html);
  writeFileSync(join(HERE, "en.json"), `${JSON.stringify(extracted, null, 2)}\n`);
  return extracted;
}

/** Build every page plus the chooser and the sitemap into `outDir`. */
export function buildAll(outDir) {
  const html = readFileSync(SOURCE, "utf8");
  const en = JSON.parse(readFileSync(join(HERE, "en.json"), "utf8"));
  const missing = languages.map((l) => l.code).filter((code) => problems(code).length);
  if (missing.length) {
    throw new Error(`catalogues need work: ${missing.join(", ")}`);
  }
  for (const lang of languages) {
    const catalogue = lang.code === "en"
      ? en
      : JSON.parse(readFileSync(join(HERE, `${lang.code.toLowerCase()}.json`), "utf8"));
    const dir = join(outDir, lang.path.replace(/^\/|\/$/g, ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), renderPage(html, lang, catalogue));
  }
  writeFileSync(join(outDir, "index.html"), chooserHtml(en));
  writeFileSync(join(outDir, "sitemap.xml"), sitemapXml());
}

const invoked = process.argv[1] && process.argv[1].endsWith("render.mjs");
if (invoked) {
  const mode = process.argv[2];
  if (mode === "extract") {
    const extracted = writeSource();
    console.log(`en.json: ${Object.keys(extracted.fragments).length} fragments, ` +
      `${Object.keys(extracted.attributes).length} attributes`);
  } else if (mode === "check") {
    let bad = 0;
    for (const lang of languages) {
      const list = problems(lang.code);
      if (list.length) {
        bad++;
        console.log(`${lang.code}:`);
        for (const line of list.slice(0, 6)) console.log(`  ${line}`);
      }
    }
    console.log(bad ? `${bad} language(s) need work` : `${languages.length} languages complete`);
    process.exit(bad ? 1 : 0);
  } else if (mode === "build") {
    const out = process.argv[3] || join(ROOT, "public");
    buildAll(out);
    console.log(`wrote ${languages.length} pages, the chooser and the sitemap to ${out}`);
  } else {
    console.log("usage: node web/i18n/render.mjs extract|check|build [outDir]");
  }
}
