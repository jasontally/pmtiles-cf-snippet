# Sharding the archive across Workers

## The problem

One Worker cannot hold this archive, and one build cannot process it.

| Limit | Value |
|---|---|
| Archive | 138.88 GB (`138,882,453,615` bytes) |
| Workers Builds disk | 20 GB |
| Workers Builds timeout | 20 minutes |
| Asset files per Worker | 100,000 |
| One asset file | 25 MiB |

I measured sustained download speed against the real archive: **61.3 MB/s** from
this machine. A build container may differ, so the plan is sized for 30 MB/s.

At that speed the whole archive needs **77 minutes** in one build, and 138.88 GB
does not fit on a 20 GB disk. Both limits fail independently.

The numbers here are from the 1 November 2026 build, `20261101.pmtiles`, read
from its own header. The archive grows about 1 GB a month, so a number moves
slowly. The old figures were from the 118 GB archive the split was designed on.

## Why not 4 Workers

Splitting reduces the work per build, not the total. What each build does:
download its own slice with a Range request, cut it into parts on disk, then let
wrangler upload them. So a build moves its slice twice and holds it on disk.

At 4 shards each build gets 34.7 GB. That does not fit on a 20 GB disk, and the
build takes 19 minutes at 30 MB/s and 39 minutes at the measured speed. **4 is
short on the disk at every speed, and short on time at the speed the plan is
sized for.**

Splitting across Workers also does not reduce the total bytes transferred. It
only divides them among more concurrent builds.

## The number

| Assumed speed | Shards | GB/shard | Files/shard | Min/build | Limited by |
|---|---|---|---|---|---|
| **30 MB/s** | **25** | **5.56** | **5,556** | **9.3** | **time** |
| 61 MB/s (measured) | 25 | 5.56 | 5,556 | 4.6 | time |
| 100 MB/s | 25 | 5.56 | 5,556 | 2.8 | disk |
| 200 MB/s | 25 | 5.56 | 5,556 | 1.4 | disk |

**25 shards**, sized for a conservative 30 MB/s. Below about 50 MB/s the build
time is the binding constraint. Above that the disk is, and the count stops
changing at whatever keeps each shard under 20 GB.

The split started at 13 shards, on a 118 GB archive. The archive outgrew it:
at 13 shards each build would hold 10.7 GB and cut 10,684 parts, and the parts
per shard no longer fit the reader's single division. The count moved to 25.

25 leaves:

- 5.56 GB on disk per shard, a quarter of the 20 GB limit, leaving room for
  wrangler's manifest and staging area
- 5,556 files per shard, 6 % of the 100,000 limit
- 9.3 minutes per build at 30 MB/s, 46 % of the 20 minute budget

At the measured 61.3 MB/s each build takes 4.6 minutes. Measured on 19 October
2026, one build at a time, a shard build took 8 to 15 minutes end to end: the
download ran at 17 to 95 MB/s and the upload of 5,544 files took 2 to 11 minutes.
See `refresh.md`.

## The layout

Each shard holds a whole number of tile parts, so a boundary never falls inside
a part. Shard `k` owns tile parts `[k * 5,556, (k+1) * 5,556)`, and the last
shard is cut short where the tile data ends.

```
archive bytes
0                    16,384                          138,882,453,615
|------ head -------|------ tile data, 138,883 parts, 1,000,000 B each -----|+ meta |
                                               shard 0 | shard 1 | ... | shard 24
                                                           353 MB
                                        138,882,454,794                     EOF
                                 |--- leaf dirs, 353 MB ---|
```

The head, metadata, and leaf sections are 353 MB together, 0.3 % of the archive,
so they all live in shard 0. Every other shard is pure tile data, which keeps
each shard's byte range contiguous and its Range request a single download.

### Why this matters for the reader

The routing is one division:

```
part  = floor((offset - tileDataOffset) / 1,000,000)
shard = floor(part / 5,556)
```

A request is at most `MAX_RESPONSE`, 524,288 bytes, so it spans at most 2 parts
and therefore at most 2 shards. With a 2 subrequest budget that is exactly
affordable.

Verified in `shard-plan.test.mjs`: a request crossing a shard boundary uses
exactly 2 reads on 2 hosts, and every tile request uses 1.

## Reading across hosts

The snippet fetches from whichever shard holds the bytes:

```
GET https://s12.tiles.jasontally.com/s/basemap/tile/067000.bin
Range: bytes=978759-978960
```

That is one subrequest, the same as before. The shard boundaries are chosen so
this almost never straddles.

Straddle probability for a median 202 byte tile at 5,556 parts per shard: the
chance a random tile crosses a boundary is `202 / 5,556 / 1,000,000`, which is
about **1 in 27 billion**.

## What does not change

