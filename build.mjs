#!/usr/bin/env node
/**
 * Build and deploy: split the archive, upload the assets, minify and deploy the
 * snippet. Runs on Workers Builds after every push.
 *
 * Steps. Each step stops the script if it fails. The mode is argv[2].
 *
 *   prepare   split the archive, verify the parts, minify the snippet. Deploys
 *             nothing. This is the Workers Builds "build command".
 *   deploy    upload the assets, then upload the snippet and set its rule.
 *             This is the Workers Builds "deploy command".
 *   snippet   upload the snippet only. Use this when the deploy command stays
 *             "npx wrangler deploy" and the snippet goes in the build step.
 *   doctor    report the build settings and what the token can reach. Changes
 *             nothing. Use it to check a setup without waiting for a build.
 *   all       prepare then deploy. For running on one machine.
 *
 * In prepare: set ARCHIVE_PATH to an existing .pmtiles file, or set ARCHIVE_URL
 * and the script downloads it. With neither, the split is skipped, because the
 * repository holds no archive and 118 GiB cannot be committed.
 *
 * In deploy, the build needs no token of its own. Workers Builds injects
 * CLOUDFLARE_API_TOKEN into the build environment for wrangler, and the build
 * command reads the same value. Do not add it as a build secret: that replaces
 * Cloudflare's own token. It needs Workers Scripts Edit for the assets and
 * Snippets Edit for the snippet. The zone comes from CLOUDFLARE_ZONE_ID, or is
 * found from SNIPPET_HOST when that is not set.
 *
 * Optional environment:
 *   CLOUDFLARE_ZONE_ID     set to skip the zone lookup
 *   CLOUDFLARE_ACCOUNT_ID  accepted for compatibility, not used
 *   CLOUDFLARE_API_TOKEN   injected by Workers Builds, do not set it
 *   SNIPPET_HOST           host the rule matches (default: tiles.example.com).
 *                          Also used to find the zone.
 *   SNIPPET_RULE           full rule expression, overrides SNIPPET_HOST
 *   SNIPPET_NAME           snippet name, a-z 0-9 and _ only (default: pmtiles)
 *   ARCHIVE_PATH           path to the .pmtiles file
 *   ARCHIVE_URL            download URL when ARCHIVE_PATH is not set
 *   ARCHIVE_NAME           archive name in URLs (default: file stem)
 *   TILE_SHARD             tile part size (default: 2000000)
 *   LEAF_SHARD             leaf part size (default: 160000)
 *   DOWNLOAD               0 to never download (default: 1)
 *   SKIP_VERIFY            1 to skip the byte for byte check (default: 0)
 *   SKIP_ASSETS            1 to skip the asset upload (default: 0)
 *   SKIP_SNIPPET           1 to skip the snippet deploy (default: 0)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  foreignRules, lostRules, mergeSnippetRule, rulesMatch,
} from "./snippet-rules.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DIST_DIR = join(ROOT, "dist");
const SNIPPET_SOURCE = join(ROOT, "snippet.js");
const TOOL = join(ROOT, "shard-pmtiles.py");
const API = "https://api.cloudflare.com/client/v4";

const MAX_SNIPPET_BYTES = 32 * 1024;

// File name inside the multipart upload, and the entry point named in metadata.
// Cloudflare requires the two to agree.
const MODULE_FILE = "snippet.js";

// Same content shard-pmtiles.py writes. Kept here so a build that skips the
// split still leaves the assets directory in a deployable state.
const HEADERS_FILE =
  "/s/*\n" +
  "\tCache-Control: public, max-age=31536000, immutable\n" +
  "\tAccess-Control-Allow-Origin: *\n" +
  "\tAccess-Control-Expose-Headers: Content-Length\n";

const env = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
};
const flag = (key, fallback) => env(key, fallback) !== "0";

function step(message) {
  console.log(`\n=== ${message}`);
}

function fail(message) {
  console.error(`\nbuild failed: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.quiet ? "pipe" : "inherit",
    cwd: ROOT,
    ...options,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    if (options.quiet && result.stderr) {
      console.error(result.stderr.toString());
    }
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) fail(`set ${key} before running this step`);
  return value;
}

/* ---------------------------------------------------------------- *
 * Step 1: get the archive and split it.
 * ---------------------------------------------------------------- */

