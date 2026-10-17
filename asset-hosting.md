# Where the fonts, the sprites and the libraries are served from

Everything a map needs beyond the tiles: the glyph ranges that draw text, the
sprite sheets that draw icons, and the two libraries that do the drawing. All of it
is published on `tiles.jasontally.com`. Two of the three are also served faster from
somewhere else. This file is the record of which is which, so the decision is not a
matter of memory.

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
| MapLibre GL 5.24.0 | `/vendor/maplibre-gl.js`, `/vendor/maplibre-gl.js.br`, `/vendor/maplibre-gl.css` | BSD-3-Clause, at `/vendor/maplibre-gl-LICENSE.txt` |
| PMTiles 3.2.1 | `/vendor/pmtiles.js` | BSD-3-Clause, at `/vendor/pmtiles-LICENSE.txt` |

All four licences permit redistribution, and all four are published next to the
files they cover because that is what each of them asks for.

The glyph path is `/font/` and singular, matching `demotiles.maplibre.org` on
purpose. A developer who has that host in a style can replace the hostname and
nothing else and have it work. Making it `/fonts/` for tidiness would have broken
the one thing worth having.

## What the page actually loads, and why

| | Page loads from | Reason |
|---|---|---|
| Tiles | here | It is the whole point |
| Glyph ranges | here | One hostname, and this host caches them for a year against upstream's ten minutes |
| Sprite sheets | here | Same, and these styles draw no icons so nothing is fetched unless you add an icon layer |
| MapLibre GL JS | here | 224,810 bytes against the CDN's 276,601. The 50 KB is 0.26 s at 1.6 Mbit/s, where the CDN's advantage is 35 ms |
| MapLibre GL CSS, PMTiles | jsDelivr | 1.3 KB and 2.2 KB of compression against a round trip of about 35 ms, so the CDN |

The CSS and the PMTiles library are here as well as on jsDelivr, and the page takes
the CDN's. A developer who wants a map from one hostname, or who does not want to
tell a CDN the address of every visitor, can have that, and saying "ours is slower"
is only believable if ours exists. MapLibre GL JS is the exception and the numbers
above are why: what is slower by 35 ms is also 50 KB heavier, and 50 KB is seven
times the 35 ms.

## The measurement, and how it nearly went wrong

Two versions of this measurement disagreed completely. One said this host was 1.5x
slower than a CDN; the next, on the same bytes, said this host was 2.3x *faster*.
Nothing had changed in between, so at least one of them was broken.

Both were. The first fetched the two hosts at the same instant with `Promise.all`,
so there were always two requests in flight and which socket the kernel handed back
decided the number. The second fetched them one after the other but timed the whole
transfer, which adds the reader's own bandwidth to a comparison about the host.

What is there now does three things:

* **Interleaved, one request at a time**, alternating which host goes first, so
  neither always gets the first slot and the warmer connection.
* **One reused connection, first three samples discarded**, so neither TLS nor a
  cold edge cache is in the numbers.
* **Time to first byte and body transfer reported separately.** They mean different
  things. First byte is edge lookup and origin behaviour, which is the host. The
  transfer is the reader's connection, and it came out the same for both hosts every
  time, so including it only added noise. The verdict is on the first byte.

A difference is only acted on when it clears 15% and this host's fastest quarter of
samples is still slower than the CDN's slowest quarter. Both rules are there because
the first version produced a finding out of noise.

### What it says

Measured 2026-10-08 from Miami, 15 interleaved requests per host, time to first
byte, run four times:

