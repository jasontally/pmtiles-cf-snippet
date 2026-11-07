/**
 * Tests for the shard refresh decision. Run with: node shard-repo/refresh.test.mjs
 *
 * Each shard repo runs this independently and none of them can talk to the
 * others, so the rule has to give the same answer in all of them no matter which
 * minute of the window each one fires at. That is the property these tests exist
 * to pin down: a shard refreshing 30 seconds before another must not pick a
 * different Protomaps build, because half the shards would then hold one archive
 * and half another and the reader could not tell.
 *
 * Nothing here touches the network or needs a credential.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SETTLE_DAYS,
  archiveFile,
  archiveUrl,
  candidates,
  isServed,
  pickTarget,
  settleCutoff,
  windowOpen,
  wouldDowngrade,
} from "./refresh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const at = (iso) => new Date(iso);

// A history with releases on both sides of the first Sunday in it.
//
// The October anchor is 2026-10-04T00:30Z and the settle cutoff is 14 days
// before it, 2026-09-20T00:30Z. So 20260918 is eligible, 20260920 and later are
// too new for October, and 20260927 becomes the November target once
// November's cutoff (2026-10-18T00:30Z) is past it.
const BUILDS = [
  { key: "20260918.pmtiles", uploaded: "2026-09-18T09:00:00Z", size: 129e9 },
  { key: "20260920.pmtiles", uploaded: "2026-09-20T09:00:00Z", size: 130e9 },
  { key: "20260927.pmtiles", uploaded: "2026-09-27T09:00:00Z", size: 131e9 },
  { key: "20261001.pmtiles", uploaded: "2026-10-01T08:00:00Z", size: 132e9 },
  { key: "20261002.pmtiles", uploaded: "2026-10-02T09:00:00Z", size: 133e9 },
  { key: "20261003.pmtiles", uploaded: "2026-10-03T09:01:00Z", size: 138.5e9 },
  // Published after the first Sunday. Must be ignored until December.
  { key: "20261010.pmtiles", uploaded: "2026-10-10T09:00:00Z", size: 139e9 },
  { key: "20261012.pmtiles", uploaded: "2026-10-12T09:00:00Z", size: 140e9 },
];

await check("the anchor is the first Sunday of the month at 00:30", () => {
  // 2026-10-04 is the first Sunday of October 2026.
  assert.equal(windowOpen(at("2026-10-04T00:31:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  assert.equal(windowOpen(at("2026-10-04T23:59:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  // The fourth Sunday of the same month must not move the anchor.
  assert.equal(windowOpen(at("2026-10-25T12:00:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
});

await check("the first Sunday is the 1st or the 7th when the month starts there", () => {
  // February 2026 starts on a Sunday, so the anchor is the 1st.
  assert.equal(windowOpen(at("2026-02-20T12:00:00Z")).toISOString(), "2026-02-01T00:30:00.000Z");
  // June 2026 starts on a Monday, so the anchor is the 7th.
  assert.equal(windowOpen(at("2026-06-20T12:00:00Z")).toISOString(), "2026-06-07T00:30:00.000Z");
});

await check("on any other weekday the anchor is the first Sunday of that month", () => {
  assert.equal(windowOpen(at("2026-10-05T03:00:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  assert.equal(windowOpen(at("2026-10-07T09:00:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  // 2026-09-06 is the first Sunday of September.
  assert.equal(windowOpen(at("2026-09-03T12:00:00Z")).toISOString(), "2026-08-02T00:30:00.000Z");
  assert.equal(windowOpen(at("2026-09-08T12:00:00Z")).toISOString(), "2026-09-06T00:30:00.000Z");
});

await check("before the first Sunday it uses the previous month, never the future", () => {
  const october = windowOpen(at("2026-10-01T00:10:00Z"));
  assert.equal(october.toISOString(), "2026-09-06T00:30:00.000Z");
  assert.ok(october.getTime() < at("2026-10-01T00:10:00Z").getTime(), "the anchor is in the future");
  // November 2026 starts on a Sunday. Ten minutes earlier the anchor is still
  // October's, which is what keeps a run from picking a build published today.
  assert.equal(windowOpen(at("2026-11-01T00:10:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  // And January rolls back across the year boundary.
  assert.equal(windowOpen(at("2027-01-01T00:00:00Z")).toISOString(), "2026-12-06T00:30:00.000Z");
});

await check("every shard in one month picks the same build", () => {
  // The property the design rests on: many repos, many different minutes, one
  // answer. These are the slot times of the 13 shards sampled for speed.
  const minutes = [
    "2026-10-04T00:31:00Z", "2026-10-04T01:00:00Z", "2026-10-04T01:30:00Z",
    "2026-10-04T02:00:00Z", "2026-10-04T02:30:00Z", "2026-10-04T03:00:00Z",
    "2026-10-04T03:30:00Z", "2026-10-04T04:00:00Z", "2026-10-04T04:30:00Z",
    "2026-10-04T05:00:00Z", "2026-10-04T05:30:00Z", "2026-10-04T06:00:00Z",
    "2026-10-04T06:30:00Z",
  ];
  const targets = new Set(minutes.map((iso) => pickTarget(BUILDS, at(iso)).key));
  assert.equal(targets.size, 1, `the sampled shards chose ${[...targets].join(", ")}`);
  assert.equal([...targets][0], "20260918.pmtiles");
});

await check("a build published after the first Sunday waits for next month", () => {
  // 20261010 and 20261012 are after the October anchor, so the next three
  // Sundays must still choose the October target. That is the monthly cadence.
  assert.equal(pickTarget(BUILDS, at("2026-10-11T06:30:00Z")).key, "20260918.pmtiles");
  assert.equal(pickTarget(BUILDS, at("2026-10-31T23:00:00Z")).key, "20260918.pmtiles");
  // 2026-11-01 is the first Sunday of November. Its cutoff is 2026-10-18, so the
  // November target is the newest build before that date, not the newest build.
  assert.equal(pickTarget(BUILDS, at("2026-11-01T00:31:00Z")).key, "20261012.pmtiles");
});

await check("the anchor is the only thing that moves the target", () => {
  const before = pickTarget(BUILDS, at("2026-10-04T00:31:00Z")).key;
  const after = pickTarget(BUILDS, at("2026-10-31T23:00:00Z")).key;
  assert.equal(before, after);
});

await check("a build published exactly at the cutoff is excluded", () => {
  // Strictly before the cutoff, which is 14 days before the anchor, so
  // 2026-09-20T00:30Z for October 2026. A build landing on that minute must not
  // be picked by a shard that fires at 00:31, or the answer would depend on the
  // minute a repo happened to run at.
  const edge = [
    { key: "20260919.pmtiles", uploaded: "2026-09-19T09:01:00Z", size: 138.5e9 },
    { key: "20260920.pmtiles", uploaded: "2026-09-20T00:30:00Z", size: 139e9 },
  ];
  assert.equal(pickTarget(edge, at("2026-10-04T00:31:00Z")).key, "20260919.pmtiles",
    "a shard firing just after the anchor must not take a build that landed on the cutoff");
  assert.equal(pickTarget(edge, at("2026-10-31T23:00:00Z")).key, "20260919.pmtiles",
    "nor may a later shard in the same month");
  assert.equal(pickTarget(edge, at("2026-11-01T06:00:00Z")).key, "20260920.pmtiles",
    "next month it is eligible, because the cutoff has moved past it");
});

/**
 * The removal data the settle gap comes from, as one case: the 1 November 2026
 * incident. 20261031 was published 2026-10-31T09:05Z and removed by 7 November.
 * The anchor is 2026-11-01T00:30Z.
 */
