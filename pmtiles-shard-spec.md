# Serving a 118 GiB PMTiles archive from Cloudflare Static Assets with a Snippet

## 1. Summary

This document specifies how to serve the Protomaps basemap on Cloudflare without
R2 and without a Worker. The archive is cut into small files. A Snippet answers
HTTP range requests on a virtual `.pmtiles` URL by reading those files.

Three parts make up the system:

1. `shard-pmtiles.py` cuts the archive into part files by archive section.
2. `snippet.js` answers range requests and cuts out the bytes that the client
   asked for.
3. `build.mjs` splits, verifies, uploads the assets, minifies the snippet, and
   deploys it. It runs on Workers Builds after every push.

The controlling fact is that **Workers Static Assets do not answer HTTP Range
requests.** A reader must fetch a whole part file and slice it in JavaScript.
The part sizes therefore decide the cost of every tile request.

## 2. What the Protomaps client asks for

The client is `pmtiles`, the JavaScript library in the `protomaps/PMTiles`
repository at `js/src/index.ts`. It sends only single, closed byte ranges. It
never sends an open range. It never sends more than one range.

| Step | Offset | Length | Source of the numbers |
|---|---|---|---|
| Header and root directory | `0` | `16384` | Fixed by `getHeaderAndRoot` |
| Leaf directory | parent directory entry | parent entry length | Leaf section |
| Tile | `tileDataOffset + entry.offset` | `entry.length` | One tile entry |
| Metadata | `header.jsonMetadataOffset` | `header.jsonMetadataLength` | Metadata section |

Two details matter for the server.

The client reads the `ETag` response header. It uses the ETag to notice a new
archive. The server must send `Access-Control-Expose-Headers: ETag`, or the
browser hides the ETag from the script. The ETag must be strong. The client
discards a weak ETag that starts with `W/`.

The client has one special case. If `Range: bytes=0-16383` returns `416`, it
concludes the archive is smaller than 16,384 bytes and then requests
`bytes=0-<actualLength-1>`, which is the whole 118 GiB file. The server must
therefore never return `416` for the first request. Part 0 always exists, so
this does not happen.

## 3. Measured facts about the archive

The numbers below were read from `https://build.protomaps.com/20241021.pmtiles`.
They are measurements, not documentation.

| Property | Value |
|---|---|
| Total size | `126,775,469,007` bytes (118.07 GiB) |
| Version | 3 |
| Root directory | offset `127`, length `15,534` gzip |
| Tile data | offset `16,384`, length `126,450,529,397` (99.74 %) |
| Metadata | offset `126,450,545,781`, length `1,160` |
| Leaf directories | offset `126,450,546,941`, length `324,922,066` (0.26 %) |
| Clustered | 1 |
| Tile type | MVT, gzip |
| Zoom range | 0 to 15 |

The file layout is:

```
0                   127      16,384                                126,450,545,781  +1,160
|-- header --|--------|--------------- tile data ---------------|--- metadata ---|
                  root dir

                                                              126,450,546,941                                        EOF
                                                        |------ leaf directories ------|
```

The root directory holds 2,917 entries. All 2,917 point to a leaf directory. The
leaf directories are contiguous and ascend by tile ID and by byte offset. Their
sizes:

| Property | Bytes |
|---|---|
| Minimum | 5,234 |
| Median | 118,376 |
| Mean | 111,389 |
| p95 | 139,799 |
| Maximum | 150,036 |

One sampled leaf directory holds 55,730 tile entries. Tile sizes in it:

| Property | Bytes |
|---|---|
| Median | 202 |
| Mean | 245 |
| p99 | 754 |
| Maximum | 6,873 |

**The largest single request the client makes is a leaf directory of 150,036
bytes.** The next largest is the fixed 16,384 byte header request. A typical
tile request is about 200 bytes.

## 4. The controlling constraint

Static Assets do not honour `Range`. The reader must download a whole part and
sliced it. Three limits follow.

| Budget | Value | Source |
|---|---|---|
| Asset files per Worker version | 100,000 | Workers platform limits |
| One asset file | 25 MiB | Workers platform limits |
| Snippet subrequests per request | 2 on Pro, 3 Business, 5 Enterprise | Snippets |
| Snippet CPU time | 5 ms | Snippets |
| Snippet memory | 2 MB | Snippets |
| Snippet package | 32 KB | Snippets |

Asset requests are free and unlimited. Snippets cost nothing extra on paid
plans. A Worker would be billed per request. A map view makes hundreds of tile
requests, so the Snippet is the right tool for this.

**The file limit and the memory limit pull in opposite directions.**

