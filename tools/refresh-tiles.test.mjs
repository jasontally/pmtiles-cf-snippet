/**
 * Tests for the refresh schedule and its arithmetic. Run with:
 *   node tools/refresh-tiles.test.mjs
 *
 * The refresh takes six and a half hours and reads a 138 GB archive. Getting the
 * window or the slot count wrong does not fail loudly: it either never runs, or it
 * leaves a cycle unfinished and waits a week. So the schedule is checked here
 * against the release history it was chosen from.
 *
 * The parts that touch the network or change a Worker are only reachable with
 * credentials, so they are exercised by --plan, which prints and changes nothing.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "refresh-tiles.mjs");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}

// The constants, read out of the tool rather than repeated here, so a change to
// the tool is a change to what is tested.
const source = readFileSync(TOOL, "utf8");
const constOf = (name) => {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  assert.ok(match, `${name} not found in refresh-tiles.mjs`);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${match[1]});`)();
};
const WINDOW_START = constOf("WINDOW_START");
const WINDOW_END = constOf("WINDOW_END");
const ORDER = constOf("ORDER");
const SHARD_COUNT = constOf("SHARD_COUNT");
const TILE_SHARD = constOf("TILE_SHARD");

const fmt = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

check("the window sits inside the only release free span in the history", () => {
  // From 62 Protomaps releases over 159 weeks: nothing has ever been published
  // between 00:16 and 07:34 UTC. See refresh.md.
  const firstEverAfterMidnight = 16; // Tue 2024-04-02 at 00:16 UTC
  const lastEverBeforeEight = 7 * 60 + 34; // Mon 2023-10-02 at 07:34 UTC
  check("window starts after the 00:16 release", WINDOW_START >= firstEverAfterMidnight,
    `${fmt(WINDOW_START)} < ${fmt(firstEverAfterMidnight)}`);
  check("window ends before the 07:34 release", WINDOW_END <= lastEverBeforeEight,
    `${fmt(WINDOW_END)} > ${fmt(lastEverBeforeEight)}`);
});

check("the window has a slot for every shard and one to finish", () => {
  const slots = Math.floor((WINDOW_END - WINDOW_START) / 30);
  check("one slot per shard plus one for the reader", slots >= SHARD_COUNT + 1,
    `${slots} slots for ${SHARD_COUNT} shards`);
  check("and not many more, so nothing is wasted", slots <= SHARD_COUNT + 2,
    `${slots} slots for ${SHARD_COUNT} shards`);
});

check("shard 0 goes last, because it holds the header", () => {
  check("shard 0 is the last shard refreshed", ORDER[ORDER.length - 1] === 0,
    `order ends with ${ORDER[ORDER.length - 1]}`);
});

check("the order touches every shard exactly once", () => {
  check("length", ORDER.length === SHARD_COUNT, `${ORDER.length} entries`);
  const sorted = ORDER.slice().sort((a, b) => a - b);
  check("covers 0 to 12 once", JSON.stringify(sorted) === JSON.stringify([...Array(SHARD_COUNT).keys()]),
    `order was ${ORDER.join(" ")}`);
});

check("a build long enough to overlap the next slot is waited out", () => {
  // 12 of 22 builds took over 20 minutes, and one took 29.6. The script refuses
  // to start a second build while one is running, which is what stopped six
  // concurrent builds from killing each other.
  const source2 = source;
  check("it checks the latest build before starting one",
    source2.includes("still ${latest.status}"), "no in-flight guard found");
});

check("the parts per shard are derived, not fixed", () => {
  // The archive grows, so 4864 stops being right and a stale value sends reads to
  // the wrong host.
  check("the tool computes parts per shard", source.includes("tilePartsPerShard: Math.ceil(tileParts / SHARD_COUNT)"),
    "no derived tilePartsPerShard");
  check("and does not hard code 4864", !/tilePartsPerShard:\s*4864/.test(source),
    "4864 is still hard coded");
});

check("the target archive must be old enough to be fully written", () => {
  const min = constOf("MIN_AGE_MINUTES");
  check("at least 3 hours", min >= 180, `${min} minutes`);
});

check("the plan run changes nothing", () => {
  const before = readFileSync(join(HERE, "..", "snippet.js"), "utf8");
  const out = execFileSync(process.execPath, [TOOL, "--plan"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  const after = readFileSync(join(HERE, "..", "snippet.js"), "utf8");
  check("snippet.js untouched", before === after, "the plan run rewrote the reader");
  check("it says which shard is next", /shard \d+/.test(out), out.slice(0, 300));
  check("it reports the window", out.includes(fmt(WINDOW_START)) && out.includes(fmt(WINDOW_END)),
    out.slice(0, 300));
});

check("the layout reader agrees with the reader it feeds", () => {
  const out = execFileSync(process.execPath, [TOOL, "--layout"], { encoding: "utf8" });
  check("it reads a PMTiles v3 header", out.includes("PMTiles v3"), out.slice(0, 200));
  check("it confirms the reader agrees", out.includes("reader agrees with what shard 0 serves: yes"),
    out.slice(-300));
});

check("the workflow cron has five fields", () => {
  const yaml = readFileSync(join(HERE, "..", ".github", "workflows", "refresh-tiles.yml"), "utf8");
  const match = /- cron: '([^']+)'/.exec(yaml);
  assert.ok(match, "no cron in the workflow");
  // A four field cron is silently wrong and the schedule never fires.
  check("five fields", match[1].trim().split(/\s+/).length === 5, `cron is "${match[1]}"`);
  check("runs every 30 minutes", match[1].startsWith("*/30"), match[1]);
  check("on Sunday and Monday", /\*\s+\*\s+0,1$/.test(match[1].trim()), match[1]);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);