function locateArchive() {
  const path = env("ARCHIVE_PATH", "");
  if (path) {
    const full = resolve(path);
    if (!existsSync(full)) fail(`ARCHIVE_PATH ${full} does not exist`);
    return full;
  }

  const name = env("ARCHIVE_NAME", "basemap");
  const cached = join(ROOT, ".cache", `${name}.pmtiles`);
  if (existsSync(cached)) {
    console.log(`using cached archive ${cached}`);
    return cached;
  }

  const url = env("ARCHIVE_URL", "");
  if (!url) {
    // No archive is configured. This is the normal state while wiring up: the
    // repository holds no archive, because 118 GiB cannot be committed, and no
    // build variable points at one yet. Skip the split and carry on so the
    // deploy is not blocked. Set ARCHIVE_PATH or ARCHIVE_URL to upload parts.
    console.log("no ARCHIVE_PATH or ARCHIVE_URL, skipping the split");
    return null;
  }
  if (!flag("DOWNLOAD", "1")) {
    console.log(`DOWNLOAD=0, not fetching ${url}`);
    return null;
  }
  return download(url, cached);
}

async function download(url, target) {
  console.log(`downloading ${url}`);
  mkdirSync(dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) fail(`download of ${url} returned ${response.status}`);
  const total = Number(response.headers.get("content-length") || 0);
  let seen = 0;
  let lastReport = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (source) {
      for await (const chunk of source) {
        seen += chunk.length;
        const percent = total ? Math.floor((seen / total) * 100) : 0;
        if (percent >= lastReport + 10) {
          lastReport = percent;
          console.log(
            `  ${percent}% (${(seen / 1e9).toFixed(2)} GB of ` +
            `${(total / 1e9).toFixed(2)} GB)`
          );
        }
        yield chunk;
      }
    },
    (await import("node:fs")).createWriteStream(target)
  );
  console.log(`downloaded ${(seen / 1e9).toFixed(2)} GB to ${target}`);
  return target;
}

function split(archive) {
  if (!archive) {
    // No archive and no asset tree. A build that only deploys the snippet does
    // not need either, so this is a skip and not a failure.
    if (!existsSync(PUBLIC_DIR)) {
      console.log("no archive and no public/ to reuse, skipping the split");
      return false;
    }
    console.log("no archive, reusing the asset tree already in public/");
    return true;
  }
  const args = [
    TOOL, archive,
    "--out", PUBLIC_DIR,
    "--name", env("ARCHIVE_NAME", "basemap"),
    "--tile-shard", env("TILE_SHARD", "2000000"),
    "--leaf-shard", env("LEAF_SHARD", "160000"),
  ];
  run("python3", args);
  return true;
}

/* ---------------------------------------------------------------- *
 * Step 2: check the parts reproduce the archive.
 * ---------------------------------------------------------------- */

function countAssets() {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== "_headers" && entry.name !== "manifest.json") {
        files++;
        bytes += statSync(full).size;
      }
    }
  };
  if (existsSync(PUBLIC_DIR)) walk(PUBLIC_DIR);
  return { files, bytes };
}

function verify(archive) {
  if (!archive) {
    console.log("no archive to compare against, skipping");
    return;
  }
  if (flag("SKIP_VERIFY", "0")) {
    console.log("SKIP_VERIFY=1, skipping");
    return;
  }
  console.log(`verifying ${PUBLIC_DIR} against ${archive}`);
  run("python3", [
    TOOL, archive,
    "--out", PUBLIC_DIR,
    "--name", env("ARCHIVE_NAME", "basemap"),
    "--verify",
  ]);
}

/* ---------------------------------------------------------------- *
 * Step 3: upload the assets.
 * ---------------------------------------------------------------- */

/**
 * Upload the assets with wrangler.
 *
 * This only runs in "deploy" or "all" mode. In "prepare" mode Workers Builds
 * runs the deploy command itself, and running wrangler here as well would
 * upload the asset set twice on every build.
 */
