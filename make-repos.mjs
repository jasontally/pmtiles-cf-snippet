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
 * A GitHub push is the only way a shard repo changes. It is also what starts the
 * Cloudflare build, because Workers Builds watches the repo, so nothing here
 * deploys to Cloudflare and nothing here calls the Cloudflare API.
 *
 * An existing repo is cloned, its own history is pulled, the template is copied
 * over it, and the result is pushed as a normal commit. The push is never forced:
 * a force push would throw away whatever GitHub changed since the last update.
 *
 *   node make-repos.mjs --update --only 0    # one shard, for a test
 *
 * Needs the GitHub CLI, authenticated, with permission to create repositories.
 */

import { spawnSync } from "node:child_process";
import { verifyFor, workflowFor, slotFor } from "./shard-repo/render-workflow.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(ROOT, "shard-repo");

const SHARD_COUNT = 25;
const WORKER_PREFIX = "pmtiles-shard";
const REPO_PREFIX = "pmtiles-shard";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const dryRun = process.argv.includes("--dry-run");
const updateOnly = process.argv.includes("--update");
// A comma separated list of shard indexes, for a test run on one or two repos.
const only = arg("only", null);
const onlySet = only === null ? null : new Set(only.split(",").map((s) => Number(s.trim())));
if (onlySet && [...onlySet].some((i) => !Number.isInteger(i) || i < 0 || i >= SHARD_COUNT)) {
  console.error(`--only takes shard indexes from 0 to ${SHARD_COUNT - 1}, got ${only}`);
  process.exit(1);
}

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

/**
 * Stop the run. When the file is run it exits; when a test imports it, it throws
 * so the test can assert on the message instead of losing the process.
 */
function fail(message) {
  const text = `make-repos failed: ${message}`;
  if (process.argv[1] && process.argv[1].endsWith("make-repos.mjs")) {
    console.error(`\n${text}`);
    process.exit(1);
  }
  throw new Error(text);
}

/** The file's text, or null when it is not there. */
function readIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
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

/**
 * Copy the template into a directory, with the per shard values filled in.
 *
 * The directory is the clone of the shard repo when one exists, so the template
 * lands on top of the repo's own files and its own history. A new repo gets a
 * fresh directory.
 */
export function stage(index, dir = null) {
  // Read the shard's own archive.json before the template lands on top of it.
  // The clone is a copy, so the copy is the only record of what the shard holds.
  const updating = dir !== null;
  const ownArchive = updating ? readIfPresent(join(dir, "archive.json")) : null;
  dir = dir ?? mkdtempSync(join(tmpdir(), `shard-${index}-`));
  cpSync(TEMPLATE, dir, { recursive: true });
  // The template is copied whole, then the per shard workflow is written over it.
  rmSync(join(dir, ".github"), { recursive: true, force: true });
  // This test belongs to the template push, which runs in this repo. In a shard
  // repo there is no make-repos.mjs to test.
  rmSync(join(dir, "make-repos.test.mjs"), { force: true });
  // render-workflow.mjs exists to generate the workflow above, in this repo. In a
  // shard repo it would be dead code that looks like it does something.
  rmSync(join(dir, "render-workflow.mjs"), { force: true });
  const worker = workerName(index);
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, readFileSync(config, "utf8").replace("SHARD_WORKER_NAME", worker));

  // The archive a shard holds is the shard's own state, and the refresh workflow
  // owns it. The template holds a seed key from 2024, so copying the template
  // over a refreshed shard would put the seed back, and the build would then
  // serve two year old data. The shard's own file is put back as it was.
  //
  // A missing shard archive.json is an error, not a reason to delete the file.
  // On 7 November 2026 an earlier version of this function deleted it, and the
  // shard lost the record of the build it holds. A shard repo always has the
  // file, so its absence here means something is wrong.
  if (updating && ownArchive === null) {
    fail(`${dir} has no archive.json, so the shard would lose the build it holds`);
  }
  // A new repo keeps the template's seed, because it has nothing of its own yet.
  if (updating) writeFileSync(join(dir, "archive.json"), ownArchive);

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

  // The refresh workflow, with this shard's slot. It lives in the shard repo
  // rather than in this one so the refresh needs no credential: a workflow
  // that pushed to 25 other repos would need a personal access token stored in
  // GitHub, which is the thing this design exists to avoid.
  const workflow = join(dir, ".github", "workflows", "refresh.yml");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(workflow, workflowFor(index));

  // The verify workflow, which checks this shard and starts the build again if
  // the last build did not finish. It needs no credential either.
  writeFileSync(join(dir, ".github", "workflows", "verify.yml"), verifyFor(index));

  return dir;
}

/**
 * The tile parts each shard holds, for the README and the commit message.
 *
 * It grows with the archive: the parts per shard are the total parts over the
 * shard count, and the total parts grow as the archive grows. It was 5,537 for
 * the 20261010 archive and 5,544 for 20261017.
 */
const PARTS_PER_SHARD = 5544;

