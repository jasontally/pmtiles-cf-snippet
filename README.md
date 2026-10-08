# PMTiles on Cloudflare Static Assets

Serves the 118 GiB Protomaps basemap as a PMTiles archive on Cloudflare, without
R2 and without a Worker. The archive is cut into part files held as Static
Assets. A Cloudflare Snippet answers HTTP range requests by reading those parts.

Read [pmtiles-shard-spec.md](pmtiles-shard-spec.md) for the design and the
measurements behind it.

## Why this shape

Workers Static Assets do not answer HTTP Range requests. A reader must fetch a
whole part file and slice it. That single fact sets every other number in the
design:

| Constraint | Value |
|---|---|
| Asset files per Worker | 100,000 |
| One asset file | 25 MiB |
| Snippet subrequests | 2 (Pro) |
| Snippet CPU | 5 ms |
| Snippet memory | 2 MB |

The chosen layout is 65,259 files: 16 KiB for the header, 2,000,000 B parts for
the tile section, 1,160 B for the metadata, and 160,000 B parts for the leaf
directories. That leaves 34,741 files of headroom and every client request needs
at most 2 subrequests.

## Cost

Asset requests are free and unlimited. Snippets cost nothing extra on paid plans.
So a tile request costs USD 0. A Worker would be billed per request.

## Layout

| File | Purpose |
|---|---|
| `shard-pmtiles.py` | Cuts the archive into parts. Also `--selftest` and `--verify`. |
| `snippet.js` | The Snippet. Answers range requests. |
| `build.mjs` | Split, verify, upload assets, minify, deploy snippet. |
| `wrangler.jsonc` | Worker name and assets directory. No `main`. |
| `snippet-test.js` | Drives the real snippet against a real split. |
| `minify-test.js` | Checks the minifier. |
| `deploy-test.js` | Checks the deploy requests against a mock API. |
| `pmtiles-shard-spec.md` | Full specification and measurements. |

## Use

Split the archive:

```sh
python3 shard-pmtiles.py basemap.pmtiles --out public --name basemap
```

The tool prints the line to paste into `ARCHIVES` in `snippet.js`.

Check the parts against the archive:

```sh
python3 shard-pmtiles.py basemap.pmtiles --out public --name basemap --verify
```

Run the local checks:

```sh
python3 shard-pmtiles.py --selftest
node snippet-test.js
node minify-test.js
node deploy-test.js
```

Or all four: `npm test`.

## Deploy

Workers Builds runs `node build.mjs` on every push to the default branch. It
splits, verifies, uploads the assets with wrangler, then minifies and deploys
the snippet.

Secrets to set in the Workers Builds configuration:

| Secret | Needed for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Both steps. Needs Workers Scripts Edit and Snippets Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Asset upload |
| `CLOUDFLARE_ZONE_ID` | Asset upload and snippet |

Set the zone in `SNIPPET_RULE`, which defaults to matching `tiles.example.com`.
See the header of `build.mjs` for every variable.

## Notes

* `wrangler.jsonc` has no `main`. Part requests are served by the assets
  platform, so no Worker runs and nothing is billed.
* Cloudflare already skips unchanged files on upload by comparing content
  hashes. Do not reimplement that.
* The default `Cache-Control` for assets forces revalidation. `_headers`,
  written by the tool, overrides it.
* The unverified risk is snippet CPU time on a tile request. Measure it with
  `wrangler tail` while loading a map. See section 12 of the spec.