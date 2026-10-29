# The help page in other languages

Status: plan. Nothing here is implemented.

The page at `web/index.html` becomes the English source. The build renders one
static page per language into `public/<code>/index.html`. Every language has its
own URL, its own `<html lang>` and `dir`, and its own title and description. The
language menu is a list of ordinary links. There is no in-place swapping of a
loaded page: choosing a language navigates to that language's URL.

The language set is the one already used on mac.jasontally.com: thirty
translations plus English.

## 1. Languages and URLs

| code | name in the menu | dir | URL |
|---|---|---|---|
| en | English | ltr | `/en/` |
| de | Deutsch | ltr | `/de/` |
| es | Español | ltr | `/es/` |
| fr | Français | ltr | `/fr/` |
| pt | Português | ltr | `/pt/` |
| it | Italiano | ltr | `/it/` |
| nl | Nederlands | ltr | `/nl/` |
| pl | Polski | ltr | `/pl/` |
| ru | Русский | ltr | `/ru/` |
| uk | Українська | ltr | `/uk/` |
| tr | Türkçe | ltr | `/tr/` |
| zh-Hans | 中文（简体） | ltr | `/zh-hans/` |
| zh-Hant | 中文（繁體） | ltr | `/zh-hant/` |
| ja | 日本語 | ltr | `/ja/` |
| ko | 한국어 | ltr | `/ko/` |
| vi | Tiếng Việt | ltr | `/vi/` |
| id | Bahasa Indonesia | ltr | `/id/` |
| sw | Kiswahili | ltr | `/sw/` |
| ha | Hausa | ltr | `/ha/` |
| hi | हिन्दी | ltr | `/hi/` |
| bn | বাংলা | ltr | `/bn/` |
| mr | मराठी | ltr | `/mr/` |
| gu | ગુજરાતી | ltr | `/gu/` |
| pa | ਪੰਜਾਬੀ | ltr | `/pa/` |
| ta | தமிழ் | ltr | `/ta/` |
| te | తెలుగు | ltr | `/te/` |
| kn | ಕನ್ನಡ | ltr | `/kn/` |
| ml | മലയാളം | ltr | `/ml/` |
| ar | العربية | rtl | `/ar/` |
| fa | فارسی | rtl | `/fa/` |
| ur | اردو | rtl | `/ur/` |

English moves from `/` to `/en/` so that every language is one ordinary page
with the same shape. `/` becomes a gateway, described next. `x-default` points
at `/en/`.

## 2. What `/` does

`/` is not a page. It redirects, once, to a language page:

1. a `lang` cookie, if it names a supported language;
2. otherwise the best match from `Accept-Language`;
3. otherwise `/en/`.

The redirect is a `302` with `Cache-Control: private, no-store` and
`Vary: Accept-Language, Cookie`. Only the exact path `/` redirects. A link to
`/de/`, a deep link to `/de/#migrate`, and every asset URL are served directly
and never bounce.

Matching `Accept-Language` means: parse the quality values, ignore `q=0` and
`*`, try the exact tag, then the base language. `zh-TW`, `zh-HK` and `zh-MO`
map to `zh-hant`; other `zh-*` map to `zh-hans`; `pt-*` maps to `pt`. Anything
unsupported falls through to the next entry in the header, then to `/en/`.

The gateway is a second Snippet rule, so it costs one invocation per visit to
`/` and nothing else. `snippet-rules.mjs` already replaces only our own rule and
keeps every other project's rule intact; the second rule follows the same rule.
If the Snippet is ever disabled, `/` still serves a small chooser page with the
same links, and that page repeats the choice in JavaScript from `localStorage`
and `navigator.languages`, so the site never 404s at the root and still lands a
returning visitor on their language. The chooser is not in the sitemap and
carries `noindex`, because it is a utility page and not a language version.
`/` is also absent from the alternate set: it has no language of its own, and
`x-default` names `/en/`.

### Remembering a choice

The menu writes both:

- `localStorage["tiles.lang"]`, for the page itself and as the fallback if the
  gateway is unavailable;
- a `lang` cookie (`Max-Age=31536000; Path=/; SameSite=Lax; Secure`), because
  the edge cannot read `localStorage`.

The cookie is what stops a returning visitor who chose German from being sent
back to their browser language. The menu is a set of links, so it works with
JavaScript off; the click handler only records the choice before the navigation
completes.

## 3. The menu

