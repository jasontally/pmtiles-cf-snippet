#!/usr/bin/env node
/**
 * Refresh one shard of the archive per run, inside the quiet window.
 *
 * The archive is 118 GiB and a shard build takes about 20 minutes, so a weekly
 * refresh is 13 builds. Running them all at once saturates the upload bandwidth
 * and kills builds: of 22 builds, one was terminated at 31 minutes when six ran
 * together. So one shard per 30 minute slot, which is 6.5 hours for 13 shards and
 * also happens to fit the only window in which Protomaps has never published.
 *
 *   node tools/refresh-tiles.mjs               # do the next thing
 *   node tools/refresh-tiles.mjs --plan        # print, change nothing
 *   node tools/refresh-tiles.mjs --report      # where every shard stands
 *   node tools/refresh-tiles.mjs --new-cycle   # start a cycle now, whatever the hour
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, the same environment the
 * workflow provides. State lives in data/refresh.json and is committed, so a run
 * that dies mid-window is picked up by the next one.
 *
 * WHY A PINNED TARGET
 * Every shard in a cycle must cut parts from the same bytes. If a new Protomaps
 * build appeared halfway through and the run picked it up, some shards would hold
 * one archive and some another, and the reader could not tell. So the target is
 * chosen once, written to the state file, and used until the cycle ends. A newer
 * build then waits for the next week.
 *
 * WHY SHARD 0 GOES LAST
 * Shard 0 holds head.bin, and a reader learns the archive layout from it. Leaving
 * it on the old archive until the final slot keeps clients on a consistent layout
 * for the whole window.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(ROOT, "data", "refresh.json");
const SNIPPET = join(ROOT, "snippet.js");

const BUILDS_URL = "https://build-metadata.protomaps.dev/builds.json";
const ARCHIVE_TEMPLATE = "https://build.protomaps.com/{key}";

const SHARD_COUNT = 13;
const SHARD_PREFIX = "pmtiles-shard-";
const TILE_SHARD = 2_000_000;

/**
 * The quiet window, in UTC minutes from midnight.
 *
 * 00:16 to 07:34 UTC is the only span that has never held a Protomaps release in
 * 159 weeks. Everything else in the day has at least one. See refresh.md.
 *
 * 14 half hour slots from 00:30 to 07:00. Twelve refresh shards 1 to 12, one
 * refreshes shard 0 at 06:30, and the last finalises the reader at 07:00. Without
 * that fourteenth slot the reader would wait a week for its offsets.
 *
 * This window gates starting a shard build only. Finishing the cycle reads the
 * header from our own shard 0, not from Protomaps, so it is allowed at any hour
 * and the workflow also runs on Monday to catch a shard 0 that built slowly.
 */
const WINDOW_START = 0 * 60 + 30;
const WINDOW_END = 7 * 60 + 30;

/**
 * How old a build must be before we cut shards from it. Protomaps writes a build
 * and then lists it, so a very new one may still be uploading, and a short read
 * would produce a corrupt archive.
 */
const MIN_AGE_MINUTES = 60 * 4;

/** Refresh order. Shard 0 last, because it holds the header. */
const ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;

const planOnly = process.argv.includes("--plan");
const reportOnly = process.argv.includes("--report");
const forceCycle = process.argv.includes("--new-cycle");
const finalizeOnly = process.argv.includes("--finalize");
const layoutOnly = process.argv.includes("--layout");

function fail(message) {
  console.error(`refresh-tiles failed: ${message}`);
  process.exit(1);
}

function shardName(index) {
  return `${SHARD_PREFIX}${String(index).padStart(2, "0")}`;
}

/** Minutes from midnight as HH:MM. */
function fmtClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The slot times a run can land on, for the log and for the tests. */
export function slots() {
  const out = [];
  for (let m = WINDOW_START; m < WINDOW_END; m += 30) out.push(fmtClock(m));
  return out;
}

