#!/usr/bin/env node
/**
 * Wire all 13 shard repos to their Workers in Workers Builds, by API.
 *
 * Replaces 13 rounds of dashboard work. For each shard it registers the GitHub
 * repo, binds it to the Worker as a trigger, sets the build variables, and then
 * reads all three back to confirm.
 *
 * Idempotent. A shard that already has a trigger bound to the right repo keeps
 * it, so this never creates a second trigger, and running it after a template
 * change is safe.
 *
 *   node wire-shards.mjs --dry-run      # report what is missing, change nothing
 *   node wire-shards.mjs                # wire every shard
 *   node wire-shards.mjs --only 3,7,12  # wire some
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, the same environment
 * Workers Builds provides, and the GitHub CLI for the repo IDs.
 *
 * Token permissions: Workers Scripts Read for the Worker tags, Builds Read for
 * the existing triggers, and Builds Edit for the connections, triggers, and
 * variables it creates.
 */

import { spawnSync } from "node:child_process";

const SHARD_COUNT = 13;
const WORKER_PREFIX = "pmtiles-shard";
const REPO_OWNER = "jasontally";

// The dated snapshot, not a moving URL. Every shard must cut parts from the
// same bytes, and the reader computes part numbers from the archive layout. A
// republished file at the same URL would shift every part and silently corrupt
// the map.
const ARCHIVE_URL = "https://build.protomaps.com/20241021.pmtiles";
const BUILD_COMMAND = "npm run build";
const DEPLOY_COMMAND = "npx wrangler deploy";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;

const dryRun = process.argv.includes("--dry-run");
const only = (() => {
  const at = process.argv.indexOf("--only");
  if (at === -1) return null;
  return new Set(process.argv[at + 1].split(",").map((n) => Number(n.trim())));
})();

if (!TOKEN || !ACCOUNT) {
  console.error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  process.exit(1);
}

