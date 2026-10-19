# Monthly data refresh

## When Protomaps publishes

From `https://build-metadata.protomaps.dev/builds.json`, 62 builds from
2023-09-18 to 2026-10-08, which is 159 weeks.

| Weekday | Releases |
|---|---|
| Monday | 41 |
| Tuesday | 9 |
| Wednesday | 5 |
| Thursday | 3 |
| Friday | 2 |
| Saturday | 1 |
| Sunday | 1 |

The day looks decisive until you look at recent practice. Over the last 26 weeks
releases are spread across weekdays almost evenly, and over the last 8 weeks
there was one release every single day:

| Window | Releases | Spread |
|---|---|---|
| All 159 weeks | 62 | Mon 41, Tue 9, Wed 5, Thu 3, Fri 2, Sat 1, Sun 1 |
| Last 12 months | 29 | Mon 9, Tue 8, Wed 5, Thu 3, Fri 2, Sat 1, Sun 1 |
| Last 26 weeks | 16 | Mon 2, Tue 5, Wed 3, Thu 3, Fri 1, Sat 1, Sun 1 |
| Last 8 weeks | 7 | one every day, including Saturday and Sunday |

**The weekday is close to meaningless. The hour is everything.**

| UTC hour | Releases (all history) |
|---|---|
| 07:00 | 3 |
| 08:00 | 25 |
| 09:00 | 27 |
| 10:00 | 3 |
| 11:00 | 1 |
| 16:00 | 1 |
| 19:00 | 1 |
| all other hours | 0 |

84 % of all releases land in the 08:00 and 09:00 hours. In the last year, 27 of 29
were between 08:00 and 10:00. Only three releases in three years were outside
06:00 to 12:00 UTC:

| When | What |
|---|---|
| Mon 2023-10-02 16:47 UTC | `20231002.pmtiles` |
| Tue 2024-04-02 00:16 UTC | `20240401.pmtiles` |
| Wed 2026-05-27 19:18 UTC | `20260527.pmtiles` |

## The window

Those three outliers are what matter. They divide the day into four gaps, and the
longest is the safe one:

| Gap | Length | Releases ever inside |
|---|---|---|
| **00:16 – 07:34 UTC** | **7.3 h** | **0** |
| 11:02 – 16:47 UTC | 5.8 h | 1, on the boundary |
| 19:18 – 00:16 UTC | 5.0 h | 1, on the boundary |
| 16:47 – 19:18 UTC | 2.5 h | 2, on the boundaries |

**00:16 to 07:34 UTC is the only window that has never contained a release.**
It is also the only gap long enough for the refresh.

Six and a half hours fits 25 slots at 4 minutes, which is exactly the number of
shards. That is the whole reason for the 4 minute interval and the 6 to 7 hour
window.

Chosen: **Sunday, 00:30 to 02:10 UTC**, 25 slots of 4 minutes, and the reader
follows at 02:50. Sunday because it is tied quietest by weekday with Saturday,
one release in 159 weeks, and that one was at 08:52 UTC, well clear of the
window. As local time this is Saturday evening to Sunday early morning in the
Americas.

The window gates **starting a shard build**. Updating the reader is not gated,
because it reads the header from our own shard 0 rather than from Protomaps, so
it carries no risk of racing an upstream publish. The workflow therefore also runs
on Monday, which gives a long tail for a shard 0 that built slowly. Without the
fourteenth slot the reader would wait a week for its offsets.

The 4 hour minimum age on a Protomaps build matters more than the window. A build
is listed before it is finished being written, and a short read would produce a
corrupt archive that looks fine until someone reads a tile from the wrong place.

## How a refresh runs

There are no credentials anywhere in this part of the system. No GitHub repo holds
a Cloudflare token, and no workflow reads a secret. That is a deliberate design
choice, and it is what the rest of this section explains.

### One workflow per shard repo, not one workflow for all 25

Each of the 25 shard repos has its own `.github/workflows/refresh.yml`, with a cron
four minutes after the one before it, so the builds do not all start together:

| Slot (UTC, Sunday) | Shard |
|---|---|
| 00:30 | 01 |
| 00:34 | 02 |
| 00:38 | 03 |
| ... | ... |
| 02:02 | 24 |
| 02:06 | 00 |

Shard 0 goes last on purpose. It holds `head.bin`, and the reader takes the
archive layout from it. The reader's offsets must not change before the other
shards hold the new archive, because a reader that points at a new archive
while the shards still hold the old one finds no tiles at all.

