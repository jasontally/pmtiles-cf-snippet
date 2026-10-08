#!/usr/bin/env node
/**
 * Create one GitHub repo per shard and push the shard template into each.
 *
 * 13 repos rather than 13 branches of one repo. Branches are awkward to keep
 * long term and some GitHub features behave badly when 13 of them all track the
 * same file set.
 *
 * Each repo holds the same code and differs only in the Worker name inside
 * wrangler.jsonc, which must match the Worker in the Cloudflare dashboard or
 * the build fails.
 *
 * Dry run first, it sends nothing:
 *   node make-repos.mjs --dry-run
 *
 * To create them:
 *   node make-repos.mjs
 *
 * To push an updated template to repos that already exist:
 *   node make-repos.mjs --update
 *
 * Needs the GitHub CLI, authenticated, with permission to create repositories.
 */

import { spawnSync } from "node:child_process";
import { workflowFor, slotFor } from "./shard-repo/render-workflow.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(ROOT, "shard-repo");

const SHARD_COUNT = 13;
const WORKER_PREFIX = "pmtiles-shard";
const REPO_PREFIX = "pmtiles-shard";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const dryRun = process.argv.includes("--dry-run");
const updateOnly = process.argv.includes("--update");

function workerName(index) {
  return `${WORKER_PREFIX}-${String(index).padStart(2, "0")}`;
}
function repoName(index) {
  return `${REPO_PREFIX}-${String(index).padStart(2, "0")}`;
}

function gh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    ...options,
  });
  if (options.cwd) result.cwd = options.cwd;
  if (result.error) fail(`gh ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`gh ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

function fail(message) {
  console.error(`\nmake-repos failed: ${message}`);
  process.exit(1);
}

/** Confirm the template is present and the tests pass, so no repo gets broken code. */
function preflight() {
  for (const file of ["build.mjs", "wrangler.jsonc", "package.json", ".gitignore"]) {
    try {
      readFileSync(join(TEMPLATE, file));
    } catch {
      fail(`shard-repo/${file} is missing`);
    }
  }
  const test = spawnSync("node", [join(TEMPLATE, "shard-build.test.mjs")], {
    encoding: "utf8",
  });
  if (test.status !== 0) {
    fail(`the shard build tests failed, so the repos were not created:\n${test.stdout}${test.stderr}`);
  }
  console.log(`shard build tests: ${(test.stdout || "").trim()}`);
}

/** Copy the template into a fresh directory with the Worker name filled in. */
function stage(index) {
  const dir = mkdtempSync(join(tmpdir(), `shard-${index}-`));
  cpSync(TEMPLATE, dir, { recursive: true });
  // The template is copied whole, then the per shard workflow is written over it.
  rmSync(join(dir, ".github"), { recursive: true, force: true });
  // render-workflow.mjs exists to generate the workflow above, in this repo. In a
  // shard repo it would be dead code that looks like it does something.
  rmSync(join(dir, "render-workflow.mjs"), { force: true });
  const worker = workerName(index);
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, readFileSync(config, "utf8").replace("SHARD_WORKER_NAME", worker));

  const pkg = join(dir, "package.json");
  writeFileSync(
    pkg,
    readFileSync(pkg, "utf8").replace(
      '"name": "pmtiles-shard"',
      `"name": "${repoName(index)}"`
    )
  );

  const readme = join(dir, "README.md");
  writeFileSync(readme, readmeFor(index, worker));

  // The refresh workflow, with this shard's half hour slot. It lives in the shard
  // repo rather than in this one so the refresh needs no credential: a workflow
  // that pushed to 13 other repos would need a personal access token stored in
  // GitHub, which is the thing this design exists to avoid.
  const workflow = join(dir, ".github", "workflows", "refresh.yml");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(workflow, workflowFor(index));

  return dir;
}