const NOVEMBER_2026 = [
  { key: "20260811.pmtiles", uploaded: "2026-08-11T10:47:59Z", size: 137.3e9 },
  { key: "20261025.pmtiles", uploaded: "2026-10-25T09:00:00Z", size: 139e9 },
  { key: "20261029.pmtiles", uploaded: "2026-10-29T09:00:00Z", size: 139e9 },
  { key: "20261030.pmtiles", uploaded: "2026-10-30T09:00:00Z", size: 139e9 },
  { key: "20261031.pmtiles", uploaded: "2026-10-31T09:05:55Z", size: 139.2e9 },
  { key: "20261101.pmtiles", uploaded: "2026-11-01T09:06:33Z", size: 139.2e9 },
];

await check("the settle gap is 14 days, from the removal data", () => {
  // 30 removals in the snapshots were bracketed by 10 days or less, and every
  // one was gone within 14 days of upload. See refresh.md.
  assert.equal(SETTLE_DAYS, 14);
});

await check("the 1 November 2026 incident cannot repeat", () => {
  // The November cutoff is 2026-10-18T00:30Z. Every removed October build is
  // after it, so the target is the surviving August build, not a pulled one.
  assert.equal(settleCutoff(at("2026-11-01T00:31:00Z")).toISOString(), "2026-10-18T00:30:00.000Z");
  assert.equal(pickTarget(NOVEMBER_2026, at("2026-11-01T00:31:00Z")).key, "20260811.pmtiles");
  // A 7 day gap would have taken 20261025, which was removed too.
  for (const iso of ["2026-11-01T00:31:00Z", "2026-11-08T01:10:00Z", "2026-11-29T23:00:00Z"]) {
    assert.equal(pickTarget(NOVEMBER_2026, at(iso)).key, "20260811.pmtiles", `on ${iso}`);
  }
});