The reader's own workflow runs at 02:50, right after the last shard starts, and
again at 07:07 and on Monday at 04:07. The later runs are for a shard 0 that
built slowly, or a Sunday where the schedule ran late.

Twenty-five separate crons are the price of holding no key. A single workflow in
this repo that pushed to 25 other repos would need a personal access token with
write access to all of them, stored in GitHub. Twenty-five workflows, each
committing to its own repo with the automatic `GITHUB_TOKEN`, need nothing stored
anywhere. The alternative also fails harder: a PAT in a repo is a credential that
can leak, and this one would be in 25 places.

### The commit is the trigger

Each workflow runs `refresh.mjs`, which decides whether a newer Protomaps build
exists, writes `archive.json`, and exits. The workflow commits it. The commit is
what Cloudflare Workers Builds reacts to, and the build reads the archive named in
`archive.json`.

That is why the archive URL is not a Cloudflare build variable. It used to be. A
build variable cannot be changed by a GitHub Actions workflow without a Cloudflare
token, so a refresh driven that way needs a credential. Moving the URL into
`archive.json` makes the file the payload and the commit the message, and the
token disappears. `wire-shards.mjs` deletes any `ARCHIVE_URL` variable it finds,
because one left in place would outrank the file on every build: the workflow
would commit the new key and the build would then fetch the old archive, silently.

### How 25 repos agree on one build, with no shared state

Each repo computes its target independently. "The newest build" would give 25
different answers if a Protomaps build landed partway through the window and some
shards had already run. Half the shards would then hold one archive and half
another, and the reader could not tell which is which.

The answer is anchored to a fixed point instead:

> the newest Protomaps build published before the most recent Sunday 00:30 UTC

Every repo computes the same anchor, so every repo computes the same target,
whatever minute of the window it fires at. A build that appears mid-window is
ignored until the following week. There is no state file, no coordination, and no
ordering to get wrong. `shard-repo/refresh.test.mjs` checks this directly by
running the rule at all 25 slot times and asserting one answer.

There is a second rule underneath it: a build must be at least 4 hours old before
we cut parts from it. Protomaps lists a build before it has finished writing it,
and a short read gives parts that are the right length and the wrong bytes, which
no size check catches. The anchor already keeps a build days old, so this is a
second line of defence, and the script refuses rather than proceeding if it fails.

### Most months nothing happens

If the target equals what the shard already holds, `refresh.mjs` reports no change
and makes no commit, so no build runs and nothing uploads. A refresh is 25 builds
and 138 GB, so skipping it on a month when Protomaps has not published is the
point rather than a side effect. `workflow_dispatch` with `force: true` rebuilds
anyway.

### The reader follows afterwards

`.github/workflows/sync-reader.yml` in this repo runs twice on Sunday and once on
Monday, and calls `tools/sync-reader.mjs`. It reads `head.bin` from shard 0
over plain HTTP and compares the offsets the reader holds. If they differ it
rewrites them in `snippet.js` and commits, and this repo's build deploys the
Snippet.

It has no state and no record of which build was chosen. It reads what shard 0
actually serves and compares, so a missed refresh, a failed shard, or a window that
never ran all leave it correct, because there is nothing to remember.

It also cannot run too early. Until shard 0 has been rebuilt it still serves the
old header, the offsets still agree, and the script correctly does nothing. That
makes it safe to run often and often wrong. The later runs are there for a shard
0 that built slowly, or a Sunday where the schedule ran late.

### Holding builds while the template is pushed

`wire-shards.mjs --hold` sets `branch_includes` to a branch nothing is pushed to,
so a push to `main` starts no build. `--release` puts `main` back. There is no
pause endpoint in the Builds API, and the branch list is the only lever available.

This matters because a template push to 25 repos starts 25 builds, and one of
them was terminated at 31 minutes when six ran together, against a 30 minute
ceiling. So a template push goes out while builds are held and the next real
build is triggered deliberately.

## Builds get longer as the archive grows

Upload cost is 90 s per GB plus 0.055 s per file. The archive is now 138.9 GB, not
the 118 GiB it was when the shard count was chosen, so a shard build is about
5.5 GB and 5,544 files.

