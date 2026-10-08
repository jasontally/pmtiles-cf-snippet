/**
 * Tests for the refresh schedule and its arithmetic. Run with:
 *   node tools/refresh-tiles.test.mjs
 *
 * The refresh takes six and a half hours and reads a 138 GB archive. Getting the
 * window or the slot count wrong does not fail loudly: it either never runs, or
 * it leaves a cycle unfinished and waits a week. So the schedule is checked here
 * against the release history it was chosen from.
 *
 * Checks that need the Cloudflare API are skipped, not failed, when
 * CLOUDFLARE_API_TOKEN is absent, so this runs on a machine with no credentials
 * and says how many it skipped.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TOOL = join(HERE, "refresh-tiles.mjs");

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * Run one check. The body is a function and it is always called.
 *
 * The first version of this file passed the body in as a value and only tested
 * its truthiness, so a function was always truthy and every check passed without
 * running. Ten green checks meant nothing.
 */
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`skip  ${name}  (${why})`);
}

const source = readFileSync(TOOL, "utf8");
const hasCredentials = Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);

/** Read a constant out of the tool, so a change to the tool changes the test. */
function constOf(name) {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  assert.ok(match, `${name} not found in refresh-tiles.mjs`);
  return Function(`"use strict"; return (${match[1]});`)();
}

const WINDOW_START = constOf("WINDOW_START");
const WINDOW_END = constOf("WINDOW_END");
const ORDER = constOf("ORDER");
const SHARD_COUNT = constOf("SHARD_COUNT");
const MIN_AGE_MINUTES = constOf("MIN_AGE_MINUTES");

const fmt = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

await check("the window sits inside the only release free span in the history", () => {
  // From 62 Protomaps releases over 159 weeks: nothing has ever been published
  // between 00:16 and 07:34 UTC. See refresh.md.
  const firstEverAfterMidnight = 16; // Tue 2024-04-02 at 00:16 UTC
  const lastEverBeforeEight = 7 * 60 + 34; // Mon 2023-10-02 at 07:34 UTC
  assert.ok(WINDOW_START >= firstEverAfterMidnight,
    `window starts ${fmt(WINDOW_START)}, before the ${fmt(firstEverAfterMidnight)} release`);
  assert.ok(WINDOW_END <= lastEverBeforeEight,
    `window ends ${fmt(WINDOW_END)}, after the ${fmt(lastEverBeforeEight)} release`);
});

await check("the window is 6.5 to 7 hours, inside the 7.3 hour span", () => {
  const hours = (WINDOW_END - WINDOW_START) / 60;
  assert.ok(hours >= 6.5, `window is only ${hours} h`);
  assert.ok(hours <= 7.3, `window is ${hours} h, longer than the proven span`);
});

await check("the window has a slot for every shard and one to finish", () => {
  const slots = Math.floor((WINDOW_END - WINDOW_START) / 30);
  assert.ok(slots >= SHARD_COUNT + 1,
    `${slots} slots for ${SHARD_COUNT} shards and a reader update, need ${SHARD_COUNT + 1}`);
  assert.ok(slots <= SHARD_COUNT + 2, `${slots} slots, more than needed`);
});

await check("shard 0 goes last, because it holds the header", () => {
  assert.equal(ORDER[ORDER.length - 1], 0, `order ends with ${ORDER[ORDER.length - 1]}`);
});

await check("the order touches every shard exactly once", () => {
  assert.equal(ORDER.length, SHARD_COUNT, `${ORDER.length} entries`);
  const sorted = ORDER.slice().sort((a, b) => a - b);
  assert.deepEqual(sorted, [...Array(SHARD_COUNT).keys()], `order was ${ORDER.join(" ")}`);
});

await check("a build still running stops the next slot from starting another", () => {
  // 12 of 22 builds took over 20 minutes and one took 29.6. Six concurrent builds
  // killed one at 31 minutes. The guard is what prevents that.
  assert.ok(
    /still \$\{latest\.status\}/.test(source),
    "no in-flight guard found in refresh-tiles.mjs"
  );
});

