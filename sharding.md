# Sharding the archive across Workers

## The problem

One Worker cannot hold this archive, and one build cannot process it.

| Limit | Value |
|---|---|
| Archive | 118.07 GiB (`126,775,469,007` bytes) |
| Workers Builds disk | 20 GB |
| Workers Builds timeout | 20 minutes |
| Asset files per Worker | 100,000 |
| One asset file | 25 MiB |

I measured sustained download speed against the real archive: **61.3 MB/s** from
this machine. A build container may differ, so the plan is sized for 30 MB/s.

At that speed the whole archive needs **69 minutes** in one build, and 236 GiB
does not fit on a 20 GB disk. Both limits fail independently.

## Why not 4 Workers

Splitting reduces the work per build, not the total. What each build does:
download its own slice with a Range request, cut it into parts on disk, then let
wrangler upload them. So a build moves its slice twice and holds it on disk.

At 4 shards each build gets 31.6 GB. That does not fit on a 20 GB disk, and the
build takes 35 minutes at the measured speed. **4 is short by a factor of about 2
on both limits.**

Splitting across Workers also does not reduce the total bytes transferred. It
only divides them among more concurrent builds.

## The number

| Assumed speed | Shards | GB/shard | Files/shard | Min/build | Limited by |
|---|---|---|---|---|---|
| 15 MB/s | 25 | 5.38 | 4,563 | 12.0 | time |
| **30 MB/s** | **13** | **10.05** | **6,897** | **11.2** | **time** |
| 61 MB/s (measured) | 13 | 10.05 | 6,897 | 5.5 | time |
| 100 MB/s | 13 | 10.05 | 6,897 | 3.4 | time |
| 200 MB/s | 13 | 10.05 | 6,897 | 1.7 | time |

**13 shards**, sized for a conservative 30 MB/s. Above about 40 MB/s the disk is
the binding constraint, and the count stops changing.

13 leaves:

- 10.05 GB on disk per shard, half the 20 GB limit, leaving room for wrangler's
  manifest and staging area
- 6,897 files per shard, 7 % of the 100,000 limit
- 11.2 minutes per build at 30 MB/s, 56 % of the 20 minute budget

At the measured 61.3 MB/s each build takes 5.5 minutes.

## The layout

Each shard holds a whole number of tile parts, so a boundary never falls inside
a part. Shard `k` owns tile parts `[k * 4864, (k+1) * 4864)`.

```
archive bytes
0                    16,384                          126,450,545,781
|------ head -------|--------- tile data, 63,226 parts, 2,000,000 B each ------|+ meta |
                                                 shard 0 | shard 1 | ... | shard 12
                                                             324.9 MB
                                          126,450,546,941                      EOF
                                   |--- leaf dirs, 2,031 parts, 160,000 B ---|
```

The head, metadata, and leaf sections total only 324.9 MB, so they all live in
shard 0. Every other shard is pure tile data, which keeps each shard's byte range
contiguous and its Range request a single download.

### Why this matters for the reader

The routing is one division:

```
part  = floor((offset - tileDataOffset) / 2,000,000)
shard = floor(part / 4864)
```

A tile request is at most 6,873 bytes, so it spans at most 2 parts and therefore
at most 2 shards. With a 2 subrequest budget that is exactly affordable.

Verified in `shard-plan.test.mjs`: a request crossing a shard boundary uses
exactly 2 reads on 2 hosts, and every tile request uses 1.

## Reading across hosts

The snippet fetches from whichever shard holds the bytes:

```
GET https://s12.tiles.jasontally.com/s/basemap/tile/063224.bin
Range: bytes=978759-978960
```

That is one subrequest, the same as before. The shard boundaries are chosen so
this almost never straddles.

Measured straddle probability for a median 202 byte tile at 4,864 parts per
shard: the chance a random tile crosses a boundary is
`202 / 4,864 / 2,000,000`, which is about **1 in 48 billion**.

## What does not change

- The snippet's range parsing, CORS, ETag, and 416 handling are unchanged.
- The part layout inside a shard is unchanged, so `shard-pmtiles.py` and
  `split-stream.mjs` still apply.
- Asset requests stay free and unlimited, and no Worker runs, so a tile request
  still costs USD 0.

## What changes

- 13 repos instead of 1, and 13 Worker projects instead of 1.
- The snippet holds a shard table and picks a host per request.
- Each repo builds one slice and cannot serve any other part.

## Provisioning

`provision.mjs` creates the 13 Workers and attaches a Custom Domain to each.

