/**
 * Tests for the template push. Run with: node shard-repo/make-repos.test.mjs
 *
 * The push copies shard-repo/ over a clone of a shard repo. The one file it must
 * not change is archive.json, because that is the shard's own state and the
 * refresh workflow owns it.
 *
 * On 7 November 2026 a version of stage() deleted archive.json from
 * pmtiles-shard-00. The shard then had no record of the build it held, and the
 * next build would have taken the 2024 seed key. These tests exist so that
 * cannot happen again.
 *
 * Nothing here touches the network or needs a credential.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stage } from "../make-repos.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** A directory that looks like a clone of shard 3. */
function cloneWith(archiveJson) {
  const dir = mkdtempSync(join(tmpdir(), "shard-clone-"));
  if (archiveJson !== null) writeFileSync(join(dir, "archive.json"), archiveJson);
  return dir;
}

const HELD = `${JSON.stringify(
  {
    key: "20261031.pmtiles",
    url: "https://build.protomaps.com/20261031.pmtiles",
    note: "Which Protomaps Basemap build this shard holds.",
  },
  null,
  2
)}\n`;

check("the template push keeps the shard's own archive.json", () => {
  const dir = cloneWith(HELD);
  try {
    stage(3, dir);
    const after = readFileSync(join(dir, "archive.json"), "utf8");
    assert.equal(after, HELD, "the shard's archive.json was changed");
    assert.ok(after.includes("20261031"), "the shard lost the build it holds");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the template push fills in the Worker name and the repo name", () => {
  const dir = cloneWith(HELD);
  try {
    stage(3, dir);
    assert.ok(readFileSync(join(dir, "wrangler.jsonc"), "utf8").includes("pmtiles-shard-03"));
    assert.ok(readFileSync(join(dir, "package.json"), "utf8").includes('"pmtiles-shard-03"'));
    assert.ok(readFileSync(join(dir, "README.md"), "utf8").includes("shard 3"));
    assert.ok(readFileSync(join(dir, ".github/workflows/refresh.yml"), "utf8").startsWith("name: Refresh shard 03"));
    assert.ok(readFileSync(join(dir, ".github/workflows/verify.yml"), "utf8").startsWith("name: Verify shard 03"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a clone with no archive.json is refused, not stripped", () => {
  const dir = cloneWith(null);
  try {
    assert.throws(() => stage(3, dir), /no archive\.json/, "a missing file must stop the push");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a new repo gets the seed archive.json and no template-only files", () => {
  const dir = stage(3);
  try {
    assert.ok(readFileSync(join(dir, "archive.json"), "utf8").includes("20241021"), "the seed key");
    for (const only of ["render-workflow.mjs", "make-repos.test.mjs"]) {
      assert.throws(() => readFileSync(join(dir, only)), `${only} must not ship`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
