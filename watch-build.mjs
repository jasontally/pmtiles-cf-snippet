#!/usr/bin/env node
/**
 * Watch a Workers Builds run and print its log as it arrives.
 *
 *   node watch-build.mjs <worker>            # latest build for a shard Worker
 *   node watch-build.mjs pmtiles-shard-01    # follow until it finishes
 *   node watch-build.mjs --build <uuid>     # a specific build
 *
 * Logs are a list of [epochMillis, message] pairs, so the cursor is the index of
 * the last line already printed. Polling GETs the whole log each time, which is
 * fine: a build makes a few hundred lines, and Workers Builds keeps them all.
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 */

import { setTimeout as sleep } from "node:timers/promises";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

if (!TOKEN || !ACCOUNT) {
  console.error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  process.exit(1);
}

const buildFlag = process.argv.indexOf("--build");
const explicitBuild = buildFlag === -1 ? null : process.argv[buildFlag + 1];
const target = explicitBuild || process.argv[2];
if (!target) {
  console.error("usage: node watch-build.mjs <worker> | --build <uuid>");
  process.exit(1);
}

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await response.json();
  if (!body.success) {
    throw new Error(
      `${path}: ${body.errors?.map((e) => e.message).join("; ") || response.status}`
    );
  }
  return body.result;
}

async function findBuild() {
  if (explicitBuild) return explicitBuild;
  if (!target.startsWith("pmtiles-shard-")) {
    throw new Error(`${target} is not a shard Worker name`);
  }
  const scripts = await api("/workers/scripts");
  const script = scripts.find((s) => s.id === target);
  if (!script) throw new Error(`no Worker named ${target}`);
  const builds = await api(`/builds/workers/${script.tag}/builds`);
  if (!builds.length) throw new Error(`${target} has no builds yet`);
  return builds[0].build_uuid;
}

function stamp(epochMillis) {
  const at = new Date(epochMillis);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}:${String(
    at.getUTCSeconds()
  ).padStart(2, "0")}`;
}

// Workers Builds reports terminal builds as status "stopped" with the outcome
// carrying the reason, so the status alone decides that it is over.
const DONE = new Set(["stopped", "cancelled", "canceled", "errored", "failed"]);

const buildUuid = await findBuild();
console.log(`build ${buildUuid}`);
let shown = 0;
let lastStatus = "";
const started = Date.now();

// Workers Builds allows 20 minutes. Stop a little before, so this reports the
// timeout instead of hanging on a build that is about to be killed.
const LIMIT_MS = 19 * 60 * 1000;

while (true) {
  const [build, logs] = await Promise.all([
    api(`/builds/builds/${buildUuid}`),
    api(`/builds/builds/${buildUuid}/logs`),
  ]);

  // The log holds every line so far, so print from where the last poll stopped.
  // If it is truncated, print everything again rather than skip lines.
  if (logs.truncated && shown) {
    console.log("--- log truncated, reprinting");
    shown = 0;
  }
  for (const line of (logs.lines || []).slice(shown)) {
    const [at, message] = line;
    console.log(`${typeof at === "number" ? stamp(at) : "--:--:--"}  ${message}`);
  }
  shown = (logs.lines || []).length;

  const status = `${build.status}/${build.build_outcome ?? "pending"}`;
  if (status !== lastStatus) {
    console.log(`--- status ${status}  (${Math.round((Date.now() - started) / 1000)}s)`);
    lastStatus = status;
  }

  if (DONE.has(build.status)) {
    const seconds = (Date.now() - started) / 1000;
    console.log(`\nbuild ${build.status}, outcome ${build.build_outcome}, ${seconds.toFixed(0)}s`);
    console.log(`initializing ${build.initializing_on}`);
    console.log(`running     ${build.running_on}`);
    console.log(`stopped     ${build.stopped_on}`);
    process.exit(build.build_outcome === "success" ? 0 : 1);
  }
  if (Date.now() - started > LIMIT_MS) {
    console.log("\ngave up waiting; the build is still running. Check it in the dashboard.");
    process.exit(2);
  }
  await sleep(15000);
}