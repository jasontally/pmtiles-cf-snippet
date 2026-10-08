# Where the fonts, the sprites and the libraries are served from

Everything a map needs beyond the tiles: the glyph ranges that draw text, the
sprite sheets that draw icons, and the two libraries that do the drawing. All of it
is published on `tiles.jasontally.com`, and two of the three also exist somewhere
else that is faster. This file is the record of which is which and why, so the
decision is not a matter of memory.

Re-measure with:

```sh
node tools/bench-assets.mjs --runs 15
```

It reads. It deploys nothing and changes nothing.

## What is published here, and where

| What | URL on this host | Licence |
|---|---|---|
| Glyph ranges | `/font/{fontstack}/{range}.pbf` | SIL OFL 1.1, at `/font/OFL.txt` |
| Sprite sheets | `/sprites/v4/{flavour}` | MIT, at `/sprites/LICENSE.md` |
| MapLibre GL 5.24.0 | `/vendor/maplibre-gl.js`, `/vendor/maplibre-gl.css` | BSD-3-Clause, at `/vendor/maplibre-gl-LICENSE.txt` |
| PMTiles 3.2.1 | `/vendor/pmtiles.js` | BSD-3-Clause, at `/vendor/pmtiles-LICENSE.txt` |

All four licences permit redistribution. All four are published next to the files
they cover, because that is what each of them asks for.

The glyph path is `/font/` and singular, matching `demotiles.maplibre.org` on
purpose. A developer who has that host in a style can replace the hostname and
nothing else and have it work. Making it `/fonts/` for tidiness would have broken
the one thing worth having.

## What the page actually loads, and why

| | Page loads from | Reason |
|---|---|---|
| Tiles | here | It is the whole point |
| Glyph ranges | here | The two measured the same, and this host caches them for a year against upstream's ten minutes |
| Sprite sheets | here | The same, and these styles draw no icons so nothing is fetched unless you add an icon layer |
| MapLibre GL, PMTiles | jsDelivr | jsDelivr measured 1.15x to 1.67x faster on a warm request |

So the copies of the libraries exist and are documented, and the page does not use
them. That is not an oversight: it is what the measurement said, and the
measurement is one command away.

## The measurement

15 requests to each host, warm median of runs 2 to 15, from one machine on one
network. Two rules, both deliberate:

* A gap under 15% is not a result. That is inside the variation of one network at
  one moment, and reporting it as a finding would be dressing noise as evidence.
* The middle halves of the two sets of samples must not overlap. If they do, one
  unlucky request moved the median and averaging has not fixed it.

Measured on 2026-10-08, from Miami, over Cloudflare and Fastly edges:

| Asset | This host | jsDelivr / upstream | Verdict |
|---|---|---|---|
| MapLibre GL JS | 76–83 ms | 52–53 ms | CDN faster |
| MapLibre GL CSS | 37–40 ms | 33–34 ms | CDN faster, small |
| PMTiles JS | 36–48 ms | 29–34 ms | CDN faster, small |
| Glyph, Noto Sans Regular | 37–47 ms | 32–36 ms | too close to call |
| Glyph, Noto Sans Medium | 36–40 ms | 40–43 ms | too close to call |
| Sprite, light.json | 30–36 ms | 25–27 ms | too close to call |

Run three times over about an hour and the libraries stayed faster on the CDN and
the fonts stayed a wash. The cache policy told the rest: this host serves the fonts
`max-age=31536000, immutable` and upstream serves them `max-age=600`, so a returning
browser asks neither host and a returning reader on a long-lived cache gets this one.

### What this measurement is not

It is one machine, one network, one city, one hour. A reader in another country
meets a different edge for each host, and the ranking can flip. Nothing here is a
general result and it is not written as one.

The honest summary is that the gap on the libraries is a few tens of milliseconds
once per browser per year, because both hosts send `immutable` for a year and a
returning visitor fetches neither. Against that, a page that loads two libraries
from a third-party CDN tells that CDN the address of every visitor. If that trade
is the wrong way round, the copies are already published and the change is three
URLs.

## Two things that were wrong and are now right

**The styles asked for `Noto Sans Bold`, which does not exist.** Protomaps publishes
`Noto Sans Regular`, `Noto Sans Medium` and `Noto Sans Italic` under the OFL, and
uses Medium for bold. `Noto Sans Bold` exists only on `demotiles.maplibre.org`,
which is why the styles were pointed there at all. So every label was a request to
MapLibre's demo tile server. The styles now use Medium, like upstream, and the
glyphs come from here.

**All 256 ranges are published, not just the Latin ones.** Protomaps labels features
with their local name, so panning to Tokyo or Cairo asks for ranges in the tens of
thousands. Publishing only the ranges an English-language map uses would leave those
labels missing, with no error anywhere to say why. It costs 6.2 MB and 3.6 MB for
Regular and Medium, which is a trade worth making for a failure that is invisible.

## Where the files come from

`tools/fetch-assets.mjs` fetches them once into `assets/` and records a SHA-256 for
each in `assets/MANIFEST.sha256`. The build copies that tree into `public/`. Nothing
is downloaded at build time, so a Cloudflare build does not depend on GitHub Pages
being up, and the same bytes are deployed every time.

```sh
node tools/fetch-assets.mjs            # fetch anything missing, verify the rest
node tools/fetch-assets.mjs --check    # verify digests, fetch nothing
```

`--check` compares content, not presence. A truncated or half written file is the
failure that matters and it is invisible to a size check, so a mismatch is reported
and the file is re-fetched rather than trusted.

## Sizes

| | Files | Size |
|---|---|---|
| Glyph ranges, 2 stacks × 256 | 512 | 9.85 MB |
| Sprite sheets, 5 flavours at 1x and 2x | 20 | 127 KB |
| MapLibre GL JS and CSS | 2 | 1.09 MB |
| PMTiles JS | 1 | 50 KB |
| Licences | 4 | 12 KB |
| **Published total** | **539** | **11.18 MB** |

Against the limits that matter: 539 files is 0.5% of the 100,000 a Worker holds,
and 11 MB is nothing next to the 20 GB of disk a build container gets. The first
deploy uploaded 540 files in 3.5 seconds.

## One wrinkle worth knowing

`/sprites/v4/light@2x.png` answers `307`, redirecting to `light%402x.png`. The `@`
is percent encoded on the way out. It works, at the cost of one extra round trip,
and MapLibre asks for the `@2x` sheet on a high-DPI display. There is no way to
avoid it from this side: MapLibre builds that URL itself from the `sprite` base, so
the file has to carry the `@`. It only affects sprites, which these styles never
fetch.