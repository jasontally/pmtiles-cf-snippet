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
| `snippet-rules.mjs` | Pure helpers for the zone-wide snippet rule list. |
| `snippet-rules.test.mjs` | Tests that the merge cannot drop another rule. |
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

Workers Builds runs two commands on every push. Set these in
**Settings > Build**:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |

`npm run build` runs `node build.mjs prepare`. It splits the archive, verifies
every part against the archive byte for byte, and minifies the snippet into
`dist/snippet.min.js`. It deploys nothing.

`npm run deploy` runs `node build.mjs deploy`. It uploads the assets with
wrangler, then uploads the snippet and sets its rule. The snippet goes second,
so the parts are in place before the URL starts answering range requests.

### The deploy command must be `npm run deploy`

This is the answer to the question "does the snippet deploy yet". It does not,
while the deploy command is `npx wrangler deploy`.

Wrangler deploys a Worker. A snippet is not part of a Worker. A snippet is a
zone resource and needs the Snippets API. So `npx wrangler deploy` uploads the
asset parts and nothing else, and `tiles.jasontally.com/basemap.pmtiles` keeps
returning `404`.

Do not put the snippet upload in the build command instead. A preview build runs
the build command, and a preview runs for every branch except `main`. The snippet
would then be overwritten from a preview branch.

If the dashboard refuses a custom deploy command, use this pairing as a fallback:

| Setting | Value |
|---|---|
| Build command | `npm run build:snippet` |
| Deploy command | `npx wrangler deploy` |

It works, but it uploads the snippet before the assets. A range request during
the gap returns `502` rather than `404`.

The name in `wrangler.jsonc` must match the Worker name in the dashboard, or the
build fails. It is `pmtiles-cf-snippet`.

`public/_headers` is committed. Wrangler refuses to deploy when the assets
directory is missing, and the directory would be missing on every build until an
archive is uploaded. The 65,259 part files stay out of the repository.

### Build settings

**Do not add `CLOUDFLARE_API_TOKEN` as a build variable.** Workers Builds injects
that name itself for the token it holds. Setting it would replace Cloudflare's
own token. The build command reads the same value, so nothing needs adding.

`CLOUDFLARE_ZONE_ID` and `SNIPPET_HOST` are enough. `SNIPPET_HOST` sets the
rule; `CLOUDFLARE_ZONE_ID` skips the zone lookup. `CLOUDFLARE_ACCOUNT_ID` is
accepted and not used, because wrangler reads its own credentials.

The token needs Workers Scripts Edit for the assets and Snippets Edit for the
snippet. Note that the Wrangler OAuth token from `npx wrangler login` is not
enough: it gets `Authentication error` code 10000 on `GET /zones/{id}/snippets`.

Set `SNIPPET_RULE` instead of `SNIPPET_HOST` only when the rule must differ from
a host match plus a `.pmtiles` path.

### This zone is shared

`PUT /zones/{id}/snippets/snippet_rules` **replaces the whole rule list.** It is
not a per-rule update. The zone also runs the `icanhazip` snippet and the
`mcp_lookup` snippet from
[mac-address-lookup](https://github.com/jasontally/mac-address-lookup). A build
that sent only its own rule would delete both, and the API answers `200` with
the shortened list, so the loss is silent.

So the build:

1. Reads the current list.
2. Merges its own rule in place, keeping the position it already has.
3. Strips the read-only `id` and `last_updated` fields, which the API rejects.
4. Skips the write when the list already matches.
5. Reads the list back and reports any rule that vanished. A lost rule fails
   the build with the names.

`snippet-rules.mjs` holds that logic as pure functions, and
`snippet-rules.test.mjs` has 13 tests on it. The deploy checks add two more
against a mock API that returns two foreign rules.

Check the setup without waiting for a build:

```sh
npm run doctor
```

It prints which variables are set without printing any value, verifies the token,
resolves the zone, and lists every rule on the zone split into ours and owned by
others. It never deploys.

To upload the asset parts, set `ARCHIVE_URL` to the `.pmtiles` URL or
`ARCHIVE_PATH` to a file on the build machine. Without either, the build skips
the split and deploys the snippet only.

## Notes

* `wrangler.jsonc` has no `main`. Part requests are served by the assets
  platform, so no Worker runs and nothing is billed.
* Cloudflare already skips unchanged files on upload by comparing content
  hashes. Do not reimplement that.
* The default `Cache-Control` for assets forces revalidation. `_headers`,
  written by the tool, overrides it.
* The unverified risk is snippet CPU time on a tile request. Measure it with
  `wrangler tail` while loading a map. See section 12 of the spec.