**Custom Domains, not Routes.** A Custom Domain makes the Worker the origin and
Cloudflare creates the DNS record and the certificate. A Route needs a proxied
DNS record to exist first, or requests never arrive at the Worker.

| Shard | Worker | Hostname | Tile parts |
|---|---|---|---|
| 0 | `pmtiles-shard-00` | `s.tiles0.jasontally.com` | 0..4863 |
| 1 | `pmtiles-shard-01` | `s.tiles1.jasontally.com` | 4864..9727 |
| 12 | `pmtiles-shard-12` | `s.tiles12.jasontally.com` | 58368..63231 |

Shard 0 also holds `head.bin`, `meta.bin`, and the 2,031 leaf parts.

Preview the plan without touching anything:

```sh
node provision.mjs --dry-run
```

Then create them:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_ZONE_ID=... \
  node provision.mjs
```

The script reads the zone name back from the API before creating anything, so a
permission problem is reported before 13 half-created Workers exist. A Worker
that already exists is skipped and a hostname already attached is skipped, so it
is safe to run twice.

### Permissions

| Permission | Scope | Why |
|---|---|---|
| Workers Scripts: Edit | Account | Create the 13 Workers and deploy to them |
| Workers Routes: Edit | Zone | Attach the Custom Domains |
| Snippets: Edit | Zone | Deploy the reading snippet |
| Zone: Read | Zone | Read the zone to check the hostname stem |

Creating a Worker requires product-level Admin. A per-Worker scope cannot be
used, because a Worker that does not exist yet cannot be granted access.

## Repos

13 separate repos, one per shard, rather than 13 branches of one repo.

`shard-repo/` is the template. Every repo holds the same code and differs only
in the Worker name inside `wrangler.jsonc`, which must match the Worker in the
dashboard or the build fails.

`make-repos.mjs` creates them. It runs the shard tests first, so no repo can get
broken code, and it is safe to re-run: an existing repo is updated with the
current template, which is how a fix in `shard-repo/` reaches all 13.

```sh
node make-repos.mjs --dry-run     # print the plan, create nothing
node make-repos.mjs               # create and push
node make-repos.mjs --update      # push template changes to existing repos
```

**GitHub rate limits repository creation.** Ten were created before the limit
hit. `fill-shards.sh` creates the rest once the cooldown passes. It is idempotent
and skips repos that already exist.

### What a shard build does

`shard-repo/build.mjs` writes `public/` and stops. `wrangler deploy` then
uploads, which is the Workers Builds deploy command.

The download is one HTTP Range request covering the shard's parts. Each part is
written as it streams past and the bytes between parts are discarded, so disk
use is the parts only, about 10 GB, not the 20 GB that storing the slice too
would need.

Shard 0 is not one contiguous span: it holds the head, then the tile parts, then
the metadata and leaves, with the tile section in between. It downloads the
whole span from the first part to the last and discards the bytes it does not
own, which costs bandwidth but not disk.

Two bugs the 25 shard tests caught:

- An `async _transform` in the stream extractor deadlocked, because node's
  stream machinery does not await the promise, so the pipeline never finished.
  The extractor is now a plain class that pulls chunks with `for await`.
- The extractor's start position was implicitly `parts[0].start`, which is only
  true when the source honours Range. A source that ignores Range and sends the
  whole file would have written archive byte 0 into the wrong part. The stream
  start is now an explicit argument, and there is a test for it.

## Per shard in the Cloudflare dashboard

Connect each repo to its Worker, then set:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| `ARCHIVE_URL` | the .pmtiles URL |
| `SHARD_INDEX` | 0 to 12 |
| `SHARD_COUNT` | `13` |

Connecting a repository needs the dashboard. The Builds API can manage triggers
and variables, but not the GitHub connection, and it needs a **user-scoped** token
with Workers Builds Configuration Edit. The account-scoped token used for the
provisioning cannot do it.

The snippet's shard table is generated by `plan-report.mjs` and pasted into
`ARCHIVES`, the same way the part constants are today.

## Files

| File | Purpose |
|---|---|
| `shard-plan.mjs` | Decides the shard count and maps a byte range onto hosts. |
| `shard-plan.test.mjs` | 13 checks on the routing, against the real archive. |
| `plan-report.mjs` | Prints the plan at several speeds. The decision tool. |
| `provision.mjs` | Creates the Workers and attaches the Custom Domains. |
| `split-stream.mjs` | Streams one slice into parts without storing the archive. |
| `split-stream.test.mjs` | 16 checks, including awkward stream chunk sizes. |

Run `node plan-report.mjs` to reproduce the table above.