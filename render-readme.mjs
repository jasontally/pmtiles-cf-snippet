// Render a shard repo README. Shared by make-repos.mjs and fill-shards.sh, so
// the two cannot describe a shard differently.

const REPO_PREFIX = "pmtiles-shard";
const TILE_PARTS_PER_SHARD = 4864;

const repoName = (index) => `${REPO_PREFIX}-${String(index).padStart(2, "0")}`;

export function readmeFor(index, worker) {
  const first = index * TILE_PARTS_PER_SHARD;
  const last = (index + 1) * TILE_PARTS_PER_SHARD - 1;
  return `# ${repoName(index)}

One shard of the Protomaps basemap. The archive is 118 GiB and a Workers
Builds container has 20 GB of disk, so the archive is split across 13 of these
repos. This one holds shard ${index}, tile parts ${first} to ${last}.

Shard 0 also holds \`head.bin\`, \`meta.bin\`, and the leaf directories, which
together are 324.9 MB. Every other shard is pure tile data.

Read the design and the arithmetic in
[pmtiles-cf-snippet](https://github.com/jasontally/pmtiles-cf-snippet), file
\`sharding.md\`.

## Deploy

This repo is already wired to the Worker \`${worker}\` in Workers Builds. The
build variables and the build and deploy commands are set through the API by
\`wire-shards.mjs\` in pmtiles-cf-snippet. Nothing needs doing by hand.

For reference, the settings are:

| Setting | Value |
|---|---|
| \`ARCHIVE_URL\` | the dated .pmtiles URL. It must support HTTP Range |
| \`SHARD_INDEX\` | \`${index}\` |
| \`SHARD_COUNT\` | \`13\` |
| Build command | \`npm run build\` |
| Deploy command | \`npx wrangler deploy\` |

A push to \`main\` starts a build. The build command downloads only this shard's
bytes and writes them to \`public/\`. The deploy command uploads them with
wrangler, which skips any part whose content hash Cloudflare already holds, so a
rebuild uploads almost nothing.

## Check the plan without downloading

\`\`\`sh
npm run dry-run
\`\`\`

Prints the part count, the byte ranges it will fetch, and the first three parts.
Downloads 16 KB, no more.
`;
}

// Also usable directly: node render-readme.mjs 12 pmtiles-shard-12
if (import.meta.url === `file://${process.argv[1]}`) {
  const index = Number(process.argv[2] ?? 0);
  const repo = process.argv[3] ?? `pmtiles-shard-${String(index).padStart(2, "0")}`;
  const worker = process.argv[4] ?? repo;
  process.stdout.write(readmeFor(index, worker));
}