function deployAssets() {
  if (flag("SKIP_ASSETS", "0")) {
    console.log("SKIP_ASSETS=1, skipping");
    return;
  }
  const { files, bytes } = countAssets();
  console.log(`${files.toLocaleString()} asset files, ${(bytes / 1e9).toFixed(2)} GB`);
  if (files > 100000) {
    fail(`${files} files exceeds the 100,000 file limit. Raise the part size.`);
  }
  // wrangler reads its own credentials from the environment. No account id is
  // needed here, and the snippet step only needs a zone.
  //
  // CLOUDFLARE_API_TOKEN needs no build variable. Workers Builds injects it for
  // wrangler, and the build command sees the same value. Adding it as a build
  // secret would replace Cloudflare's own token, so do not.
  // Cloudflare compares a content hash per file and skips unchanged ones, so a
  // build that changed a few parts uploads only those files.
  run("npx", ["--yes", "wrangler@latest", "deploy"], { quiet: false });
}

/**
 * Report what the build can and cannot do, and why. Runs no deployment and
 * changes nothing. Use it to check build settings without waiting for a build.
 */
async function doctor() {
  const settings = [
    ["CLOUDFLARE_API_TOKEN", "(secret)"],
    ["CLOUDFLARE_ZONE_ID (optional)", "(secret)"],
    ["CLOUDFLARE_ACCOUNT_ID (optional)", "(unused)"],
    ["SNIPPET_HOST (optional)", "(plain)"],
    ["SNIPPET_RULE (optional)", "(plain)"],
    ["SNIPPET_NAME (optional)", "(plain)"],
    ["ARCHIVE_PATH", "(plain)"],
    ["ARCHIVE_URL", "(plain)"],
  ];
  console.log("build settings (values are not printed):");
  for (const [key, kind] of settings) {
    const present = Boolean(process.env[key.split(" ")[0]]);
    console.log(`  ${present ? "set  " : "unset"}  ${key} ${kind}`);
  }
  for (const key of ["SNIPPET_HOST", "SNIPPET_RULE", "ARCHIVE_URL"]) {
    if (process.env[key]) console.log(`  ${key} = ${process.env[key]}`);
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.log("\nCLOUDFLARE_API_TOKEN is unset, so no API call can be made.");
    console.log("Add it as a build secret with Workers Scripts Edit and Snippets Edit.");
    return;
  }

  try {
    const verified = await apiCall("/user/tokens/verify");
    console.log(`\ntoken status: ${verified?.status || "unknown"}`);
  } catch (error) {
    console.log(`\ntoken check failed: ${error.message}`);
    return;
  }

  try {
    const zone = await resolveZone();
    console.log(`zone: ${zone.name || "(id only)"} = ${zone.id}`);
    const rules = (await apiCall(`/zones/${zone.id}/snippets/snippet_rules`)) || [];
    const named = env("SNIPPET_NAME", "pmtiles");
    const ours = rules.filter((r) => r.snippet_name === named);
    const others = foreignRules(rules, named);
    console.log(`snippet rules on the zone: ${rules.length}`);
    console.log(
      `  ours (${named}): ${ours.length}` +
      (ours.length ? ` - ${ours.map((r) => r.description).join(" | ")}` : "")
    );
    console.log(
      `  owned by others: ${others.length} ` +
      `${others.map((r) => r.snippet_name).join(", ") || "none"}`
    );
    console.log(`\nrule we would install: ${snippetRule()}`);
  } catch (error) {
    console.log(`zone check failed: ${error.message}`);
  }
}

/* ---------------------------------------------------------------- *
 * Step 4: minify and deploy the snippet.
 * ---------------------------------------------------------------- */

const IDENTIFIER = /[A-Za-z0-9_$]/;
// Tokens where a missing space would change the meaning of the code. The
// sequence "+ +" becomes "++", and "- -" becomes "--". Both change the parse.
const MERGE_UNSAFE = ["+", "-"];

/**
 * Strip comments and collapse whitespace. String and template contents are
 * copied byte for byte, so a value is never altered.
 *
 * This is not a general purpose JavaScript minifier. It does not rename
 * identifiers and it does not need to: the snippet is written to stay under the
 * 32 KB limit by itself. It exists because Workers Builds has no bundler step
 * and no minifier package is available offline.
 */