function readmeFor(index, worker) {
  const first = index * PARTS_PER_SHARD;
  const last = (index + 1) * PARTS_PER_SHARD - 1;
  return `# ${repoName(index)}

One shard of the Protomaps basemap. The archive is about 140 GB and a Workers
Builds container has 20 GB of disk, so the archive is split across 25 of these
repos. This one holds shard ${index}, tile parts ${first} to ${last}.

The deploy command retries \`npx wrangler deploy\` three times, because the asset
upload fails transiently with Cloudflare API error 10013 on large sets. The retry
is seconds; a failed build is a week of stale data.

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
        `${i * PARTS_PER_SHARD}..${(i + 1) * PARTS_PER_SHARD - 1}`
      );
    }
    console.log("\n--dry-run: nothing was created.");
    return;
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const failed = [];

  for (let i = 0; i < SHARD_COUNT; i++) {
    if (onlySet && !onlySet.has(i)) continue;
    const repo = repoName(i);
    const exists = spawnSync("gh", ["repo", "view", `${owner}/${repo}`], {
      encoding: "utf8",
    }).status === 0;

    if (exists && !updateOnly) {
      console.log(`exists   ${repo}, updating it`);
    }

    const work = mkdtempSync(join(tmpdir(), `shard-${i}-`));
    let dir = null;
    try {
      const git = (args, options = {}) => {
        const r = spawnSync("git", args, { cwd: dir ?? work, encoding: "utf8", ...options });
        if (r.status !== 0) fail(`git ${args.join(" ")}:\n${r.stderr || r.stdout}`);
        return (r.stdout || "").trim();
      };
      const push = () => git(["push", "-q", "origin", "main"]);

      if (exists) {
        // Start from what GitHub holds, not from the template. Anything that
        // changed there since the last update, such as a refresh commit or a
        // workflow edit, is in the clone and stays.
        gh(["repo", "clone", `${owner}/${repo}`, work, "--", "--quiet"]);
        dir = work;
        const before = git(["rev-parse", "HEAD"]);
        console.log(`pulled   ${repo} at ${before.slice(0, 10)}`);
        stage(i, dir);
        git(["add", "-A"]);
        // `git status` prints nothing when the tree is clean. Do not test the
        // return of `git pull` here: a quiet pull prints nothing either, and an
        // earlier version read that as "no change" after it had already pushed.
        if (git(["status", "--porcelain"]) === "") {
          unchanged++;
          console.log(`same     ${repo}, the template matches it, so nothing is pushed`);
          continue;
        }
        git(["-c", "user.name=Jason Tally",
          "-c", "user.email=719178+jasontally@users.noreply.github.com",
          "commit", "-q", "-F", "-"], {
          input: `Update the shard template.\n\n${templateChangeSummary()}\n\nSee sharding.md in jasontally/pmtiles-cf-snippet.\n`,
        });
        // A refresh or a workflow edit can land between the clone and the push.
        // Fetch and rebase onto it rather than overwrite it.
        git(["pull", "-q", "--rebase", "origin", "main"]);
        push();
        updated++;
        console.log(`pushed   ${repo} ${git(["rev-parse", "--short", "HEAD"])}`);
      } else {
        // A new repo has no history, so the template is its first commit.
        // Created from the staged directory, and without --source or --remote.
        // --source=. would use this repo's directory, and --remote=origin would
        // collide with the remote that already exists here.
        stage(i, work);
        dir = work;
        gh(["repo", "create", repo, "--public", "--description",
          `Shard ${i} of the Protomaps basemap PMTiles archive, served from Cloudflare Static Assets`],
          { cwd: dir });
        created++;
        console.log(`created  ${repo}`);
        git(["init", "-q", "-b", "main"]);
        git(["add", "-A"]);
        git(["-c", "user.name=Jason Tally",
          "-c", "user.email=719178+jasontally@users.noreply.github.com",
          "commit", "-q", "-F", "-"], {
          input: `Shard ${i} of the Protomaps basemap archive.\n\nHolds tile parts ${i * PARTS_PER_SHARD} to ${(i + 1) * PARTS_PER_SHARD - 1}.\n${
            i === 0
              ? "\nAlso holds head.bin, meta.bin, and the leaf directories, which\ntogether are 324.9 MB.\n"
              : ""
          }The build downloads only this shard's bytes with an HTTP Range request\nand writes them to public/, then wrangler uploads them. Wrangler skips any\npart whose content hash Cloudflare already holds.\n\nSee sharding.md in jasontally/pmtiles-cf-snippet.\n`,
        });
        git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
        push();
        console.log(`pushed   ${repo}`);
      }
    } catch (error) {
      failed.push(`${repo}: ${error.message}`);
      console.error(`FAILED   ${repo}: ${error.message}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log(`\ncreated ${created}, updated ${updated}, unchanged ${unchanged}, failed ${failed.length}`);
  if (failed.length) {
    console.log("\nfailures:");
    for (const message of failed) console.log(`  ${message}`);
    process.exit(1);
  }
}

/**
 * The subject of a template update commit.
 *
 * The shard repos hold no other description of what the template push changed,
 * and the commit is the only record. It names the files the template owns, so a
 * reader of a shard repo can tell a template push from a refresh commit.
 */
function templateChangeSummary() {
  return "Replaces build.mjs, refresh.mjs, verify-shard.mjs, wrangler.jsonc,\n" +
    "package.json, the tests, the README, and both workflows with the current\n" +
    "shard-repo template. archive.json is not touched: the refresh workflow owns it.";
}

if (process.argv[1] && process.argv[1].endsWith("make-repos.mjs")) main();