| Tile part size | Files | Spare | Worst part read |
|---|---|---|---|
| 1,000,000 | 128,484 | over limit | 1.0 MB |
| **2,000,000** | **65,259** | **34,741** | **2.0 MB** |
| 4,000,000 | 32,182 | 67,818 | 4.0 MB |
| 25,000,000 | 7,092 | 92,908 | 25.0 MB |

A 1 MB part does not fit in 2 MB of memory next to the answer buffer. A 25 MB
part costs 25 MB of transfer to answer a 200 byte tile. The chosen part size is
2,000,000 bytes, and the snippet streams parts above 1 MiB instead of buffering
them, so peak memory is the answer plus one network chunk.

**Why not fewer, larger parts.** A 25 MB part would use only 7,092 files, but
each tile request would pull 25 MB across the internal network and then throw
almost all of it away. At 2 MB the waste is 10 times the tile size instead of
125 times.

**Why not more, smaller parts.** Below about 1.2 MB the file count passes
100,000. That limit is hard.

## 5. Part sizes and why there are two of them

Parts are cut by archive section, not evenly across the file.

| Section | Part size | Files | Why that size |
|---|---|---|---|
| Header and root | one file, 16,384 B | 1 | The client always reads exactly this |
| Tile data | 2,000,000 B | 63,226 | 99.99 % of requests. Sets the file count and the per request cost |
| Metadata | one file, 1,160 B | 1 | The client reads it once |
| Leaf directories | 160,000 B | 2,031 | Must exceed 150,036 so a leaf read stays at 1 subrequest |
| **Total** | | **65,259** | 34,741 files spare |

A single uniform part size cannot do this. The leaf request is 150,036 bytes, so
a uniform part below that size would need several parts for one leaf read. The
leaf parts are 0.26 % of the bytes but carry the largest request, so they get a
size just above it. The tile parts carry everything else and get a size that
fits the file budget.

Subrequest count per request:

| Request | Length | Parts | Chance of needing 2 |
|---|---|---|---|
| Header and root | 16,384 | 1 | 0 (fixed offset) |
| Median tile | 202 | 1 | 0.010 % |
| Largest tile seen | 6,873 | 1 | 0.034 % |
| Metadata | 1,160 | 1 | 0 (aligned) |
| Largest leaf | 150,036 | 1 or 2 | 94 % within one part |

The worst case is 2 subrequests, which is exactly the Pro limit.

## 6. Asset layout

```
public/
  _headers                       written by the tool
  s/
    basemap/
      head.bin                   bytes [0, 16,384)
      tile/000000.bin            bytes [16,384, 2,016,384)
      tile/000001.bin            bytes [2,016,384, ...)
      ...
      tile/063225.bin
      meta.bin                   bytes [126,450,545,781, +1,160)
      leaf/000000.bin            bytes [126,450,546,941, +160,000)
      ...
      leaf/002030.bin
      manifest.json              for tools, not served
```

### 6.1 The `_headers` file

Cloudflare serves assets with `Cache-Control: public, max-age=0,
must-revalidate` by default. That forces a check on every request. Parts never
change, so:

```txt
/s/*
	Cache-Control: public, max-age=31536000, immutable
	Access-Control-Allow-Origin: *
	Access-Control-Expose-Headers: Content-Length
```

The tool writes this file. Without it the reader hits the asset store on every
tile request.

### 6.2 Incremental uploads

Cloudflare's asset upload API compares a content hash for every file and does not
re-upload unchanged files. Wrangler uses this API. So a build where only some
parts changed uploads only those parts. **Do not reimplement this in the tool.**
The tool skips writing a part whose size already matches, which saves local
disk writes. The hash comparison happens at upload time.

## 7. Manifest

The snippet needs these numbers per archive, and it holds them in its own
source because a Snippet has no environment variables and no bindings:

| Field | Meaning |
|---|---|
| `total` | Size of the original `.pmtiles` |
| `headEnd` | First byte after the header area |
| `tileOffset` | First byte of the tile data section |
| `metaOffset` | First byte of the metadata section |
| `leafOffset` | First byte of the leaf directory section |
| `tileShard` | Tile part size |
| `leafShard` | Leaf part size |

The tool prints the line to paste into `snippet.js`. It also writes
`manifest.json` for other tools. The snippet never fetches the manifest: that
would spend a subrequest on every tile.

## 8. The range mapping

Given a client range `start` to `end`:

```
first = floor((start - sectionStart) / shard)
last  = floor((end   - sectionStart) / shard)

for i in first to last:
    partStart = i * shard
    lo = max(start - sectionStart, partStart) - partStart
    hi = min(end   - sectionStart, partStart + shard - 1) - partStart
    read  /s/<name>/<section>/<i>.bin  and take bytes [lo, hi]
```