export function minify(source) {
  const out = [];
  const length = source.length;
  let index = 0;

  /** Copy one string or template literal verbatim. */
  const copyLiteral = (quote) => {
    let literal = quote;
    index++;
    while (index < length) {
      const current = source[index];
      literal += current;
      index++;
      if (current === "\\") {
        if (index < length) {
          literal += source[index];
          index++;
        }
        continue;
      }
      if (current === quote) break;
    }
    out.push({ literal });
  };

  /** Append whitespace, keeping one space only where two words would merge. */
  const pushSpace = () => {
    const previous = out.length ? out[out.length - 1] : null;
    if (!previous) return;
    const lastChar = previous.literal
      ? previous.literal[previous.literal.length - 1]
      : previous.char;
    const nextChar = peekNextNonSpace();
    const twoWords = IDENTIFIER.test(lastChar) && IDENTIFIER.test(nextChar);
    const mergesOperator = MERGE_UNSAFE.includes(lastChar) &&
      MERGE_UNSAFE.includes(nextChar) &&
      lastChar === nextChar;
    if (twoWords || mergesOperator) {
      out.push({ space: true });
    }
  };

  const peekNextNonSpace = () => {
    let ahead = index;
    while (ahead < length && /\s/.test(source[ahead])) ahead++;
    return source[ahead] || "";
  };

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        index++;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      // Whitespace before a literal must not swallow a needed space, so flush
      // any pending space decision first.
      pushSpace();
      copyLiteral(char);
      continue;
    }
    if (/\s/.test(char)) {
      pushSpace();
      while (index < length && /\s/.test(source[index])) index++;
      continue;
    }
    out.push({ char });
    index++;
  }

  return out
    .map((token) => (token.literal ? token.literal : token.space ? " " : token.char))
    .join("")
    .trim();
}