- The snippet's range parsing, CORS, ETag, and 416 handling are unchanged.
- The part layout inside a shard is unchanged, so `shard-pmtiles.py` and
  `split-stream.mjs` still apply.
- Asset requests stay free and unlimited, and no Worker runs, so a tile request
  still costs USD 0.

## What changes

- 25 repos instead of 1, and 25 Worker projects instead of 1.
- The snippet holds a shard table and picks a host per request.
- Each repo builds one slice and cannot serve any other part.

## Provisioning

`provision.mjs` creates the 25 Workers and attaches a Custom Domain to each.

**Custom Domains, not Routes.** A Custom Domain makes the Worker the origin and
Cloudflare creates the DNS record and the certificate. A Route needs a proxied
DNS record to exist first, or requests never arrive at the Worker.

| Shard | Worker | Hostname | Tile parts |
|---|---|---|---|
| 0 | `pmtiles-shard-00` | `s.tiles0.jasontally.com` | 0..5555 |
| 1 | `pmtiles-shard-01` | `s.tiles1.jasontally.com` | 5556..11111 |
| 24 | `pmtiles-shard-24` | `s.tiles24.jasontally.com` | 133344..138882 |

The last range is shorter than the others, because the tile data ends partway
through it. Shard 0 also holds `head.bin`, `meta.bin`, and the leaf parts.

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
permission problem is reported before 25 half-created Workers exist. A Worker
that already exists is skipped and a hostname already attached is skipped, so it
is safe to run twice.

### Permissions

| Permission | Scope | Why |
|---|---|---|
| Workers Scripts: Edit | Account | Create the 25 Workers and deploy to them |
| Workers Routes: Edit | Zone | Attach the Custom Domains |
| Snippets: Edit | Zone | Deploy the reading snippet |
| Zone: Read | Zone | Read the zone to check the hostname stem |

Creating a Worker requires product-level Admin. A per-Worker scope cannot be
used, because a Worker that does not exist yet cannot be granted access.

## Repos

25 separate repos, one per shard, rather than 25 branches of one repo.

`shard-repo/` is the template. Every repo holds the same code and differs only
in the Worker name inside `wrangler.jsonc`, which must match the Worker in the
dashboard or the build fails.

`make-repos.mjs` creates them. It runs the shard tests first, so no repo can get
broken code, and it is safe to re-run: an existing repo is updated with the
current template, which is how a fix in `shard-repo/` reaches all 25.

```sh
node make-repos.mjs --dry-run          # print the plan, create nothing
node make-repos.mjs                    # create and push
node make-repos.mjs --update           # push template changes to existing repos
node make-repos.mjs --update --only 0  # one shard, for a test
```

### A GitHub push is the only way a shard changes

A shard repo changes only by a commit pushed to it on GitHub. Workers Builds
watches the repo, so that push is also what starts the build. Do not deploy a
shard with `wrangler`, and do not change a shard with the Cloudflare API. A
deploy made that way is not in the repo, the next push replaces it, and the
repo and the Worker then disagree.

An update clones each repo and pulls what GitHub holds, so a refresh commit or a
workflow edit made since the last update stays. The template is copied over the
clone and pushed as a normal commit. The push is never forced. If a refresh lands
between the clone and the push, the update rebases onto it.

The one file the template must not change is `archive.json`. It is the shard's
own state, and the refresh workflow owns it. A missing `archive.json` in a clone
stops the update for that shard, because a shard always has the file and its
absence means something is wrong. On 7 November 2026 an earlier version of the
update deleted `archive.json` from `pmtiles-shard-00`, and the shard lost the
record of the build it held. `shard-repo/make-repos.test.mjs` covers this.

GitHub rate limits repository creation to roughly 10 at a time. The limit was
hit at shard 10 and cleared later. `make-repos.mjs` and `fill-shards.sh` both
skip repos that already exist, so re-running is safe.

### What a shard build does

`shard-repo/build.mjs` writes `public/` and stops. `wrangler deploy` then
uploads, which is the Workers Builds deploy command.

The download is one HTTP Range request covering the shard's parts. Each part is
written as it streams past and the bytes between parts are discarded, so disk
use is the parts only, about 10 GB, not the 20 GB that storing the slice too
would need.

Shard 0 is not one contiguous span: it holds the head, then the tile parts, then
the metadata and leaves, with the other 12 shards' tile data in the gap. So parts
are grouped into maximal adjacent runs and each run gets its own Range request.
Against the real archive:

| Shard | Requests | Bytes fetched |
|---|---|---|
| 0 | 2 | 5.56 GB |
| 1 to 24 | 1 | 5.56 GB |

Shard 0 needs two requests because the metadata and the leaf directories sit
after the tile data, on the far side of the other 24 shards' bytes. Its two
requests skip that gap.

