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
| MapLibre GL 5.24.0 | `/vendor/maplibre-gl.js`, `/vendor/maplibre-gl.css`, and the probe `/vendor/maplibre-gl.js.br` | BSD-3-Clause, at `/vendor/maplibre-gl-LICENSE.txt` |
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
| MapLibre GL, PMTiles | jsDelivr | jsDelivr is 1.3 to 2.8 times faster on time to first byte |

The copies of the libraries exist and are documented even though the page does not
use them. A developer who wants a map from one hostname, or who does not want to
tell a CDN the address of every visitor, can have that, and saying "ours is slower"
is only believable if ours exists.

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

### A body compressed at the build, and why it is not here

First byte is not the whole cost. The bytes after it are, on the profile this
project measures against: 1.6 Mbit/s, one second per 200 KB. So the size of the body
decides anything over about 2 KB, and the CDN cannot win that, because it compresses
per request at one fixed level while a build can compress once at the best one. The
question is not which host is faster but what each one puts on the wire.

Measured 2026-10-16, one `curl -H 'Accept-Encoding: br'` per URL:

| Asset | This host | jsDelivr | Brotli at its best |
|---|---|---|---|
| MapLibre GL JS | 274,643 | 276,601 | 224,810 |
| MapLibre GL CSS | 9,472 | 9,452 | 8,167 |
| PMTiles JS | 13,312 | 13,272 | 11,087 |

That last column is why MapLibre looked like the one asset worth moving: 50 KB
against 35 ms of first byte, where the other two are 1.3 KB and 2.2 KB against the
same 35 ms, which is less than the round trip. So the library moved on 2026-10-17,
as a body brotli-compressed once at quality 11 by `build.mjs`, with `public/_headers`
declaring what it is:

```
/vendor/maplibre-gl.js.br
	Content-Type: text/javascript
	Content-Encoding: br
```

It does not work on this host, and that deploy is the measurement. The host
compresses the file it stores with its own coding and ignores the line that declares
otherwise, so every client receives one layer more than it can use:

| `Accept-Encoding` sent | Response says | Body | Usable |
|---|---|---|---|
| `gzip, deflate, br, zstd` | `Content-Encoding: br` | brotli of our brotli, 224,815 bytes | no |
| `gzip, deflate` | `Content-Encoding: gzip` | gzip of our brotli, 224,995 bytes | no |
| nothing | no encoding line | our brotli, 224,810 bytes | no |

The browser refused the script on the digest it had been given: `Failed to find a
valid digest in the 'integrity' attribute for resource
'https://tiles.jasontally.com/vendor/maplibre-gl.js.br'`. Every visitor paid 220 KiB
for a body it threw away, then a second copy from the CDN, and the map waited for
both. The page had a fallback to the CDN for this case, and the fallback is what kept
the map drawing, but a fallback that fires on every visit is a cost, not a safety net.
The library is back on jsDelivr and the fallback is gone.

Three ways past the level this host compresses at, and what each one did:

- **Declare the encoding.** Tested on the deploy of 2026-10-17, and the declaration is
  passed through while the body is compressed again anyway. This is the attempt that
  cost a deploy and is now reverted.
- **Name the compressed file as the sibling of the plain one.** A request for
  `/vendor/maplibre-gl.js` answered 274,739 bytes: this host's own brotli of the plain
  file, not the 224,810-byte copy sitting beside it. There is no sibling convention.
- **Serve it as a type the host does not compress.** Tested by the probe this build
  publishes: the same compressed file under `application/ecmascript`, which the HTML
  spec lists as JavaScript and which is not on the compressible list this host uses.
  Nothing loads it. The first command below is the test, and 224,810 bytes is the
  answer that would bring the library back to this host.

A fourth way does not exist: the browser has `DecompressionStream`, but not for
brotli, so the page cannot unpack the file itself.

Both live checks are one command, and should be run again before anyone tries this a
second time:

```sh
# what a brotli-accepting browser gets from the compressed probe
curl -s -H 'Accept-Encoding: br' -D - -o /tmp/lib.bin \
  https://tiles.jasontally.com/vendor/maplibre-gl.js.br | grep -i content-encoding
wc -c < /tmp/lib.bin

# and from the plain path, where a compressed sibling would be picked up
curl -s -H 'Accept-Encoding: br' https://tiles.jasontally.com/vendor/maplibre-gl.js | wc -c
```

224,810 bytes is the size of the file `build.mjs` wrote, and it is what the first
command has to print for the library to be worth moving back. Under `text/javascript`
it printed 224,815: the host had compressed the file a second time. The probe is the
same file under `application/ecmascript`, so if the type is what decides, the first
command now prints 224,810 and the page can come back to this host. If it prints
224,815 again, or a gzip size, the answer is no and the probe can be deleted. The
second command printed 274,739, which closes the sibling route.

`wrangler dev` does not settle this either way: it answers with its own gzip on top of
the declared encoding, which is the same failure for a different reason, and the local
asset worker has no compression code at all. Only the deployed host counts.

What the numbers above still say is that this host's own compression is gzip-class: it
sends the style JSON as 3,410 bytes where brotli at its best writes 2,638. A host that
honoured a declared encoding would be worth 50 KB and about 0.26 s on the profile this
project measures against.

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
| MapLibre GL JS, brotli, the probe | 1 | 220 KB |
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