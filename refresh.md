# Weekly data refresh

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

Six and a half hours fits 13 slots at 30 minutes, which is exactly the number of
shards. That is the whole reason for the 30 minute interval and the 6 to 7 hour
window.

Chosen: **Sunday, 00:30 to 07:30 UTC**. That is 14 half hour slots: twelve
refresh shards 1 to 12, one refreshes shard 0 at 06:30, and the last updates the
reader at 07:00. Sunday because it is tied quietest by weekday with Saturday, one
release in 159 weeks, and that one was at 08:52 UTC, well clear of the window. As
local time this is Saturday evening to Sunday early morning in the Americas.

The window gates **starting a shard build**. Updating the reader is not gated,
because it reads the header from our own shard 0 rather than from Protomaps, so
it carries no risk of racing an upstream publish. The workflow therefore also runs
on Monday, which gives a long tail for a shard 0 that built slowly. Without the
fourteenth slot the reader would wait a week for its offsets.

The 4 hour minimum age on a Protomaps build matters more than the window. A build
is listed before it is finished being written, and a short read would produce a
corrupt archive that looks fine until someone reads a tile from the wrong place.

## How a refresh runs

`.github/workflows/refresh-tiles.yml` runs every 30 minutes on Sunday and calls
`tools/refresh-tiles.mjs`. The script refuses to act outside 00:30 to 07:00 UTC,
so the window is enforced in one place and can be changed without touching the
cron. That also lets the cron be broad and cheap: 48 runs a week, of which about
14 do work.

| Slot (UTC) | Action |
|---|---|
| 00:30 to 05:30 | refresh shards 1 to 12, one per slot |
| 06:00 | refresh shard 0, which holds the header |
| 06:30 | update the reader's byte offsets to match the new archive |

Shard 0 goes last on purpose. It holds `head.bin`, and the reader advertises the
archive layout from it. Leaving it on the old archive until the end keeps clients
on a consistent layout for as long as possible.

The target build is pinned once per cycle and written to `data/refresh.json`. If a
newer Protomaps build appears mid-window the cycle keeps using the pinned one, so
every shard ends up on the same bytes. That is the guarantee the quiet window
cannot give on its own.

## Builds get longer as the archive grows

Upload cost is 90 s per GB plus 0.055 s per file. The archive is now 138.7 GB, not
the 118 GiB it was when the shard count was chosen, so a shard build is about
10.5 GB and roughly 7,300 files.

That puts a single build near 25 minutes. One of 22 builds was terminated at 31
minutes when six ran together, so the margin is thin and it will get thinner. This
is the strongest argument yet for the two generation layout below: refreshing half
the Workers a week halves the bytes in each build.

## The transitional window, stated plainly

Between the first shard refreshing and the reader being updated, the shards hold
two different archives at once. A tile request for a refreshed shard is answered
from the new archive, and it returns a valid tile, but not always the tile the
client asked for.

It is not corruption and not a blank map. Tile parts are cut at the same 2,000,000
byte boundaries in both archives, and tile data starts at byte 16,384 in both, so
the reader computes the same part number and the same offset within the part for a
given archive offset. It reads a different tile only where the data between the two
builds actually changed.

The window is roughly six hours. Two ways to remove it:

- **Two generations.** Build the new archive into a second set of 13 Workers
  while the first set keeps serving, flip the reader, then rebuild the first set
  for the following week. Correct with no window, at the cost of 13 more Workers,
  13 more hostnames, and a host table of 26 in the reader. The same 13 repos can
  deploy to two Workers each by running `wrangler deploy` twice with different
  config files.
- **Shorter window.** Run 3 shards at a time instead of one. Four batches of about
  22 minutes is about an hour and a half instead of six, but concurrent builds
  slow each other down, and one of 22 builds was killed at 31 minutes when six
  ran together.

Neither is built. The current workflow uses the one-shard-per-slot window because
it is the one that will not kill builds.