/**
 * Tests for the zone-wide Snippet rule list merge.
 *
 * PUT /zones/{id}/snippets/snippet_rules replaces the whole list. This zone also
 * runs snippets owned by other projects. These tests exist so a future change to
 * the merge cannot quietly start deleting another project's rules again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foreignRules, lostRules, mergeSnippetRule, rulesMatch,
} from "./snippet-rules.mjs";

const OURS = {
  snippet_name: "pmtiles",
  expression: '(http.host eq "tiles.jasontally.com" and http.request.uri.path matches "^/[^/]+\\.pmtiles$")',
  description: "PMTiles range requests (build-123)",
  enabled: true,
};

/** A rule as the API returns it: writable fields plus read-only ones. */
function observedRule(snippet_name, expression) {
  return {
    id: `id-${snippet_name}`,
    description: `rule for ${snippet_name}`,
    enabled: true,
    last_updated: "2026-10-01T23:44:44.87655Z",
    expression,
    snippet_name,
  };
}

const ICANHAZIP = observedRule(
  "icanhazip",
  '(http.host in {"ip.jasontally.com" "city.jasontally.com"})'
);
const MCP_LOOKUP = observedRule(
  "mcp_lookup",
  '(http.host eq "mac.jasontally.com")'
);

test("a foreign rule survives the merge", () => {
  const merged = mergeSnippetRule([ICANHAZIP, MCP_LOOKUP], OURS);
  assert.deepEqual(
    merged.map((r) => r.snippet_name),
    ["icanhazip", "mcp_lookup", "pmtiles"]
  );
});

test("a foreign rule keeps its expression, description and enabled flag", () => {
  const merged = mergeSnippetRule([ICANHAZIP, MCP_LOOKUP], OURS);
  for (const name of ["icanhazip", "mcp_lookup"]) {
    const kept = merged.find((r) => r.snippet_name === name);
    assert.equal(kept.expression, observedRule(name, kept.expression).expression);
    assert.equal(kept.description, `rule for ${name}`);
    assert.equal(kept.enabled, true);
  }
});

test("read-only fields are stripped from the rules we send back", () => {
  const merged = mergeSnippetRule([ICANHAZIP, MCP_LOOKUP], OURS);
  for (const rule of merged) {
    assert.equal(rule.id, undefined, "id is read-only and must not be sent");
    assert.equal(rule.last_updated, undefined, "last_updated is read-only");
  }
});

test("our rule keeps its position when already installed", () => {
  const observed = [
    ICANHAZIP,
    observedRule("pmtiles", "(an old expression)"),
    MCP_LOOKUP,
  ];
  const merged = mergeSnippetRule(observed, OURS);
  assert.deepEqual(
    merged.map((r) => r.snippet_name),
    ["icanhazip", "pmtiles", "mcp_lookup"],
    "a redeploy must not move our rule to the end"
  );
  assert.equal(merged[1].expression, OURS.expression, "and must replace it");
});

test("a duplicate rule for our snippet collapses to one", () => {
  const observed = [
    observedRule("pmtiles", "(old a)"),
    ICANHAZIP,
    observedRule("pmtiles", "(old b)"),
  ];
  const merged = mergeSnippetRule(observed, OURS);
  assert.equal(
    merged.filter((r) => r.snippet_name === "pmtiles").length,
    1,
    "two stale copies would both match the same requests"
  );
  assert.equal(merged.length, 2);
});

test("an empty zone is handled", () => {
  assert.deepEqual(mergeSnippetRule([], OURS), [OURS]);
  assert.deepEqual(mergeSnippetRule(null, OURS), [OURS]);
  assert.deepEqual(mergeSnippetRule(undefined, OURS), [OURS]);
});

test("rulesMatch reports no change for an identical list", () => {
  const observed = [ICANHAZIP, OURS];
  assert.equal(rulesMatch(observed, [ICANHAZIP, { ...OURS }]), true);
});

test("rulesMatch ignores read-only keys the API added", () => {
  const desired = [ICANHAZIP, OURS];
  const observed = [
    { ...ICANHAZIP, id: "x", last_updated: "later" },
    { ...OURS, id: "y", last_updated: "later" },
  ];
  assert.equal(rulesMatch(desired, observed), true);
});

test("rulesMatch sees a changed expression", () => {
  const desired = [ICANHAZIP, OURS];
  const observed = [ICANHAZIP, { ...OURS, expression: "(different)" }];
  assert.equal(rulesMatch(desired, observed), false);
});

test("rulesMatch sees a changed length", () => {
  assert.equal(rulesMatch([ICANHAZIP, OURS], [ICANHAZIP]), false);
  assert.equal(rulesMatch([ICANHAZIP], [ICANHAZIP, OURS]), false);
});

test("rulesMatch treats a disabled rule as a change", () => {
  // Cloudflare defaults a rule to disabled when the key is omitted, and a
  // disabled rule matches nothing. So enabled must be compared strictly.
  const desired = [ICANHAZIP, OURS];
  const observed = [ICANHAZIP, { ...OURS, enabled: false }];
  assert.equal(rulesMatch(desired, observed), false);
});

test("foreignRules excludes only ours", () => {
  assert.deepEqual(
    foreignRules([ICANHAZIP, OURS, MCP_LOOKUP], "pmtiles").map((r) => r.snippet_name),
    ["icanhazip", "mcp_lookup"]
  );
});

test("lostRules finds a rule the PUT dropped", () => {
  assert.deepEqual(
    lostRules([ICANHAZIP, MCP_LOOKUP], [OURS]).map((r) => r.snippet_name),
    ["icanhazip", "mcp_lookup"]
  );
  assert.deepEqual(
    lostRules([ICANHAZIP, MCP_LOOKUP], [ICANHAZIP, OURS, MCP_LOOKUP]),
    [],
    "a surviving rule must not read as lost"
  );
});