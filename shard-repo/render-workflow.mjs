// Render a shard repo's refresh workflow.
//
// One workflow per shard repo, because that is what lets the refresh run without
// a credential: the workflow commits inside its own repo, and GITHUB_TOKEN can do
// that with no stored secret. A single workflow that pushed to 25 other repos
// would need a personal access token stored in GitHub, which is exactly the thing
// this design avoids.
//
// The crons are staggered so the builds do not all start at once. A build takes
// 8 to 30 minutes, and the account runs 6 at a time, so 25 builds that start
// together spend most of their time queued, and the ones at the back of the
// queue can run out of time. Three of them did on 18 October 2026.

/**
 * Refresh order. Shard 0 goes last: it holds the head, and the reader takes the
 * archive layout from it, so the reader's offsets must not change before the
 * other shards hold the new archive. A reader that points at a new archive
 * while the shards still hold the old one finds no tiles at all.
 */
export const ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 0];

/** The first slot is at 00:30 UTC, inside the window Protomaps never publishes in. */
const FIRST_SLOT_MINUTE = 30;

/** Each shard starts this many minutes after the one before it. */
const SLOT_MINUTES = 4;

/** The slot for a shard: its own minute, so no two shards start together. */
export function slotFor(index) {
  const position = ORDER.indexOf(index);
  if (position < 0) throw new Error(`shard ${index} is not in the refresh order`);
  const total = FIRST_SLOT_MINUTE + position * SLOT_MINUTES;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return { minute, hour, cron: `${minute} ${hour} 1-7 * 0` };
}

export function workflowFor(index) {
  const shard = String(index).padStart(2, "0");
  const slot = slotFor(index);
  const clock = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;

  return `name: Refresh shard ${shard}

# One of 25. Each shard repo has this workflow, and the crons are staggered by
# four minutes so the builds do not all start at once. All 25 fire on Sunday,
# inside the window in which Protomaps has never published in 159 weeks of
# release history: 00:16 to 07:34 UTC.
#
# This workflow holds no credentials and needs none. It commits archive.json, and
# that commit is what starts the Cloudflare build. Cloudflare injects its own
# token where the archive is fetched, so nothing outside Cloudflare ever holds
# one, and there is no secret for this repo to leak.
#
# Most Sundays this makes no commit, because the newest eligible Protomaps build
# has not changed, and a no-commit week costs no build minutes and uploads no
# data. Skipping the commit is the point, not a side effect: a refresh is 25
# builds and 138 GB of upload.
on:
  schedule:
    - cron: '${slot.cron}'
  workflow_dispatch:
    inputs:
      force:
        description: Rebuild even if the archive has not changed
        type: boolean
        default: false

permissions:
  contents: write

# One refresh per shard repo at a time. A queued run is left to finish rather than
# cancelled, because a run cancelled after committing but before the build starts
# would leave the next run thinking there was nothing to do.
concurrency:
  group: refresh-shard-${shard}
  cancel-in-progress: false

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      # Shard ${shard} has the ${clock} UTC slot on Sunday. Working out which build
      # to hold is done by the same rule in all 25 repos, so they agree without
      # talking to each other. See the header of refresh.mjs.
      - name: Decide which archive to hold
        id: decide
        run: node refresh.mjs \${{ inputs.force == true && '--force' || '' }}

      - name: Commit the archive choice
        if: \${{ steps.decide.outputs.changed == 'true' }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add archive.json
          git commit -q -m "chore: refresh to $(node -p "require('./archive.json').key")"
          git push

      # The commit is the trigger. Workers Builds rebuilds this shard from the
      # archive named in archive.json, and Cloudflare injects the token it needs.
      - name: Report
        if: \${{ always() }}
        run: echo "shard ${shard}, slot ${clock} UTC on Sunday"
`;
}

/**
 * Render a shard repo's verify workflow.
 *
 * A shard build can fail, and when it does the shard keeps the old archive.
 * The reader then asks it for parts it does not have, and the map loses every
 * tile in that shard's range. This workflow checks, and starts the build again
 * if the check fails. It holds no credentials and needs none: the commit is
 * what starts the build.
 *
 * The first run is late enough for the refresh builds to have finished, and the
 * later runs are the backstops. The Monday run is there for a Sunday that went
 * wrong, which is how three shards stayed on the old archive for a day.
 */
export function verifyFor(index) {
  const shard = String(index).padStart(2, "0");
  return `name: Verify shard ${shard}

# A shard build can fail. The download can die, the build can hit its 30 minute
# limit, and the upload can run out of time. The shard then keeps the old
# archive, and the reader asks it for parts it does not have, so the map loses
# the tiles in that range.
#
# On 18 October 2026 three of 25 shards failed, and nothing noticed for a day.
# This workflow is what notices.
#
# It holds no credentials and needs none. The archive header and the shard are
# both read over plain HTTP. The commit is what starts the build.
on:
  schedule:
    - cron: '17 5 1-7 * 0'
    - cron: '23 9 1-7 * 0'
    - cron: '31 4 1-7 * 1'
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: verify-shard-${shard}
  cancel-in-progress: false

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Check the shard
        run: node verify-shard.mjs ${index}

      # The check writes archive.json when the shard is stale. The commit is the
      # trigger, so the build runs again.
      - name: Start the build again
        run: |
          if git diff --quiet -- archive.json; then
            echo "the shard holds the archive, so there is nothing to do"
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add archive.json
          git commit -q -m "chore: rebuild the shard, the last build did not finish"
          git push
`;
}