function readmeFor(index, worker) {
  const first = index * 4864;
  const last = (index + 1) * 4864 - 1;
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

\`wrangler.jsonc\` names the Worker \`${worker}\`, which must match the Worker in
the Cloudflare dashboard.

Set these as build variables in the Cloudflare dashboard:

| Variable | Value |
|---|---|
| \`SHARD_INDEX\` | \`${index}\` |
| \`SHARD_COUNT\` | \`13\` |

The archive itself comes from \`archive.json\` in this repo, not from a build
variable. That is deliberate: \`.github/workflows/refresh.yml\` commits a newer
Protomaps build there, the commit starts this build, and nothing outside
Cloudflare needs a credential. See refresh.md in pmtiles-cf-snippet.

Set these commands under **Settings > Build**:

| Setting | Value |
|---|---|
| Build command | \`npm run build\` |
| Deploy command | \`npx wrangler deploy\` |

This shard's refresh slot is **${slotFor(index).hour}:${String(slotFor(index).minute).padStart(2, "0")} UTC on Sunday**.

The build command downloads only this shard's bytes and writes them to
\`public/\`. The deploy command uploads them with wrangler, which skips any part
whose content hash Cloudflare already holds.

## Check the plan without downloading

\`\`\`sh
npm run dry-run
\`\`\`

Prints the part count, the byte range, and the first three parts. Downloads
nothing.
`;
}

function main() {
  preflight();

  const owner = gh(["repo", "view", "--json", "owner", "-q", ".owner.login"]);
  console.log(`\nGitHub account ${owner}`);

  if (dryRun) {
    console.log(`\n${SHARD_COUNT} repos under ${owner}:`);
    console.log(`${"shard".padEnd(6)}${"repo".padEnd(20)}${"worker".padEnd(20)}tile parts`);
    for (let i = 0; i < SHARD_COUNT; i++) {
      console.log(
        `${String(i).padEnd(6)}${repoName(i).padEnd(20)}${workerName(i).padEnd(20)}` +
        `${i * 4864}..${(i + 1) * 4864 - 1}`
      );
    }
    console.log("\n--dry-run: nothing was created.");
    return;
  }

  let created = 0;
  let updated = 0;
  const failed = [];

  for (let i = 0; i < SHARD_COUNT; i++) {
    const repo = repoName(i);
    const dir = stage(i);

    try {
      // A repo that already exists is updated, so re-running is safe and picks
      // up template fixes.
      const exists = spawnSync("gh", ["repo", "view", `${owner}/${repo}`], {
        encoding: "utf8",
      }).status === 0;

      // Created from the staged directory, and without --source or --remote.
      // --source=. would use this repo's directory, and --remote=origin would
      // collide with the remote that already exists here.
      if (!exists) {
        gh(["repo", "create", repo, "--public", "--description",
          `Shard ${i} of the Protomaps basemap PMTiles archive, served from Cloudflare Static Assets`],
          { cwd: dir });
        created++;
        console.log(`created  ${repo}`);
      } else if (!updateOnly) {
        console.log(`exists   ${repo}, updating the template anyway`);
      }

      // Push the staged template over whatever is there.
      // options carries `input`, which spawnSync needs for a commit message on
      // stdin. Dropping it makes the commit fail with an empty message.
      const git = (args, options = {}) => {
        const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", ...options });
        if (r.status !== 0) fail(`git ${args.join(" ")}:\n${r.stderr || r.stdout}`);
      };
      git(["init", "-q", "-b", "main"]);
      git(["add", "-A"]);
      git(["-c", "user.name=Jason Tally",
        "-c", "user.email=719178+jasontally@users.noreply.github.com",
        "commit", "-q", "-F", "-"], {
        input: `Shard ${i} of the Protomaps basemap archive.\n\nHolds tile parts ${i * 4864} to ${(i + 1) * 4864 - 1}.\n${
          i === 0
            ? "\nAlso holds head.bin, meta.bin, and the leaf directories, which\ntogether are 324.9 MB.\n"
            : ""
        }The build downloads only this shard's bytes with an HTTP Range request\nand writes them to public/, then wrangler uploads them. Wrangler skips any\npart whose content hash Cloudflare already holds.\n\nSee sharding.md in jasontally/pmtiles-cf-snippet.\n`,
      });
      git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
      git(["push", "-q", "--force", "origin", "main"]);
      if (exists) updated++;
      console.log(`pushed   ${repo}`);
    } catch (error) {
      failed.push(`${repo}: ${error.message}`);
      console.error(`FAILED   ${repo}: ${error.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\ncreated ${created}, updated ${updated}, failed ${failed.length}`);
  if (failed.length) {
    console.log("\nfailures:");
    for (const message of failed) console.log(`  ${message}`);
    process.exit(1);
  }
  console.log(`\nNext: node wire-shards.mjs  to bind each ${repoName(0)}..${repoName(12)}`);
  console.log("to its Worker and set ARCHIVE_URL, SHARD_INDEX, and SHARD_COUNT.");
}

main();