async function apiCall(path, options = {}) {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail(`${options.method || "GET"} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || payload.success === false) {
    const detail = JSON.stringify(payload.errors || payload).slice(0, 400);
    fail(`${options.method || "GET"} ${path} returned ${response.status}: ${detail}`);
  }
  return payload.result;
}

/**
 * Resolve the zone.
 *
 * CLOUDFLARE_ZONE_ID is optional. When it is absent the token looks the zone
 * up by name, which is derived from SNIPPET_HOST. So a build needs only
 * CLOUDFLARE_API_TOKEN and SNIPPET_HOST, not a zone id.
 */
async function resolveZone() {
  const explicit = env("CLOUDFLARE_ZONE_ID", "");
  if (explicit) return { id: explicit, name: env("CLOUDFLARE_ZONE_NAME", "") };

  const host = env("SNIPPET_HOST", "");
  if (!host) {
    fail("set CLOUDFLARE_ZONE_ID, or set SNIPPET_HOST so the zone can be found by name");
  }
  for (const candidate of zoneCandidates(host)) {
    const zones = await apiCall(
      `/zones?name=${encodeURIComponent(candidate)}&per_page=5`
    ) || [];
    if (zones.length === 1) {
      console.log(`zone ${zones[0].name} = ${zones[0].id} (found from ${candidate})`);
      return {
        id: zones[0].id,
        name: zones[0].name,
        accountId: zones[0].account?.id || "",
      };
    }
    if (zones.length > 1) {
      fail(`the token can see ${zones.length} zones named ${candidate}, so the zone is ambiguous`);
    }
  }
  fail(
    `the token cannot see a zone for SNIPPET_HOST ${host}. ` +
    `Tried: ${zoneCandidates(host).join(", ")}. ` +
    `Give the token Zone Resources Include permission for the zone, or set CLOUDFLARE_ZONE_ID.`
  );
}

/** A host and the parent domains, so tiles.example.com finds example.com. */
function zoneCandidates(host) {
  const out = [host];
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return [...new Set(out.filter(Boolean))];
}

/** The rule expression. SNIPPET_RULE overrides it. */
function snippetRule() {
  const override = env("SNIPPET_RULE", "");
  if (override) return override;
  const host = env("SNIPPET_HOST", "tiles.example.com");
  return `(http.host eq "${host}" and http.request.uri.path matches "^/[^/]+\\.pmtiles$")`;
}

async function deploySnippet() {
  if (flag("SKIP_SNIPPET", "0")) {
    console.log("SKIP_SNIPPET=1, skipping");
    return;
  }
  const zone = await resolveZone();
  const name = env("SNIPPET_NAME", "pmtiles");
  if (!/^[a-z0-9_]+$/.test(name)) {
    fail(`SNIPPET_NAME ${name} must use only a-z, 0-9 and _`);
  }

  const small = await minifySnippet();

  const digest = createHash("sha256").update(small).digest("hex").slice(0, 12);
  console.log(`sha256:${digest}`);

  const expression = snippetRule();

  // The rule description is the only place the zone records which build is
  // installed, because the API will not hand the snippet code back. Without it
  // there is no way to tell a zone running last week's build from this week's,
  // short from uploading again. Workers Builds injects this on every build.
  const buildId =
    process.env.WORKERS_CI_BUILD_UUID || new Date().toISOString().slice(0, 19) + "Z";
  const description = env(
    "SNIPPET_RULE_DESCRIPTION",
    `PMTiles range requests (${buildId})`
  );

  const rulesRoute = `/zones/${zone.id}/snippets/snippet_rules`;

  // A zone that never had a rule list 404s, which means "no rules" rather than
  // a failure. Anything else is real.
  const observed = await apiCall(rulesRoute).catch((error) => {
    if (/\b404\b/.test(error.message)) return null;
    throw error;
  });

  // PUT replaces the WHOLE list and this zone is shared. Merge into whatever is
  // installed rather than replacing the list, or another project's rule goes.
  const ourRule = { snippet_name: name, expression, description, enabled: true };
  const desiredRules = mergeSnippetRule(observed, ourRule);
  const foreign = foreignRules(observed, name);
  const needsRules = !rulesMatch(desiredRules, observed);

  const installed = (observed || []).find((rule) => rule.snippet_name === name);
  console.log(`zone     ${zone.name || zone.id} (${zone.id})`);
  console.log(`current  ${observed ? `${observed.length} rule(s)` : "no rule list"}`);
  console.log(
    `keeping  ${foreign.length} rule(s) owned by others: ` +
    `${foreign.map((r) => r.snippet_name).join(", ") || "none"}`
  );
  console.log(`stamp    ${installed ? installed.description : "(no rule for this snippet)"}`);
  console.log(`build    ${buildId}`);
  console.log(`rule     ${expression}`);
  console.log(`plan     rules: ${needsRules ? "update" : "already current"}`);

  // The Snippets API takes the code as multipart form data.
  const form = new FormData();
  form.append("metadata", JSON.stringify({ main_module: MODULE_FILE }));
  form.append(
    MODULE_FILE,
    new Blob([small], { type: "text/javascript" }),
    MODULE_FILE
  );
  const upload = await apiCall(`/zones/${zone.id}/snippets/${name}`, {
    method: "PUT",
    body: form,
  });
  console.log(
    `uploaded  snippet_name=${upload?.snippet_name || name} ` +
    `modified_on=${upload?.modified_on ?? "n/a"}`
  );

  if (needsRules) {
    await apiCall(rulesRoute, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: desiredRules }),
    });
    console.log(`rules     replaced with ${desiredRules.length} rule(s)`);
  } else {
    console.log("rules     unchanged");
  }

  // Read the list back and prove every foreign rule survived. A PUT that drops
  // another project's rule is silent: it returns 200 with the shortened list.
  // This is the only place that failure becomes visible.
  const finalRules = (await apiCall(rulesRoute)) || [];
  const lost = lostRules(foreign, finalRules);
  if (lost.length > 0) {
    console.error(
      `ABORT: the PUT removed rule(s) owned by another project: ` +
      `${lost.map((r) => r.snippet_name).join(", ")}. ` +
      `Restore them from the API or from the other project before anything else.`
    );
    process.exit(1);
  }
  const survivors = foreignRules(finalRules, name);
  console.log(
    `verify    ${finalRules.length} rule(s); ${survivors.length} foreign rule(s) intact: ` +
    `${survivors.map((r) => r.snippet_name).join(", ") || "none"}`
  );
}

/* ---------------------------------------------------------------- *
 * Main.
 * ---------------------------------------------------------------- */

/**
 * Prepare: split, verify, minify. Writes dist/snippet.min.js. Deploys nothing.
 */
async function prepare() {
  const archive = await locateArchive();

  step("split archive into asset files");
  const haveAssets = split(archive);

  if (haveAssets) {
    step("verify the asset files");
    verify(archive);
  } else {
    console.log("\n=== no asset tree, skipping verify");
  }

  // wrangler refuses to deploy when the assets directory is missing, and the
  // directory is missing on any build that runs before the first split. The
  // split writes _headers; this covers a build that skipped it.
  if (!existsSync(join(PUBLIC_DIR, "_headers"))) {
    console.log("writing public/_headers");
    mkdirSync(PUBLIC_DIR, { recursive: true });
    writeFileSync(join(PUBLIC_DIR, "_headers"), HEADERS_FILE);
  }

  step("minify the snippet");
  const small = await minifySnippet();
  mkdirSync(DIST_DIR, { recursive: true });
  const out = join(DIST_DIR, "snippet.min.js");
  writeFileSync(out, small);
  console.log(`wrote ${out} (${Buffer.byteLength(small)} bytes)`);
  return haveAssets;
}

/**
 * Deploy: upload the assets, then upload the snippet and set its rule.
 * The snippet goes second, so the parts are in place before the URL starts
 * answering range requests.
 */
async function deploy() {
  step("upload the assets");
  deployAssets();

  step("deploy the snippet");
  await deploySnippet();
}

/** Minify, check the size and the export, and return the code. */
async function minifySnippet() {
  const name = env("SNIPPET_NAME", "pmtiles");
  if (!/^[a-z0-9_]+$/.test(name)) {
    fail(`SNIPPET_NAME ${name} must use only a-z, 0-9 and _`);
  }
  const source = readFileSync(SNIPPET_SOURCE, "utf8");
  const small = minify(source);
  const rawBytes = Buffer.byteLength(source);
  const smallBytes = Buffer.byteLength(small);
  console.log(`snippet ${rawBytes} bytes -> ${smallBytes} bytes`);
  if (smallBytes > MAX_SNIPPET_BYTES) {
    fail(
      `minified snippet is ${smallBytes} bytes, over the ${MAX_SNIPPET_BYTES} ` +
      `byte limit. Shorten the comments and the ARCHIVES table.`
    );
  }
  const probe = `data:text/javascript;base64,${Buffer.from(small).toString("base64")}`;
  const module = await import(probe);
  if (typeof module.default?.fetch !== "function") {
    fail("the minified snippet does not export a default object with fetch()");
  }
  console.log("minified snippet parses and exports fetch()");
  console.log(`sha256:${createHash("sha256").update(small).digest("hex").slice(0, 12)}`);
  return small;
}

async function main(mode) {
  const started = Date.now();
  console.log(`build started ${new Date().toISOString()} (mode: ${mode})`);

  if (mode === "prepare") {
    await prepare();
  } else if (mode === "deploy") {
    await deploy();
  } else if (mode === "snippet") {
    // For a setup where the deploy command stays "npx wrangler deploy" and the
    // snippet upload happens in the build step instead.
    step("deploy the snippet");
    await deploySnippet();
  } else if (mode === "doctor") {
    // Reports build settings and what the token can reach. Changes nothing.
    step("check build settings");
    await doctor();
  } else {
    // "all", for running everything on one machine.
    await prepare();
    await deploy();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nbuild finished in ${seconds}s`);
}

// Running this file directly starts the build. Importing it, as the tests do,
// must not. Compare real paths, because a caller may import through a symlink
// or a file URL, and import.meta.url is always a URL.
const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const mode = process.argv[2] || "all";
  main(mode).catch((error) => fail(error.stack || String(error)));
}

// Exported so deploy-test.js can drive the build against a mock API.
export { main, minify as minifySource };