This was a real bug, found by running the plan against the real archive header
rather than a synthetic one. The first version fetched one Range request
spanning the shard's first part to its last. For shard 0 that was the entire
archive, about 38 minutes at the measured 61 MB/s, which does not fit the 20
minute build limit.

Two bugs the 27 shard tests caught:

- An `async _transform` in the stream extractor deadlocked, because node's
  stream machinery does not await the promise, so the pipeline never finished.
  The extractor is now a plain class that pulls chunks with `for await`.
- The extractor's start position was implicitly `parts[0].start`, which is only
  true when the source honours Range. A source that ignores Range and sends the
  whole file would have written archive byte 0 into the wrong part. The stream
  start is now an explicit argument, and there is a test for it.

## The reader Snippet

`snippet.js` serves `tiles.jasontally.com/basemap.pmtiles` and routes each part
read to the shard that holds it.

Shard `k` owns tile parts `[k * 5,556, (k+1) * 5,556)`, so a tile part number
gives its shard with one integer division:

```js
const host = Math.floor(index / archive.tilePartsPerShard);
```

The head, the metadata, and the leaf directories are on shard 0, because together
they are 353 MB and far smaller than one tile shard.

The Snippet rule is `http.host eq "tiles.jasontally.com"` and the asset paths
contain no `.pmtiles`, so a subrequest to a shard host cannot re-enter the
Snippet. That matters: if it could, every tile read would recurse.

### Part size, measured

Serving cost depends on the part size because the Snippet must stream from the
start of a part to reach the answer. Measured live, cache warm, 202 byte tiles:

| Offset in the part | End to end |
|---|---|
| 1,000 | 117 ms |
| 1,000,000 | 133 ms |
| 1,999,700 | 140 ms |

The whole streaming overhead is about 23 ms, so the request is dominated by the
round trip. A tile request is about 126 ms median.

This bounds the value of smaller parts: the best case is about 18 %. The cost is
the build, not the file limit. From 22 shard builds, upload cost is
**90 s per GB plus 0.055 s per file**. The byte term is 500 s per shard whatever
the part size is. Halving the parts to 500,000 B adds 306 s per build, and
pushes builds past the 30 minute wall that already killed one.

So the part size stays at 1,000,000 B, and the count went to 25 rather than the
part size going down.

### Verification

`verify-live.py` proves the deployed system, not the arithmetic. It compares the
reader against each shard Worker and against the source archive.

```sh
python3 verify-live.py     # 27 checks, needs the network
npm run test               # 85 offline checks
```

## Wiring the shards, by API

No dashboard work is needed. `wire-shards.mjs` does all of it for all 25 shards:

```sh
node wire-shards.mjs --dry-run      # report what is missing, change nothing
node wire-shards.mjs                # wire every shard
node wire-shards.mjs --only 3,7,12  # wire some
```

Per shard it registers the GitHub repo, binds it to the Worker as a trigger, sets
the build variables, then reads all three back. It is idempotent: a shard that
already has a trigger on the right repo keeps it, so it never creates a second
trigger, and it is safe after a template change.

Five endpoints do the work. All of them accept the account-scoped token already
used for provisioning, so no new token is needed.

| Purpose | Call |
|---|---|
| register the repo | `PUT /accounts/{a}/builds/repos/connections` |
| bind repo to Worker | `POST /accounts/{a}/builds/triggers` |
| set build variables | `PATCH /accounts/{a}/builds/triggers/{uuid}/environment_variables` |
| start a build | `POST /accounts/{a}/builds/triggers/{uuid}/builds` |
| read build logs | `GET /accounts/{a}/builds/builds/{uuid}/logs` |

Two things are not what the documentation suggests:

- There is no working `GET /builds/repos/connections`. The upsert returns the
  connection with its `repo_connection_uuid`, so there is no need to list them.
- `grant_id` comes back `null`, which means the GitHub App is already installed
  for the repository, so no browser consent flow is needed. A non-null grant
  means one is, and the script stops with that message rather than guessing.

Shard settings, all set by the script:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| `SHARD_INDEX` | 0 to 24 |
| `SHARD_COUNT` | `25` |

There is no `ARCHIVE_URL` variable. The archive is the dated snapshot named in
`archive.json` in each shard repo, not a moving URL. Every shard
must cut parts from the same bytes, and the reader computes part numbers from the
archive layout, so a republished file at the same URL would shift every part and
silently corrupt the map.

Keeping the URL in the repo rather than in the build settings is what lets a
GitHub Actions workflow refresh a shard with no credential in GitHub: the workflow
commits a newer `archive.json`, the commit starts the build, and Cloudflare
injects its own token where the archive is fetched. `wire-shards.mjs` deletes a
leftover `ARCHIVE_URL` variable, because it outranks the file on every build. See
[refresh.md](refresh.md).

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