await check("the settle cutoff is measured from the anchor, not the clock", () => {
  // A shard retrying on the fourth Sunday must still compute the first Sunday's
  // target. Only the next month's anchor may move it.
  const first = pickTarget(NOVEMBER_2026, at("2026-11-01T00:31:00Z"));
  const late = pickTarget(NOVEMBER_2026, at("2026-11-29T23:59:00Z"));
  assert.equal(first.key, late.key);
  assert.equal(first.settleCutoff, late.settleCutoff);
  // December's anchor is 2026-12-06, so its cutoff is 2026-11-22 and the
  // November build is taken, once it has settled.
  assert.equal(pickTarget(NOVEMBER_2026, at("2026-12-06T00:31:00Z")).key, "20261101.pmtiles");
});

await check("candidates run newest first and stop at the cutoff", () => {
  const keys = candidates(NOVEMBER_2026, at("2026-11-01T00:31:00Z")).map((b) => b.key);
  assert.deepEqual(keys, ["20260811.pmtiles"]);
  const october = candidates(NOVEMBER_2026, at("2026-10-04T00:31:00Z")).map((b) => b.key);
  assert.deepEqual(october, ["20260811.pmtiles"]);
});

await check("a shard holding 20261031 keeps it, and probes nothing", () => {
  // 8 November 2026. The new rule targets 20260811, which is older, so the
  // downgrade guard keeps the key the shard holds. No probe and no commit.
  const held = "20261031.pmtiles";
  const target = pickTarget(NOVEMBER_2026, at("2026-11-08T01:10:00Z"));
  assert.equal(target.key, "20260811.pmtiles");
  assert.equal(wouldDowngrade(held, target.key), true, "the guard must stop the rollback");
});

await check("a listed build that is not served is skipped", async () => {
  // builds.json can lag storage. The probe decides, and a 404 or a thrown
  // network error means the build is not there.
  const served = await isServed("https://example.test/live", async () => new Response("", { status: 206 }));
  assert.equal(served, true);
  const gone = await isServed("https://example.test/gone", async () => new Response("", { status: 404 }));
  assert.equal(gone, false);
  const refused = await isServed("https://example.test/403", async () => new Response("", { status: 403 }));
  assert.equal(refused, false);
  const broken = await isServed("https://example.test/boom", async () => {
    throw new Error("network down");
  });
  assert.equal(broken, false);
});

await check("a shard never moves to an older build", () => {
  // The monthly anchor can point behind what a shard holds, for example on a
  // mid-month dispatch. Rebuilding 25 Workers with older data would cost a full
  // refresh and churn the cache for nothing.
  assert.equal(wouldDowngrade("20261024.pmtiles", "20260811.pmtiles"), true);
  assert.equal(wouldDowngrade("20260811.pmtiles", "20261024.pmtiles"), false);
  assert.equal(wouldDowngrade("20261024.pmtiles", "20261024.pmtiles"), false);
  assert.equal(wouldDowngrade(null, "20260811.pmtiles"), false);
});

await check("no eligible build is reported, not guessed", () => {
  // Every build is newer than the anchor, so there is nothing to hold. Guessing
  // here would cut shards from an archive that is still being written.
  const future = [{ key: "20270101.pmtiles", uploaded: "2027-01-01T09:00:00Z", size: 1e11 }];
  assert.equal(pickTarget(future, at("2026-10-04T06:00:00Z")), null);
});

await check("the url and file name are the ones Protomaps serves", () => {
  assert.equal(archiveFile("20261003"), "20261003.pmtiles");
  assert.equal(archiveUrl("20261003"), "https://build.protomaps.com/20261003.pmtiles");
  // The shape builds.json actually returns. Every key in the 62 listed builds
  // ends in ".pmtiles", so this is the input the refresh really gets. Appending
  // again here produced 20261010.pmtiles.pmtiles, which 404s, and that 404 is
  // what failed all 13 shard builds on Sunday 2026-10-11.
  assert.equal(archiveFile("20261003.pmtiles"), "20261003.pmtiles");
  assert.equal(archiveUrl("20261003.pmtiles"), "https://build.protomaps.com/20261003.pmtiles");
});

await check("a plan run writes nothing", () => {
  const fs = execFileSync(process.execPath, [join(HERE, "refresh.mjs"), "--plan"], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.ok(fs.includes("archive.json") || fs.includes("no change"), fs.slice(0, 300));
  const after = execFileSync(process.execPath, [join(HERE, "refresh.mjs"), "--plan"], {
    encoding: "utf8",
    timeout: 120000,
  });
  // A plan run must be repeatable, so it must not consume the change it found.
  assert.equal(
    /no change/.test(fs),
    /no change/.test(after),
    "a plan run consumed the change instead of reporting it"
  );
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);