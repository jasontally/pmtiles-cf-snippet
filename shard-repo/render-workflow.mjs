// Render a shard repo's refresh workflow.
//
// One workflow per shard repo, because that is what lets the refresh run without
// a credential: the workflow commits inside its own repo, and GITHUB_TOKEN can do
// that with no stored secret. A single workflow that pushed to 13 other repos
// would need a personal access token stored in GitHub, which is exactly the thing
// this design avoids.
//
// The crons are staggered by 30 minutes so only one shard builds at a time. Six
// concurrent builds saturate the upload bandwidth: of 22 builds, one was
// terminated at 31 minutes when six ran together.

/** Refresh order. Shard 0 last, because it holds head.bin and the reader takes
 * the archive layout from it. */
export const ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];

/** The window opens Sunday 00:30 UTC and the slots are 30 minutes apart. */
const FIRST_SLOT_MINUTE = 30;

/** The slot for a shard: which minute and hour its cron fires at. */
export function slotFor(index) {
  const position = ORDER.indexOf(index);
  if (position < 0) throw new Error(`shard ${index} is not in the refresh order`);
  const minutes = FIRST_SLOT_MINUTE + position * 30;
  return {
    minute: minutes % 60,
    hour: Math.floor(minutes / 60),
    cron: `${minutes % 60} ${Math.floor(minutes / 60)} * * 0`,
  };
}

export function workflowFor(index) {
  const shard = String(index).padStart(2, "0");
  const slot = slotFor(index);
  const clock = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;

  return `name: Refresh shard ${shard}

# One of 13. Each shard repo has this workflow, and the crons are staggered by
# half an hour so only one shard builds at a time. All 13 fire on Sunday, inside
# the window in which Protomaps has never published in 159 weeks of release
# history: 00:16 to 07:34 UTC.
#
# This workflow holds no credentials and needs none. It commits archive.json, and
# that commit is what starts the Cloudflare build. Cloudflare injects its own
# token where the archive is fetched, so nothing outside Cloudflare ever holds
# one, and there is no secret for this repo to leak.
#
# Most Sundays this makes no commit, because the newest eligible Protomaps build
# has not changed, and a no-commit week costs no build minutes and uploads no
# data. Skipping the commit is the point, not a side effect: a refresh is 13
# builds and 126 GB of upload.
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
      # to hold is done by the same rule in all 13 repos, so they agree without
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