The snippet refuses a range that needs more than 2 parts or more than
`MAX_RESPONSE` (512 KiB) bytes.

### 8.1 Accepted ranges

| Request header | Action |
|---|---|
| `bytes=A-B`, `0 <= A <= B < total` | Serve A to B |
| `bytes=A-` | Serve A to `total - 1` |
| `bytes=-N` | Serve the last N bytes |
| `bytes=-0` | `416` |
| `bytes=` , wrong unit, many ranges | `416` |
| `bytes=A-B`, B past the end | Shorten B |
| `bytes=A-B`, A at or past the end | `416` |
| no `Range` header | `416` |

A request with no `Range` asks for the whole 118 GiB file. The server returns
`416`, which is correct for RFC 9110.

**Known ceiling.** Someone who types the URL into a browser, or uses `curl`
without `-r`, gets `416`. The Protomaps client never does this. If whole file
downloads must work later, add a TileJSON endpoint. Do not stream 118 GiB.

### 8.2 Response headers

```
HTTP/1.1 206 Partial Content
Content-Type: application/vnd.pmtiles
Content-Length: <end - start + 1>
Content-Range: bytes <start>-<end>/<total>
Accept-Ranges: bytes
ETag: "<name>-<total>"
Cache-Control: public, max-age=3600
Access-Control-Expose-Headers: ETag, Content-Range, Accept-Ranges, Content-Length
```

`Access-Control-Expose-Headers` must list `ETag`. Without it the browser hides
the ETag and the client loses its check for a new archive.

## 9. Memory and CPU

Because parts are not ranged, each request reads a whole part.

| Part | Size | Read method |
|---|---|---|
| `head.bin` | 16 KiB | buffered |
| `meta.bin` | 1.2 KiB | buffered |
| leaf part | 160 KiB | buffered |
| tile part | 2.0 MB | streamed, cancelled after the answer |

`BUFFER_LIMIT` is 1 MiB. A part at or below it is read into one buffer, which is
cheaper than streaming. A part above it is streamed, and the reader is cancelled
once the needed bytes arrive. Peak memory is then the answer plus one chunk.

The CPU cost is roughly the bytes streamed. A median tile request streams about
1 MB on average and at most 2 MB. At 64 KiB per chunk that is about 16 to 32
chunks.

**This is the main risk in the design and it must be measured.** Section 12,
test 3 measures it on the live snippet.

## 10. Why a Snippet and not a Worker

| Path | Cost per tile request |
|---|---|
| Snippet + Static Assets | USD 0. Asset requests are free, snippets are free on paid plans |
| Worker + Static Assets | Billed Worker request |
| Worker + R2 | Billed request plus an R2 operation |

Choose a Worker instead if:

* A request must read more than 2 parts. The Pro plan fails.
* You want your own `caches.default` layer. Cache API calls spend the subrequest
  budget.
* You need bindings, Durable Objects, or logs.
* You must support whole file downloads.
* You want to change part sizes without a full re-split.

A Worker has 10,000 subrequests and 128 MB. The same algorithm works there with
no change.

## 11. Open risks

### 11.1 CPU time on a tile request

Unmeasured. The budget is 5 ms. A tile request streams up to 2 MB. If test 3 in
section 12 shows the time is too high, lower `TILE_SHARD`. Each halving of the
part size roughly halves the read and doubles the file count. At 1,250,000 bytes
the file count reaches about 103,000, which is over the limit.

**If the part size cannot go lower and the CPU is too high, the section that
holds 99.99 % of requests has no smaller unit available.** Then the answer is a
different serving product, not a smaller number.

### 11.2 Memory on a two part request

Two parts read at once could reach 4 MB if both are tile parts. In practice only
the leaf section has a 2 part case, and leaf parts are 160 KiB each, so the peak
is 320 KiB. A two part tile request cannot happen because a tile request is at
most 6,873 bytes and a tile part is 2,000,000 bytes.

### 11.3 The build needs the archive

`build.mjs` downloads the archive if it is not present. A 118 GiB download on
every build is slow. Set `DOWNLOAD=0` and cache the archive outside the build, or
point `ARCHIVE_PATH` at a mounted copy.

### 11.4 The upload is large

The first build uploads 65,259 files and 118 GiB. Later builds upload only the
parts whose content changed. See section 6.2.

## 12. Verification tests

Run these in order against the live deployment.

