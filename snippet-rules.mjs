/**
 * Pure helpers for editing one entry in the zone-wide Snippet rule list.
 *
 * `PUT /zones/{id}/snippets/snippet_rules` REPLACES the entire list. It is not a
 * per-rule PATCH. So a script that sends only its own rule deletes every other
 * rule on the zone. This zone is shared: it also runs the icanhazip snippet and
 * the MCP lookup snippet from another project. Sending a single-rule list would
 * delete them, and the API returns 200 with the shortened list, so the loss is
 * silent.
 *
 * These helpers keep every other rule byte-for-byte and replace only ours, in
 * place, so the list keeps its order and length unless it really changed.
 */

/** The only fields the rule list API accepts. `id` and `last_updated` are read-only. */
export const WRITABLE = ["snippet_name", "expression", "description", "enabled"];

/**
 * Reduce a rule from the observed list to the fields we may send back.
 * A key the API did not return stays absent rather than becoming `null`.
 */
export function writable(rule) {
  const out = {};
  for (const key of WRITABLE) {
    if (rule[key] !== undefined) out[key] = rule[key];
  }
  return out;
}

/**
 * The full list to PUT: every observed rule except ours, plus ours.
 *
 * Our rule keeps its original position when it is already on the zone, so a
 * redeploy does not reorder the list. When we are not installed yet we append,
 * which puts us last. That is safe only because our expression and the other
 * snippets' expressions are disjoint: ours matches only `*.pmtiles` on one
 * host, so two snippets cannot match the same request.
 *
 * Any duplicate rules for our snippet collapse to the single rule we send, since
 * sending one of them unchanged would leave a stale second copy.
 */
export function mergeSnippetRule(observed, ours) {
  const list = Array.isArray(observed) ? observed : [];
  const index = list.findIndex((rule) => rule.snippet_name === ours.snippet_name);
  const others = list
    .filter((rule) => rule.snippet_name !== ours.snippet_name)
    .map(writable);
  if (index === -1) return [...others, { ...ours }];
  return [...others.slice(0, index), { ...ours }, ...others.slice(index)];
}

/**
 * True when the observed list already equals what we want.
 *
 * Compares only the writable fields, and ignores position, so a rule that the
 * API stored with extra keys does not read as a change. `enabled` is compared
 * strictly because Cloudflare defaults a rule to disabled when the key is
 * omitted, and a disabled rule matches nothing.
 */
export function rulesMatch(desired, observed) {
  if (!Array.isArray(observed) || desired.length !== observed.length) return false;
  return desired.every((want, i) => {
    const got = writable(observed[i] || {});
    return WRITABLE.every((key) => got[key] === want[key]);
  });
}

/**
 * Rules on the zone that belong to another project.
 * These must survive every PUT this build makes.
 */
export function foreignRules(observed, snippetName) {
  return (Array.isArray(observed) ? observed : []).filter(
    (rule) => rule.snippet_name !== snippetName
  );
}

/**
 * Rules present in `before` but missing from `after`.
 *
 * A PUT that drops another project's rule is silent, so the build compares the
 * list it sent with the list the zone now holds and reports the difference.
 */
export function lostRules(before, after) {
  const now = Array.isArray(after) ? after : [];
  return before.filter(
    (rule) => !now.some((kept) => kept.snippet_name === rule.snippet_name)
  );
}