await check("the parts per shard are derived, not fixed", () => {
  // The archive grows, so 4864 stops being right and a stale value sends every
  // read to the wrong host.
  assert.ok(
    source.includes("tilePartsPerShard: Math.ceil(tileParts / SHARD_COUNT)"),
    "tilePartsPerShard is not derived"
  );
  assert.ok(!/tilePartsPerShard:\s*4864/.test(source), "4864 is still hard coded");
});

await check("a target archive must be old enough to be fully written", () => {
  assert.ok(MIN_AGE_MINUTES >= 180, `only ${MIN_AGE_MINUTES} minutes`);
});

await check("no write in the tool can run in plan mode", () => {
  // Structural rather than a fixed number of lines: find the enclosing function
  // for each write and require a planOnly guard somewhere in it. A line window is
  // too small when a write sits below a long expression, and too large when two
  // functions are close together.
  const writes = [...source.matchAll(/\bwriteFileSync\(/g)];
  assert.ok(writes.length > 0, "no writes found, has the tool been refactored?");
  for (const write of writes) {
    const before = source.slice(0, write.index);
    const start = before.lastIndexOf("function ");
    assert.ok(start !== -1, `a write outside any function: ${before.slice(-80).trim()}`);
    const body = before.slice(start);
    const name = /function (\w+)/.exec(body)[1];
    assert.ok(
      /\bplanOnly\b/.test(body),
      `${name} writes without a planOnly guard, so a plan run would change a file`
    );
  }
});

await check("the workflow cron has five fields", () => {
  const yaml = readFileSync(join(ROOT, ".github", "workflows", "refresh-tiles.yml"), "utf8");
  const match = /- cron: '([^']+)'/.exec(yaml);
  assert.ok(match, "no cron in the workflow");
  // A four field cron is silently wrong and the schedule never fires.
  const fields = match[1].trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron is "${match[1]}", ${fields.length} fields`);
  assert.ok(match[1].startsWith("*/30"), `not every 30 minutes: ${match[1]}`);
  assert.ok(/0,1$/.test(fields[4]), `not Sunday and Monday: ${match[1]}`);
});

await check("the workflow asks for no more permission than contents write", () => {
  const yaml = readFileSync(join(ROOT, ".github", "workflows", "refresh-tiles.yml"), "utf8");
  assert.ok(/permissions:\s*\n\s*contents: write/.test(yaml), "permissions are not just contents: write");
  assert.ok(!/\bid-token:|\ball-repos:/.test(yaml), "the workflow asks for more than it needs");
});

// ---- checks that need the Cloudflare API ----

if (!hasCredentials) {
  skip("a plan run leaves the tree alone", "no CLOUDFLARE_API_TOKEN");
  skip("the layout reader agrees with the reader it feeds", "no CLOUDFLARE_API_TOKEN");
} else {
  await check("a plan run leaves the tree alone", () => {
    const before = readFileSync(join(ROOT, "snippet.js"), "utf8");
    const out = execFileSync(process.execPath, [TOOL, "--plan"], { encoding: "utf8" });
    const after = readFileSync(join(ROOT, "snippet.js"), "utf8");
    assert.equal(after, before, "the plan run rewrote the reader");
    assert.match(out, /shard \d+/, out.slice(0, 300));
    assert.ok(
      out.includes(fmt(WINDOW_START)) && out.includes(fmt(WINDOW_END)),
      `the plan did not report the window: ${out.slice(0, 300)}`
    );
    assert.ok(!existsSync(join(ROOT, "data", "refresh.json")), "a plan run wrote state");
  });

  await check("the layout reader agrees with the reader it feeds", () => {
    const out = execFileSync(process.execPath, [TOOL, "--layout"], { encoding: "utf8" });
    assert.ok(out.includes("PMTiles v3"), out.slice(0, 200));
    assert.ok(
      out.includes("reader agrees with what shard 0 serves: yes"),
      `the reader disagrees with the live archive: ${out.slice(-400)}`
    );
  });
}

function existsSync(path) {
  try {
    return require("node:fs").statSync(path);
  } catch {
    return false;
  }
}

console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);