**Test 1, asset serving.** Fetch a tile part directly.
`curl -sI https://<host>/s/basemap/tile/000000.bin`. Check status 200,
`Content-Length: 2000000`, and `Cache-Control: public, max-age=31536000,
immutable`. Then fetch it again and check `cf-cache-status: HIT`.

**Test 2, range answers.** Fetch a range and compare with the archive.

```sh
curl -s -H 'Range: bytes=0-16383' https://<host>/basemap.pmtiles -o head.bin
# then, with the same 16,384 bytes from the source archive
cmp head.bin <(head -c 16384 archive.pmtiles) && echo MATCH
```

**Test 3, CPU and memory.** This is the one that matters. Load the map in the
Protomaps demo, then read the snippet timing.

```sh
wrangler tail --format json
```

Watch for `cpuTime`. Record the value for a tile request. If it approaches
5,000,000 microseconds, lower `TILE_SHARD` and rebuild.

**Test 4, subrequest count.** Watch the network panel while loading a map view.
A tile request must show exactly 1 request to `/s/basemap/tile/...`. A request
that crosses a part boundary must show 2. Anything more means the part size is
below the largest client request.

**Test 5, the client reads it.** In the browser console:

```js
const p = new PMTiles("https://<host>/basemap.pmtiles");
console.log(await p.getHeader());
```

Check `etag` is not null. If it is null, `Access-Control-Expose-Headers` is
wrong.

**Test 6, the whole path.** Load the Protomaps basemap demo against the host.
Every tile must draw.

## 13. Local checks

```sh
python3 shard-pmtiles.py --selftest   # section planning and byte reconstruction
node snippet-test.js                  # the snippet against a real split, 20 checks
node minify-test.js                   # the minifier, 19 checks
node deploy-test.js                   # the deploy requests, against a mock API, 13 checks
```

`snippet-test.js` splits a small synthetic archive with the real tool, then
drives the real snippet code against a fake asset store that ignores `Range`,
which is the behaviour this design works around.

`deploy-test.js` runs `build.mjs` against a mock Cloudflare API in a child
process. It checks that the snippet is uploaded minified, that the size is under
the 32 KB limit, that existing snippet rules survive, that a repeated build does
not duplicate the rule, and that a bad secret or a rejected name stops the build.

### 13.1 What the minifier tests found

The minifier joined `a + +b` into `a++b`, which is a syntax error, and
`x - -x` into `x--x`, which is also a syntax error. Both are in the test suite
now. This is why the minifier exists in this repository instead of coming from
npm: no package could be installed in this environment, so it is a tokeniser
with a test for each case that broke it.

## 14. Deployment

A push to the default branch runs Workers Builds. Two commands run, in order.
Set these in **Settings > Build**.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |

`npm run build` is `node build.mjs prepare`. It splits the archive, verifies
every part against the archive, and minifies the snippet to
`dist/snippet.min.js`. It deploys nothing.

`npm run deploy` is `node build.mjs deploy`. It uploads the assets, then uploads
the snippet and sets its rule.

**The deploy command must not stay `npx wrangler deploy`.** Wrangler cannot
upload a snippet. A snippet is a zone resource, and it needs the Snippets API.
Running wrangler in the build step as well would upload the asset set twice.

The `name` in `wrangler.jsonc` must match the Worker name in the dashboard, or
the build fails. It is `pmtiles-cf-snippet`.

The API token needs Workers Scripts Edit for the assets and Snippets Edit for
the snippet. See the header of `build.mjs` for the full list of environment
variables.

### 14.1 Preview branches

Preview branches run the preview command, not the deploy command. So a preview
build uploads no assets and no snippet. A snippet is a zone resource, so a
preview cannot have its own. A preview Worker serves the part files at its
`*.tiles.jasontally.com` name, but the zone snippet rule only matches
`tiles.jasontally.com`, so range requests do not work on previews.

To test a preview, request a part file directly. See test 1 in section 12.

### 14.2 Why the snippet goes second

The snippet answers `tiles.jasontally.com/basemap.pmtiles`. If it went live
before the parts, every tile request would return `502` until the upload
finished. Putting it second means the URL only starts answering once the parts
are in place.

## 15. Files

| File | Purpose |
|---|---|
| `shard-pmtiles.py` | Cuts the archive. Also `--selftest` and `--verify`. |
| `snippet.js` | The Cloudflare Snippet. |
| `build.mjs` | Split, verify, upload, minify, deploy. |
| `snippet-test.js` | Drives the snippet against a real split. |
| `minify-test.js` | Checks the minifier. |
| `deploy-test.js` | Checks the deploy requests against a mock API. |
| `wrangler.jsonc` | Worker name and assets directory. |