One control, top right of the hero, the same size and weight as the picker on
mac.jasontally.com: 12 px text, 32 px tall, hairline border, no shadow. It is a
`<details>` with a `<summary>` that shows the current language's native name and
a thin chevron. The panel is a list of links, two columns at 640 px and wider,
one column below, maximum height 70 vh with its own scroll.

Each entry is `<a href="/de/" hreflang="de" lang="de">Deutsch</a>`. The current
language carries `aria-current="true"`. The order is the order in the table
above: European languages first, then Chinese and CJK, then south-east Asia, then
South Asia, then the right-to-left set. Native names are never translated.

The menu needs no JavaScript to open or to navigate. A few lines close it on
Escape and on a click outside, and move focus back to the summary. In an RTL
page the panel aligns to the inline start, which is the right edge.

## 4. What the build does

`web/index.html` stays the English source and stays readable. Translatable
elements get a key:

```html
<p data-i18n="migrate.block.intro">
  The tile servers sent that image instead of the map, on purpose, under …
</p>
```

The English text stays in the element as the fallback. A build step,
`web/i18n/render.mjs`, does five things for each language:

1. sets `lang` and `dir` on `<html>`;
2. replaces the title, description, `og:*` and canonical with that language's
   authored copy;
3. writes the `hreflang` cluster, including `x-default`;
4. replaces the inner HTML of every `[data-i18n]` element, and the attributes
   named by `[data-i18n-attr]` (title, aria-label, placeholder);
5. injects the handful of runtime strings the page's own script uses (builder
   labels, map hints, dialog buttons) as a small JSON object.

Everything else is copied unchanged. `<pre>`, `<code>`, `<script>` and `<style>`
are never parsed for translation; a test asserts the code blocks are byte
identical to the English page.

The output is `public/en/index.html` and one directory per language, plus
`public/index.html`, which is the chooser the root falls back to when the
gateway is not running. `public/sitemap.xml` is written in the same step,
because its list now changes with every language page; the committed copy is
removed.

Catalogue files are `web/i18n/<code>.json`, flat keys, HTML fragments:

```json
{
  "hero.lede": "The whole Protomaps Basemap, zoom 0 to 15, served as one PMTiles archive over plain HTTP. Point any PMTiles client at the URL and it works.",
  "migrate.block.intro": "The tile servers sent that image instead of the map, on purpose, under <a href=\"https://operations.osmfoundation.org/policies/tiles/\">the tile usage policy</a>. It is not a fault, and fixing the URL does not clear it."
}
```

Fragments may contain `<a>`, `<code>`, `<strong>`, `<em>` and `<br>`. The build
refuses `<script>`, `on*` attributes and `javascript:` URLs.

`node web/i18n/extract.mjs` writes `en.json` from the marked page, and a test
keeps the two in step, so translators always start from a file that matches the
page.

## 5. What is translated, and what is not

Translated: every heading, paragraph, list item, note, table header and text
cell, button label, dialog label, tooltip, `aria-label`, and the footer prose.
Titles and descriptions are authored per language rather than translated
literally, because a translated English title reads like one.

Not translated, in any language:

- everything inside `<pre>` and `<code>`;
- URLs, origin names, JSON, field names, `source-layer` names, `kind` and
  `kind_detail` values;
- product names: Protomaps, OpenStreetMap, MapLibre, Leaflet, PMTiles;
- the three quoted error strings and the `leafletRasterLayer` message. The text
  around them is translated; the message the reader sees in their console stays
  English;
- style names Light, Bright and Dark, which are names of files;
- the attribution line.

The existing test that refuses the words `shard`, `snippet`, `wrangler` and
`Static Assets` on the page runs over every language page.

## 6. Paths that must become absolute

The page is currently served from `/`, so several relative URLs work by
accident. From `/de/` they would resolve under `/de/` and 404:

| now | becomes |
|---|---|
| `import "./styles/render-template.mjs"` | `"/styles/render-template.mjs"` |
| `fetch("styles/index.json")` | `"/styles/index.json"` |
| `fetch("styles/builder.json")` | `"/styles/builder.json"` |
| `styles/index.json` → `url: "styles/light.json"` | `/styles/light.json` |

The share link already builds from `location.origin` and `location.pathname`, so
it stays on the page it was copied from. A build test fetches every URL the page
references as if it were on `/de/`.

## 7. Right to left