async function api(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
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

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { target: null, step: 0, attempts: {}, startedAt: null, finishedAt: null, finalized: null };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  if (planOnly) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function commitState(message) {
  if (planOnly) return false;
  const status = execFileSync("git", ["status", "--porcelain", "data/refresh.json"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (!status.trim()) return false;
  execFileSync("git", ["add", "data/refresh.json"], { cwd: ROOT });
  execFileSync("git", [
    "-c", "user.name=github-actions[bot]",
    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "-q", "-m", message,
  ], { cwd: ROOT });
  execFileSync("git", ["push", "origin", "HEAD"], { cwd: ROOT });
  return true;
}

/** The newest Protomaps build, and how old it is. */
async function newestBuild() {
  const response = await fetch(BUILDS_URL);
  if (!response.ok) throw new Error(`${BUILDS_URL} returned ${response.status}`);
  const builds = await response.json();
  if (!Array.isArray(builds) || !builds.length) throw new Error("no builds listed");
  const sorted = builds.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
  const newest = sorted[sorted.length - 1];
  const uploaded = new Date(newest.uploaded);
  const ageMinutes = (Date.now() - uploaded.getTime()) / 60000;
  return { ...newest, ageMinutes };
}

/** Worker tags for every shard, by name. */
async function shardTags() {
  const scripts = await api("/workers/scripts");
  const tags = new Map();
  for (const script of scripts) {
    const match = new RegExp(`^${SHARD_PREFIX}(\\d{2})$`).exec(script.id);
    if (match) tags.set(Number(match[1]), script.tag);
  }
  return tags;
}

/** The Builds trigger for a shard, which is what holds ARCHIVE_URL. */
async function shardTriggers() {
  const tags = await shardTags();
  const triggers = new Map();
  for (const [index, tag] of tags) {
    const list = await api(`/builds/workers/${tag}/triggers`);
    if (!list.length) throw new Error(`${shardName(index)} has no Builds trigger`);
    triggers.set(index, list[0]);
  }
  return triggers;
}

async function latestBuildFor(trigger, tag) {
  const builds = await api(`/builds/workers/${tag}/builds`);
  return builds[0] || null;
}

async function setArchiveUrl(trigger, key) {
  await api(`/builds/triggers/${trigger.trigger_uuid}/environment_variables`, {
    method: "PATCH",
    body: JSON.stringify({
      ARCHIVE_URL: { is_secret: false, value: ARCHIVE_TEMPLATE.replace("{key}", key) },
    }),
  });
}

async function startBuild(trigger) {
  const result = await api(`/builds/triggers/${trigger.trigger_uuid}/builds`, {
    method: "POST",
    body: JSON.stringify({ branch: "main" }),
  });
  return result.build_uuid;
}

/**
 * Read the archive header from shard 0 and return the layout the reader needs.
 *
 * The byte offsets change with every Protomaps build, because the tile section
 * changes length. The reader holds them as constants, so it has to be told.
 */
async function readLayout(tag) {
  // shard 0 serves the archive at its own hostname, so this reads the live
  // header rather than the source archive. That is the point: the offsets must
  // describe what the shards now hold.
  const base = `https://s.tiles0.jasontally.com/s/basemap/head.bin`;
  const response = await fetch(base);
  if (!response.ok) throw new Error(`${base} returned ${response.status}`);
  const header = new Uint8Array(await response.arrayBuffer());
  const u64 = (offset) => Number(new DataView(header.buffer).getBigUint64(offset, true));
  const leafDirOffset = u64(40);
  const leafDirLength = u64(48);
  const tileDataOffset = u64(56);
  const tileDataLength = u64(64);
  const metadataOffset = u64(24);
  const metadataLength = u64(32);

  // The sections sit back to back: tiles, then metadata, then the leaf
  // directories, which run to the end of the file. So the total is the end of the
  // leaf section, and each section must end where the next begins. A build that
  // did not lay out that way is caught here rather than by serving wrong bytes.
  for (const [what, end, start] of [
    ["tile end to metadata start", tileDataOffset + tileDataLength, metadataOffset],
    ["metadata end to leaf start", metadataOffset + metadataLength, leafDirOffset],
  ]) {
    if (end !== start) throw new Error(`${what}: ${end} != ${start}, the layout is not contiguous`);
  }

  const tileParts = Math.ceil(tileDataLength / TILE_SHARD);
  return {
    total: leafDirOffset + leafDirLength,
    tileDataOffset,
    tileDataLength,
    metadataOffset,
    leafDirOffset,
    // A part number gives its shard with one division, so this must equal what
    // the shard builds compute. It grows as the archive grows, so leaving it at
    // 4864 would send reads to the wrong host.
    tilePartsPerShard: Math.ceil(tileParts / SHARD_COUNT),
    tileParts,
    leafParts: Math.ceil(leafDirLength / 160_000),
    // Read back from the header so a wrong offset is visible in the log.
    magic: String.fromCharCode(...header.slice(0, 7)),
    version: header[7],
  };
}

/**
 * Rewrite the reader's archive table with a new layout.
 *
 * The reader hard codes the byte offsets, because it must answer a request from
 * one subrequest and cannot spend another on reading the header. So they are
 * constants, and a data refresh has to put new ones there.
 */
function writeSnippetLayout(layout) {
  // The guard lives here rather than in the caller, so a new caller cannot
  // rewrite the reader by accident. A plan run has to be safe by construction.
  if (planOnly) return;
  const source = readFileSync(SNIPPET, "utf8");
  const before = source;
  const patched = source.replace(
    /basemap: \{[\s\S]*?\n  \},/,
    [
      "  basemap: {",
      `    total: ${layout.total},`,
      `    headEnd: ${layout.tileDataOffset},`,
      `    tileOffset: ${layout.tileDataOffset},`,
      `    metaOffset: ${layout.metadataOffset},`,
      `    leafOffset: ${layout.leafDirOffset},`,
      `    tileShard: ${TILE_SHARD},`,
      "    leafShard: 160000,",
      `    tilePartsPerShard: ${layout.tilePartsPerShard},`,
      "  },",
    ].join("\n")
  );
  if (patched === before) throw new Error("could not find the basemap entry in snippet.js");
  writeFileSync(SNIPPET, patched);
}

/**
 * The last step: put the new archive's byte offsets into the reader.
 *
 * The reader answers a range request from one subrequest, so it cannot spend a
 * second one reading the header. The offsets are therefore constants, and a data
 * refresh has to rewrite them. Committing snippet.js is enough: the build for
 * this repo deploys the Snippet.
 */
async function finalize(state) {
  const tags = await shardTags();
  const triggers = await shardTriggers();
  const tag = tags.get(0);
  const latest = await latestBuildFor(triggers.get(0), tag);

  if (!latest) throw new Error("shard 0 has never been built");
  if (!["stopped", "queued", "running"].includes(latest.status)) {
    throw new Error(`shard 0 build is ${latest.status}, too early to read its archive`);
  }
  if (latest.status === "stopped" && latest.build_outcome !== "success") {
    throw new Error(
      `shard 0 build finished ${latest.build_outcome}. The reader cannot be updated ` +
        "from an archive that did not build."
    );
  }
  if (latest.status !== "stopped") {
    console.log(`shard 0   build is still ${latest.status}, waiting for the next slot`);
    return false;
  }

  const layout = await readLayout(tag);
  console.log(`header    ${layout.magic} v${layout.version}`);
  console.log(`total     ${layout.total.toLocaleString()} bytes`);
  console.log(`tiles     ${layout.tileDataLength.toLocaleString()} bytes in ${layout.tileParts.toLocaleString()} parts`);
  console.log(`parts     ${layout.tilePartsPerShard.toLocaleString()} per shard`);
  console.log(`files     shard 0 holds about ${(layout.tilePartsPerShard + layout.leafParts + 2).toLocaleString()}`);

  if (planOnly) {
    console.log("plan     snippet.js not touched");
    return true;
  }

  writeSnippetLayout(layout);
  {
    execFileSync("git", ["add", "snippet.js"], { cwd: ROOT });
    execFileSync("git", [
      "-c", "user.name=github-actions[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "-q", "-m",
      `fix(reader): byte offsets for ${state.target}\n\n` +
        `Refreshed to ${state.target}. The archive is now ` +
        `${layout.total.toLocaleString()} bytes in ${layout.tileParts.toLocaleString()} ` +
        `tile parts, so the offsets the reader holds, and the parts per shard, both change.\n\n` +
        `Shards per build grows with the archive. At this size a build is about ` +
        `25 minutes, close to the limit where one build was terminated at 31 minutes.`,
    ], { cwd: ROOT });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: ROOT });
    console.log("snippet   offsets written and committed, the build will deploy it");
  }

  state.finalized = state.target;
  saveState(state);
  commitState(`chore: refresh ${state.target} finalized`);
  return true;
}

async function report() {
  const tags = await shardTags();
  const triggers = await shardTriggers();
  console.log("shard  worker              latest build            outcome");
  for (let index = 0; index < SHARD_COUNT; index++) {
    const tag = tags.get(index);
    const build = tag ? await latestBuildFor(triggers.get(index), tag) : null;
    console.log(
      `  ${String(index).padStart(2)}    ${shardName(index)}   ` +
        `${build ? build.build_uuid.slice(0, 8) : "none"}            ` +
        `${build ? `${build.status}/${build.build_outcome ?? "pending"}` : "-"}`
    );
  }
}

async function main() {
  if (!TOKEN || !ACCOUNT) fail("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");

  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inWindow = minutes >= WINDOW_START && minutes < WINDOW_END;
  const day = now.getUTCDay();

  console.log(`time     ${now.toISOString()}  ${day === 0 ? "Sunday" : `day ${day}`}`);
  const slots = Math.floor((WINDOW_END - WINDOW_START) / 30);
  console.log(
    `window   ${fmtClock(WINDOW_START)} to ${fmtClock(WINDOW_END)} UTC, ` +
      `${((WINDOW_END - WINDOW_START) / 60).toFixed(1)} h, ${slots} half hour slots ` +
      `for ${SHARD_COUNT} shards and one to finish`
  );

  if (reportOnly) {
    await report();
    return;
  }

  if (layoutOnly) {
    const tags = await shardTags();
    const layout = await readLayout(tags.get(0));
    console.log(`magic     ${layout.magic} v${layout.version}`);
    console.log(`total     ${layout.total.toLocaleString()} bytes`);
    console.log(`tileData  offset ${layout.tileDataOffset.toLocaleString()} length ${layout.tileDataLength.toLocaleString()}`);
    console.log(`metadata  offset ${layout.metadataOffset.toLocaleString()}`);
    console.log(`leaf      offset ${layout.leafDirOffset.toLocaleString()}`);
    console.log(`tileParts ${layout.tileParts.toLocaleString()}  ${layout.tilePartsPerShard.toLocaleString()} per shard`);
    console.log(`files     shard 0 holds about ${(layout.tilePartsPerShard + layout.leafParts + 2).toLocaleString()}`);

    const current = readFileSync(SNIPPET, "utf8");
    const entry = /basemap: \{[\s\S]*?\n  \},/.exec(current);
    console.log("\nwhat the reader holds now:");
    console.log(
      entry
        ? entry[0].split("\n").map((l) => "  " + l.trim()).join("\n")
        : "  not found"
    );
    const matches =
      entry[0].includes(`total: ${layout.total},`) &&
      entry[0].includes(`tilePartsPerShard: ${layout.tilePartsPerShard},`);
    console.log(`\nreader agrees with what shard 0 serves: ${matches ? "yes" : "NO"}`);
    return;
  }

  if (finalizeOnly) {
    const state = loadState();
    if (!state.target) fail("no refresh cycle in data/refresh.json, nothing to finalize");
    const done = await finalize(state);
    if (done) console.log(`cycle    complete on ${state.target}`);
    return;
  }

  const newest = await newestBuild();
  console.log(`newest   ${newest.key}  ${(newest.size / 1e9).toFixed(1)} GB  ` +
    `published ${newest.uploaded}  ${(newest.ageMinutes / 60).toFixed(1)} h ago`);

  if (newest.ageMinutes < MIN_AGE_MINUTES && !forceCycle) {
    console.log(
      `too new, ${(newest.ageMinutes / 60).toFixed(1)} h old and the minimum is ` +
        `${MIN_AGE_MINUTES / 60} h. A build still being written would give corrupt shards.`
    );
    return;
  }

  let state = loadState();

  // Everything has been started. This branch comes before the window check on
  // purpose: finishing the cycle reads our own shard, not Protomaps, so it must
  // not be locked out of its own slot.
  if (state.target && state.step >= ORDER.length && !state.finalized) {
    console.log("shards   all started, finishing the reader");
    if (await finalize(state)) console.log(`cycle    complete on ${state.target}`);
    return;
  }

  if (!inWindow && !forceCycle && !planOnly) {
    console.log("outside the quiet window, nothing to do");
    return;
  }

  if (!state.target) {
    state = { target: newest.key, step: 0, attempts: {}, startedAt: now.toISOString(), finishedAt: null, finalized: null };
    console.log(`cycle    started on ${state.target}`);
  }

  if (state.step >= ORDER.length) {
    console.log(`cycle    complete on ${state.target}, finished ${state.finishedAt}`);
    if (newest.key !== state.target) {
      console.log(`next     ${newest.key} is newer and is waiting for next week`);
    }
    return;
  }

  const shard = ORDER[state.step];
  const tags = await shardTags();
  const tag = tags.get(shard);
  if (!tag) fail(`no Worker named ${shardName(shard)}`);
  const triggers = await shardTriggers();
  const trigger = triggers.get(shard);

  // A slot must not start a second build while the last one is still running.
  // That is the mistake that killed a build at 31 minutes.
  const latest = await latestBuildFor(trigger, tag);
  if (latest && ["queued", "initializing", "running", "pending"].includes(latest.status)) {
    console.log(`shard ${shard}   a build is still ${latest.status}, waiting for the next slot`);
    return;
  }

  const attempts = (state.attempts[String(shard)] || 0) + 1;
  state.attempts[String(shard)] = attempts;
  if (latest && latest.build_outcome !== "success") {
    console.log(`shard ${shard}   last build was ${latest.build_outcome}, retrying (attempt ${attempts} of 3)`);
    if (attempts > 3) {
      console.log(`shard ${shard}   giving up this cycle. It will be picked up next week.`);
      state.step += 1;
      saveState(state);
      commitState(`chore: refresh ${state.target}, shard ${shard} failed 3 times`);
      return;
    }
  }

  const url = ARCHIVE_TEMPLATE.replace("{key}", state.target);
  console.log(`shard ${shard}   set ARCHIVE_URL to ${url}`);
  if (!planOnly) {
    await setArchiveUrl(trigger, state.target);
    const buildUuid = await startBuild(trigger);
    console.log(`shard ${shard}   build ${buildUuid} started`);
  }

  state.step += 1;
  if (state.step >= ORDER.length) {
    state.finishedAt = now.toISOString();
    console.log("shards   all started, the reader needs its offsets updated next slot");
  }
  saveState(state);
  commitState(`chore: refresh to ${state.target}, shard ${shard} started`);
  console.log(`state    step ${state.step} of ${ORDER.length}`);
}

main().catch((error) => fail(error.stack || error.message));