| Asset | This host | CDN | Gap |
|---|---|---|---|
| MapLibre GL JS | 64–87 ms | 27–33 ms | CDN 2.2 to 2.8x faster |
| MapLibre GL CSS | 37–45 ms | 26–32 ms | CDN 1.3 to 1.5x faster |
| PMTiles JS | 36–41 ms | 27–32 ms | CDN 1.3 to 1.4x faster |
| Glyph, Noto Sans Regular | 32–40 ms | 22–27 ms | CDN 1.4 to 1.6x faster |
| Glyph, Noto Sans Medium | 33–39 ms | 21–30 ms | CDN 1.4 to 1.7x faster |
| Sprite, light.json | 32–40 ms | 21–26 ms | CDN 1.4 to 1.6x faster |
| Sprite, light.png | 34–40 ms | 21–28 ms | CDN 1.5 to 1.7x faster |

**The CDN is faster on every one of them**, by 10 to 45 ms of first byte. The
transfer time afterwards is the same on both hosts. So this is one property of the
host, applied uniformly, not something about any particular file.

The glyphs and the sprites are served from here anyway, and that is a decision
rather than a measurement. Two reasons: a map that comes from one hostname does not
break when somebody else's is down, and a glyph server that is down is a map with
no labels. It also costs one hostname on the critical path, which is the thing the
whole project is about. If that trade is the wrong way round, pointing `glyphs` at
`protomaps.github.io` is a one-line change in `web/make-styles.mjs` and the fonts
are already there.

### The half of it the first byte does not decide

First byte is not the whole cost. The bytes after it are, on the profile this
project measures against: 1.6 Mbit/s, one second per 200 KB. So the size of the body
decides anything over about 2 KB, and the CDN cannot win that, because it compresses
per request at one fixed level while a build can compress once at the best one. The
question is not which host is faster but what each one puts on the wire.

Measured 2026-10-16, one `curl -H 'Accept-Encoding: br'` per URL:

| Asset | This host | jsDelivr | Brotli at its best | Verdict |
|---|---|---|---|---|
| MapLibre GL JS | 274,643 | 276,601 | 224,810 | here, 50 KB is 0.26 s |
| MapLibre GL CSS | 9,472 | 9,452 | 8,167 | jsDelivr, 1.3 KB is 6 ms |
| PMTiles JS | 13,312 | 13,272 | 11,087 | jsDelivr, 2.2 KB is 11 ms |

The column that matters is the last: 50 KB against 35 ms of first byte is a clear
win, and 1.3 KB against 35 ms is a clear loss. So the library moved and the other
two did not. This host's own compression is gzip-class everywhere: it sends the
style JSON as 3,410 bytes where brotli at its best writes 2,638, and there is no way
to ask it for more.

A pre-compressed body is the only way past that level, and it has to be declared, or
the browser runs the compressed bytes. `build.mjs` writes
`public/vendor/maplibre-gl.js.br`, and `public/_headers` says what it is:

```
/vendor/maplibre-gl.js.br
	Content-Type: text/javascript
	Content-Encoding: br
```

Both lines are load-bearing. Without the first the response is
`application/octet-stream` and a browser refuses to run it as a script; without the
second the whole file is a syntax error. A deploy can therefore make the map
disappear, which is why the page keeps a fallback to the CDN copy, and why
`web/make-styles.test.mjs` unpacks the file the build wrote and compares it with the
vendored library, and recomputes the digest the tag carries. The digest is of the
body the browser ends up with, so it is the same digest the CDN copy has.

One thing local tools cannot check. `wrangler dev` answers the request with its own
gzip on top of the declared encoding, so a browser receives a gzip stream full of
brotli, fails the digest and falls back to the CDN. The asset worker has no
compression code of its own, so that gzip is the dev proxy rather than the platform,
and the deployed host is what has to be checked:

```sh
curl -sI -H 'Accept-Encoding: br' https://tiles.jasontally.com/vendor/maplibre-gl.js.br
```

`Content-Encoding: br` and 224,810 bytes is the answer that means the deploy worked.
Anything else means the platform compressed a body that was already compressed, and
the page is on the CDN copy until the file is renamed and deployed again.

The uncompressed `/vendor/maplibre-gl.js` stays published: the tools and the tests
read it, and a developer who would rather not deal with an encoding can fetch it.