`ar`, `fa` and `ur` get `<html lang="ar" dir="rtl">`. Eight CSS rules use
physical sides and need logical ones:

- `.facts b` `margin-right` → `margin-inline-end`
- `.mapbar` `left`/`right` → `inset-inline`
- `.tools` `margin-left: auto` → `margin-inline-start: auto`
- `.maphint`, `.zoomer` `left` → `inset-inline-start`
- `.note` `border-left`/`padding-left` → inline-start
- `.builder-toggles .zmin` `margin-left` → inline-start
- `th, td` `text-align: left` → `start`

`pre`, `code`, `.mono`, `.url` and the quoted error box stay
`direction: ltr; unicode-bidi: isolate; text-align: left` in every language, or
the code reads backwards. `#map` also stays LTR, because MapLibre's controls and
attribution are positioned for a left-to-right coordinate system.

Arabic, Persian, Urdu and the nine Indic languages get `line-height: 1.75` from
a `:lang()` rule; the Latin pages stay at 1.6. No webfont is added. The page uses
the system stack, which covers these scripts on the systems the page already
targets, and a webfont per script would be several hundred kilobytes for text
that is a small part of the page.

## 8. Translation

One file per language, one subagent per language. Each gets the English
catalogue, a glossary, the rules above, and the output shape. They do not see
each other's output.

Glossary, fixed before the first run: tiles, vector tiles, raster tiles,
PMTiles, archive, range request, style, layer, source, zoom, attribution, tile
usage policy, block, referer, preflight, glyphs, sprites, basemap, self-host,
cache, embed.

Model: **Gemini 4 Argon, high** as the translator. It is the newest Gemini in
this catalogue, and the closest match to the Gemini 3.1 Pro used for the mac
translations: the job is the same shape, long structured prose with markup that
must survive. For review, a second family: **Kimi K3.1 Pro, high**, checking
meaning, terminology and length against the English, and returning a list of
problems rather than a rewrite. Qwen3.8 Max is the alternate for the Chinese,
Japanese and Korean files if the review finds tone problems.

Arabic, Persian, Urdu and the Indic languages get a native read of the hero,
the block section and the Leaflet section before release. The rest get
back-translation of those same sections, which is enough to catch a mistranslated
technical term.

Cost: about 9,000 words per language, roughly 12k output tokens. Thirty
languages at $10 per million output is about $4 a pass; two passes with the
reviewer stay under $15. Each language is one request, so wall time is a batch of
parallel subagents, not thirty sequential runs.

## 9. Tests

Build and static tests:

- one page per language; `lang` and `dir` correct; no page links to a missing one;
- canonical is self; the alternate set is identical on every page and includes
  every language plus `x-default`;
- every key in `en.json` exists in every catalogue and no catalogue has an extra
  key;
- each translated fragment has the same tag sequence, the same `href` values and
  the same `<code>` contents as the English;
- `<pre>` blocks are byte identical to English on every page;
- no relative asset URL remains;
- the sitemap lists every language page with its alternates, and does not list
  `/`;
- the chooser lists every language and carries `noindex`.

Browser tests, on `de`, `ar`, `hi` and `zh-hans` at 390 px and 1280 px: the body
does not scroll sideways, the menu opens and closes, the map draws, the console
is clean. RTL pages get a screenshot review of the hero, the migration section
and the builder.

## 10. Phases

1. Build the pipeline, the menu, the gateway and the RTL rules with English
   only. Ship `/en/` and the redirect. URLs are final from here.
2. One pilot language, German, end to end, with the review loop. This is where
   the catalogue format and the validator get tested against real prose.
3. European batch: es, fr, pt, it, nl, pl, ru, uk, tr.
4. CJK and south-east: zh-hans, zh-hant, ja, ko, vi, id, sw, ha.
5. South Asian and RTL: hi, bn, mr, gu, pa, ta, te, kn, ml, ar, fa, ur, with the
   native reads before release.

Each phase is one build of the main Worker, not a shard refresh. The archive and
the 25 shards are not touched.

## 11. Decisions to confirm

1. English at `/en/` with `/` as the gateway, rather than English at `/` and a
   gateway only for other languages. The first keeps every language link
   working without JavaScript and gives `x-default` a real page.
2. The gateway as a Snippet rule, rather than a script on `/`.
3. The menu as `<details>` with links, rather than a `<select>` that needs
   JavaScript.
4. Gemini 4 Argon as translator with Kimi K3.1 Pro as reviewer.