Measured on 19 October 2026, with one build at a time, a shard build takes 8 to
15 minutes. The download is 5.54 GB and runs at 17 to 95 MB/s. The upload is
5,544 files and takes 2 to 11 minutes, because Cloudflare skips the files whose
content hash it already holds.

## What the failures on 18 October 2026 were

Three of 25 shards failed, and the shards they held stayed on the old archive
until a person noticed a day later. The build logs say why:

| Shard | Queued for | Ran for | Result |
|---|---|---|---|
| 16 | 28 min | 31 min | killed at 3,525 of 5,544 files uploaded |
| 23 | 17 min | 31 min | killed during the download |
| 24 | 21 min | 7 min | the download connection dropped |

The queue was long because the account runs 6 builds at a time and all 25
started within 4 minutes of each other. The kill was at 30 minutes, which is
the limit on the build command, and the account allows 6,000 build minutes a
month, so the minutes were never the constraint.

The download was the real problem. Two builds got 4 MB/s where the others got
64 to 95 MB/s at the same time, so it was a slow connection and not a busy
origin. One build alone got 17 MB/s and the next got 59. The rate is not
predictable.

Three things answer that, and they are in the shard template now:

1. The download carries a deadline. When the rate falls under 8 MB/s the request
   is abandoned and a new one starts from the byte the last one reached. The
   part files are appended to, so the bytes already written are kept.
2. The crons are staggered by four minutes, so the builds do not all start at
   once and the queue stays short.
3. Each shard repo has a verify workflow that checks the shard after the
   refresh, and starts the build again when the check fails. The check asks the
   shard for the last part of the range it should own, because a shard that
   still holds the old archive has no such part. It holds no credential, and
   the commit is what starts the build.

The third one is the important one. The first two make a failure less likely.
The third one makes a failure cost minutes instead of a day.

## The transitional window, stated plainly

Between the first shard refreshing and the reader being updated, the shards hold
two different archives at once. The reader is where that shows. Its byte offsets
name the parts, and the mapping from a part number to a shard changes when the
archive grows, because the parts per shard grow with it. A reader that still
has the old offsets asks a shard for a part that shard no longer holds, and the
answer is a 404 that reaches the client as a 502.

So the window is not a mix of old and new tiles. It is a map with holes, and the
holes sit where the refreshed shards are. The window ends when the reader is
published with the new offsets, which is why shard 0 goes last: until then the
reader and shard 0 still agree, and the reader serves the old archive for the
shards that still hold it.

The two generation layout below is the only way to remove the window. With it
the new archive is built into a second set of Workers, the reader is flipped
once, and the first set is rebuilt afterwards. The window becomes one reader
change.

The window is roughly two hours. Two ways to remove it:

- **Two generations.** Build the new archive into a second set of 25 Workers
  while the first set keeps serving, flip the reader, then rebuild the first set
  for the following week. Correct with no window, at the cost of 25 more Workers,
  25 more hostnames, and a host table of 50 in the reader. The same 25 repos can
  deploy to two Workers each by running `wrangler deploy` twice with different
  config files.
- **Shorter window.** Run the shards in batches instead of one at a time. The
  batches overlap, and one of 25 builds was killed at 31 minutes when six ran
  together.

Neither is built. The current setup uses one shard per slot because it is the one
that will not kill builds.

The one shard per slot schedule is not only a bandwidth decision. Each shard's slot
is also its own workflow's cron, so the staggering falls out of the credential-free
design rather than being added on top of it. The two generation layout would need
25 more Workers and would keep the same 25 workflows.

## What is not stored anywhere

No credential is involved in a refresh, at any stage:

| Where | What it holds | Why it is safe |
|---|---|---|
| 25 shard repos | nothing | the workflows commit with `GITHUB_TOKEN`, which GitHub issues per run |
| this repo | nothing | `sync-reader.yml` reads a public header over plain HTTP |
| Cloudflare build | `CLOUDFLARE_API_TOKEN` | Cloudflare injects it into the build itself |
| `wire-shards.mjs` | the token, from the environment | it is run by a person, never by a schedule |

The only token in the system is the one Cloudflare gives its own builds. A GitHub
Actions workflow has no Cloudflare token and needs none.

The cost of moving the archive URL out of a build variable is that `wire-shards.mjs`
must now delete a stale `ARCHIVE_URL` if it finds one, and it does. That variable
outranks `archive.json` on every build, so leaving it would mean the refresh commits
a new key and the build fetches the old archive, with nothing in the logs to say so.