### What this measurement is not

One machine, one network, one city, one afternoon. A reader in another country meets
a different edge for each host and the ranking can flip. Nothing here is a general
result and it is not written as one.

Also worth being clear about the size of the prize. Both hosts send
`max-age=31536000, immutable` for the libraries, so a returning browser fetches
neither and the difference is a one-off of 10 to 45 ms on a first visit, against a
1.06 MB download that takes far longer than that on either host. Upstream serves
the fonts `max-age=600`, so a browser coming back after ten minutes revalidates
them; this host does not.

## Three things that were wrong and are now right

**The styles asked for `Noto Sans Bold`, which does not exist.** Protomaps publishes
`Noto Sans Regular`, `Noto Sans Medium` and `Noto Sans Italic` under the OFL, and
uses Medium for bold. `Noto Sans Bold` exists only on `demotiles.maplibre.org`,
which is why the styles were pointed there at all, so every label was a request to
MapLibre's demo tile server. The glyphs now come from here.

**The second font stack cost half a second.** Medium is what upstream Protomaps uses
for bold, and what these styles named until 2026-10-16. A second stack is a second
glyph range on the first view, and MapLibre asks for both as soon as there is a label
to draw: 76 KB for Regular and 78 KB for Medium, measured on the critical path of a
670 KB first view, which is 0.4 s at 1.6 Mbit/s. The layers that were set in Medium
keep what else separated them: the country name is uppercase, the place labels are at
the top of the size range, and the shield numbers sit inside their shield. Medium is
still published here for anyone who wants the weight. No style names it, and naming
it again is one word in `web/make-styles.mjs`.

**All 256 ranges are published, not just the Latin ones.** Protomaps labels features
with their local name, so panning to Tokyo or Cairo asks for ranges in the tens of
thousands. Publishing only what an English-language map uses would leave those
labels missing, with no error anywhere to say why. It costs 6.2 MB and 3.6 MB for
Regular and Medium, which is worth paying for a failure that is invisible.

## Where the files come from

`tools/fetch-assets.mjs` fetches them once into `assets/` and records a SHA-256 for
each in `assets/MANIFEST.sha256`. The build copies that tree into `public/`.
Nothing is downloaded at build time, so a Cloudflare build does not depend on GitHub
Pages being up, and the same bytes are deployed every time.

```sh
node tools/fetch-assets.mjs            # fetch anything missing, verify the rest
node tools/fetch-assets.mjs --check    # verify digests, fetch nothing
```

`--check` compares content, not presence. A truncated or half-written file is the
failure that matters and it is invisible to a size check, so a mismatch is reported
and the file is taken again rather than trusted.

## Sizes

| | Files | Size |
|---|---|---|
| Glyph ranges, 2 stacks × 256 | 512 | 9.85 MB |
| Sprite sheets, 5 flavours at 1x and 2x | 20 | 127 KB |
| MapLibre GL JS and CSS | 2 | 1.09 MB |
| MapLibre GL JS, brotli, written by the build | 1 | 220 KB |
| PMTiles JS | 1 | 50 KB |
| Licences | 4 | 12 KB |
| **Published total** | **540** | **11.40 MB** |

Against the limits that matter: 540 files is half a percent of the 100,000 a Worker
holds, and 11.4 MB is nothing next to the 20 GB of disk a build container gets. The
first deploy of these uploaded 540 files in 3.5 seconds.

## One wrinkle worth knowing

`/sprites/v4/light@2x.png` answers `307`, redirecting to `light%402x.png`. The `@`
is percent-encoded on the way out. It works, at the cost of one extra round trip,
and MapLibre asks for the `@2x` sheet on a high-DPI display. There is no way to
avoid it from this side: MapLibre builds that URL itself from the `sprite` base, so
the file has to carry the `@`. It only affects sprites, which these styles never
fetch.