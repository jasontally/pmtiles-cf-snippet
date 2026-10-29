# Translating the help page

Read `en.json` in this directory and write one JSON file per language with the
same four sections and exactly the same keys: `fragments`, `attributes`, `ui`,
`labels`.

Translate the **values only**. Never change a key.

## The page

It is the help page for a free map tile service. Readers arrive in two groups:
developers who want a drop-in basemap, and people whose OpenStreetMap map stopped
working because their app was blocked by OSM's tile servers. The tone is plain,
direct and technical. Short sentences. No marketing language, no exclamation
marks, no "simply" or "easily".

## What must survive exactly

- HTML tags, in the same order and with the same attributes: `<a href="...">`,
  `<code>`, `<strong>`, `<em>`, `<br>`, `<span class="mono">`.
- Every `href` value, unchanged. The link text is translated; the URL is not.
- The text inside `<code>...</code>`, unchanged. This includes things like
  `tile.openstreetmap.org`, `pmtiles://`, `L.tileLayer`, `{z}/{x}/{y}`, field
  names and URLs.
- Product names: Protomaps, OpenStreetMap, MapLibre, Leaflet, PMTiles, Cloudflare,
  JavaScript, Firefox, Chromium.
- Style names: Light, Bright, Dark.
- Placeholders in `ui` values: `{n}`, `{zoom}`, `{label}`, `{error}`. Keep the
  braces and the name exactly.
- Punctuation that is part of a URL or code sample.

If a value is only code, a URL, or a product name, return it unchanged.

## Never use these words

`shard`, `snippet`, `wrangler`, `Static Assets`, `Worker`. They describe how the
service is built and must not appear on the page in any language.

## Titles and descriptions

`ui.meta.title` and `ui.meta.description` are not translated word for word. Write
them as a native page title and description: the subject first, then what the page
offers. Keep the length close to the English.

## Glossary

| English | Use |
|---|---|
| tile | the map image or vector data piece; the ordinary word in the language |
| vector tiles / raster tiles | keep the distinction; do not translate as "map tiles" for both |
| PMTiles | the name, unchanged |
| archive | the single `.pmtiles` file; a normal word for a large file |
| range request | HTTP range request, the standard term |
| style | the MapLibre style (colours and layers), not "design" |
| layer | map layer |
| source | data source |
| zoom | zoom level |
| attribution | the credit line |
| tile usage policy | the OSM policy; keep it recognisable |
| block | the block that replaces the map |
| referer | the HTTP header; use the standard spelling in the language if one exists, otherwise "Referer" |
| preflight | CORS preflight |
| glyphs / sprites | keep the technical words |
| self-host | host your own copy |
| cache | cache |
| embed | embed a map in a page |

## Output

- Valid JSON, UTF-8, two-space indent.
- Same key set as `en.json`. If a key is missing the build fails.
- Write the file with the Write tool. Do not paste the JSON into your reply.
- Reply with one line: the language, the number of fragment keys, and any term you
  were unsure about. Nothing else.