function workerName(index) {
  return `${WORKER_PREFIX}-${String(index).padStart(2, "0")}`;
}
function repoName(index) {
  return `${WORKER_PREFIX}-${String(index).padStart(2, "0")}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const detail = body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || response.status;
    throw new Error(`${options.method || "GET"} ${path}: ${detail}`);
  }
  return body.result;
}

function ghRepoId(repo) {
  const result = spawnSync("gh", ["api", `repos/${REPO_OWNER}/${repo}`, "--jq", ".id"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`gh api repos/${REPO_OWNER}/${repo}: ${result.stderr.trim()}`);
  }
  return String(result.stdout.trim());
}

/** Cloudflare records the repo name with or without the owner prefix. */
function sameRepo(recorded, repo) {
  return (recorded || "").split("/").pop() === repo;
}

/** The Worker tag for each shard Worker, which the trigger needs. */
async function workerTags() {
  const scripts = await api(`/accounts/${ACCOUNT}/workers/scripts`);
  const tags = new Map();
  for (const script of scripts) {
    const match = new RegExp(`^${WORKER_PREFIX}-(\\d{2})$`).exec(script.id);
    if (match) tags.set(Number(match[1]), { tag: script.tag, id: script.id });
  }
  return tags;
}

/** A build token to have builds authenticate with. One is enough for all 13. */
async function buildToken() {
  const tokens = await api(`/accounts/${ACCOUNT}/builds/tokens`);
  if (!tokens.length) throw new Error("no build token exists. Create one in the dashboard.");
  // Reuse the one the user already proved works on shard-00.
  const preferred = tokens.find((t) => t.build_token_name === "pmtiles-cf-snippet build token");
  return (preferred || tokens[0]).build_token_uuid;
}

async function wireShard(index, tag, buildTokenUuid) {
  const repo = repoName(index);
  const name = workerName(index);
  const notes = [];

  // The trigger the user may have made by hand, if it is bound to this repo.
  const existing = await api(`/accounts/${ACCOUNT}/builds/workers/${tag}/triggers`);
  const wanted = existing.find((t) => sameRepo(t.repo_connection?.repo_name, repo));
  const foreign = existing.filter((t) => !sameRepo(t.repo_connection?.repo_name, repo));

  let triggerUuid = wanted?.trigger_uuid;
  if (triggerUuid) {
    notes.push(`trigger exists`);
  } else {
    if (dryRun) {
      notes.push(`would create trigger`);
    } else {
      const repoId = ghRepoId(repo);
      // Register the repo. The upsert returns the connection, so there is no
      // need to list them, and GET on the collection is not a working endpoint.
      const connection = await api(`/accounts/${ACCOUNT}/builds/repos/connections`, {
        method: "PUT",
        body: JSON.stringify({
          provider_type: "github",
          provider_account_id: "719178",
          provider_account_name: REPO_OWNER,
          repo_id: repoId,
          repo_name: `${REPO_OWNER}/${repo}`,
        }),
      });
      if (!connection?.repo_connection_uuid) throw new Error(`no connection for ${repo}`);
      if (connection.grant_id) {
        throw new Error(
          `${repo} needs a GitHub App grant. Connect it by hand in the dashboard.`
        );
      }
      const created = await api(`/accounts/${ACCOUNT}/builds/triggers`, {
        method: "POST",
        body: JSON.stringify({
          trigger_name: `shard ${String(index).padStart(2, "0")}`,
          build_token_uuid: buildTokenUuid,
          build_command: BUILD_COMMAND,
          deploy_command: DEPLOY_COMMAND,
          external_script_id: tag,
          repo_connection_uuid: connection.repo_connection_uuid,
          root_directory: "/",
          branch_includes: ["main"],
          path_includes: ["*"],
        }),
      });
      triggerUuid = created.trigger_uuid;
      notes.push(`trigger created`);
    }
  }

  if (foreign.length) {
    // Not fatal, but worth saying out loud: a trigger on another repo would also
    // build this Worker, and its parts would be the wrong ones.
    notes.push(`WARNING ${foreign.length} trigger(s) bound to another repo`);
  }

  // Variables.
  const wantedVars = {
    SHARD_INDEX: String(index),
    SHARD_COUNT: String(SHARD_COUNT),
    ARCHIVE_URL,
  };
  let vars = {};
  if (triggerUuid) {
    vars = (await api(`/accounts/${ACCOUNT}/builds/triggers/${triggerUuid}/environment_variables`)) || {};
  }
  const wrong = Object.entries(wantedVars).filter(([k, v]) => vars[k]?.value !== v);
  if (!triggerUuid) {
    notes.push(`would set ${Object.keys(wantedVars).join(", ")}`);
  } else if (wrong.length === 0) {
    notes.push(`variables ok`);
  } else if (dryRun) {
    notes.push(`would set ${wrong.map(([k]) => k).join(", ")}`);
  } else {
    await api(`/accounts/${ACCOUNT}/builds/triggers/${triggerUuid}/environment_variables`, {
      method: "PATCH",
      body: JSON.stringify(
        Object.fromEntries(
          wrong.map(([k, v]) => [k, { is_secret: false, value: v }])
        )
      ),
    });
    notes.push(`set ${wrong.map(([k]) => k).join(", ")}`);
  }

  // Read back everything, so the report is what Cloudflare holds, not what was
  // sent.
  const finalTriggers = await api(`/accounts/${ACCOUNT}/builds/workers/${tag}/triggers`);
  const final = finalTriggers.find((t) => t.trigger_uuid === triggerUuid) || null;
  // A dry run on an unwired shard has no trigger to read back.
  const finalVars = final
    ? (await api(
        `/accounts/${ACCOUNT}/builds/triggers/${final.trigger_uuid}/environment_variables`
      )) || {}
    : {};

  // A dry run on an unwired shard has nothing to verify, so only a shard that
  // already has a trigger can report a problem.
  const problems = [];
  if (!final) {
    if (!dryRun) problems.push("no trigger");
  } else {
    if (final.build_command !== BUILD_COMMAND) problems.push(`build_command=${final.build_command}`);
    if (final.deploy_command !== DEPLOY_COMMAND) problems.push(`deploy_command=${final.deploy_command}`);
    if (!sameRepo(final.repo_connection?.repo_name, repo)) problems.push("wrong repo");
    if (!final.branch_includes?.includes("main")) problems.push(`branches=${final.branch_includes}`);
  }
  // Only complain about variables when a trigger exists to hold them.
  if (final) {
    for (const [k, v] of Object.entries(wantedVars)) {
      if (finalVars[k]?.value !== v) problems.push(`${k}=${finalVars[k]?.value ?? "unset"}`);
    }
  }

  return { notes, problems, triggerUuid: final ? final.trigger_uuid : null };
}

async function main() {
  const tags = await workerTags();
  const buildTokenUuid = await buildToken();
  console.log(`build token ${buildTokenUuid}`);
  console.log(`archive    ${ARCHIVE_URL}`);
  if (dryRun) console.log("DRY RUN: nothing is changed\n");

  const rows = [];
  const failures = [];

  for (let index = 0; index < SHARD_COUNT; index++) {
    if (only && !only.has(index)) continue;
    const worker = tags.get(index);
    if (!worker) {
      failures.push(`shard ${index}: Worker ${workerName(index)} does not exist`);
      console.log(`shard ${String(index).padStart(2, "0")}  Worker missing`);
      continue;
    }
    try {
      const { notes, problems, triggerUuid } = await wireShard(index, worker.tag, buildTokenUuid);
      rows.push({ index, name: workerName(index), notes: notes.join(", "), triggerUuid });
      if (problems.length) failures.push(`shard ${index}: ${problems.join("; ")}`);
      console.log(
        `shard ${String(index).padStart(2, "0")}  ${problems.length ? "PROBLEM" : "ok"}  ` +
          `${notes.join(", ")}${problems.length ? `  [${problems.join("; ")}]` : ""}`
      );
    } catch (error) {
      failures.push(`shard ${index}: ${error.message}`);
      console.log(`shard ${String(index).padStart(2, "0")}  FAILED  ${error.message}`);
    }
  }

  console.log(`\n${rows.length} shards, ${failures.length} problems`);
  if (failures.length) {
    for (const failure of failures) console.log(`  ${failure}`);
    process.exit(1);
  }
  if (!dryRun) {
    console.log("\nEvery shard builds when its repo is pushed to main.");
    console.log("Start one with:");
    console.log(
      `  curl -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
        `/builds/triggers/<trigger_uuid>/builds" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"` +
        ` -H "Content-Type: application/json" -d '{"branch":"main"}'`
    );
  }
}

main().catch((error) => {
  console.error(`wire-shards failed: ${error.message}`);
  process.exit(1);
});