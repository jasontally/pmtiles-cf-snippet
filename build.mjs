#!/usr/bin/env node
/**
 * Build and deploy: split the archive, upload the assets, minify and deploy the
 * snippet. Runs on Workers Builds after every push.
 *
 * Steps, in order. Each step stops the script if it fails.
 *
 *   1. split    python3 shard-pmtiles.py makes the asset tree. Set
 *               ARCHIVE_PATH to an existing .pmtiles file, or set
 *               ARCHIVE_URL and the script downloads it. When the archive is
 *               missing and DOWNLOAD=0, step 1 is skipped and the asset tree
 *               already on disk is reused.
 *   2. verify   the parts must reproduce the archive byte for byte. This reads
 *               the whole tree twice, so it is skipped when SKIP_VERIFY=1.
 *   3. assets   wrangler deploy uploads the assets. Cloudflare compares content
 *               hashes and does not re-upload unchanged files, so a build that
 *               only changed a few parts uploads only those files.
 *   4. snippet  minify snippet.js, then PUT it to the Snippets API, then PUT the
 *               matching rule.
 *
 * Required environment for steps 3 and 4:
 *   CLOUDFLARE_API_TOKEN   needs Workers Scripts Edit (assets) and Snippets Edit
 *   CLOUDFLARE_ACCOUNT_ID  Workers Scripts Edit
 *   CLOUDFLARE_ZONE_ID     Workers Routes, and Snippets Edit
 *
 * Optional environment:
 *   ARCHIVE_PATH           path to the .pmtiles file
 *   ARCHIVE_URL            download URL when ARCHIVE_PATH is not set
 *   ARCHIVE_NAME           archive name in URLs (default: file stem)
 *   TILE_SHARD             tile part size (default: 2000000)
 *   LEAF_SHARD             leaf part size (default: 160000)
 *   DOWNLOAD               0 to never download (default: 1)
 *   SKIP_VERIFY            1 to skip the byte for byte check (default: 0)
 *   SKIP_ASSETS            1 to skip the asset upload (default: 0)
 *   SKIP_SNIPPET           1 to skip the snippet deploy (default: 0)
 *   SNIPPET_NAME           snippet name, a-z 0-9 and _ only (default: pmtiles)
 *   SNIPPET_RULE           rule expression (default matches /<name>.pmtiles)
 *   MINIFY_CMD             command that minifies stdin to stdout
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

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const SNIPPET_SOURCE = join(ROOT, "snippet.js");
const TOOL = join(ROOT, "shard-pmtiles.py");
const API = "https://api.cloudflare.com/client/v4";

const MAX_SNIPPET_BYTES = 32 * 1024;

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
    if (flag("DOWNLOAD", "1")) {
      fail("set ARCHIVE_PATH or ARCHIVE_URL to give the build an archive");
    }
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
  requireEnv("CLOUDFLARE_API_TOKEN");
  requireEnv("CLOUDFLARE_ACCOUNT_ID");
  run("npx", ["--yes", "wrangler@latest", "deploy"], { quiet: false });
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
  return payload;
}

async function deploySnippet() {
  if (flag("SKIP_SNIPPET", "0")) {
    console.log("SKIP_SNIPPET=1, skipping");
    return;
  }
  const zone = requireEnv("CLOUDFLARE_ZONE_ID");
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

  // Guard against a minifier that broke the code.
  const probe = `data:text/javascript;base64,${Buffer.from(small).toString("base64")}`;
  const module = await import(probe);
  if (typeof module.default?.fetch !== "function") {
    fail("the minified snippet does not export a default object with fetch()");
  }
  console.log("minified snippet parses and exports fetch()");

  const digest = createHash("sha256").update(small).digest("hex").slice(0, 12);
  console.log(`sha256:${digest}`);

  // The Snippets API takes the code as multipart form data.
  const form = new FormData();
  form.append("files", new Blob([small], { type: "application/javascript" }), "main.js");
  form.append("metadata", JSON.stringify({ main_module: "main.js" }));

  const upload = await apiCall(`/zones/${zone}/snippets/${name}`, {
    method: "PUT",
    body: form,
  });
  console.log(`snippet ${name} uploaded (${upload.result?.snippet_name || name})`);

  const expression = env(
    "SNIPPET_RULE",
    `(http.host eq "tiles.example.com" and http.request.uri.path matches "^/[^/]+\\.pmtiles$")`
  );

  // The rules endpoint replaces the whole set, so read the current rules first
  // and send them all back with ours replaced or appended.
  const existing = await apiCall(`/zones/${zone}/snippets/snippet_rules`);
  const current = existing.result?.rules || [];
  const kept = current.filter((rule) => rule.snippet_name !== name);
  const rules = [...kept, {
    description: env("SNIPPET_RULE_DESCRIPTION", "PMTiles range requests"),
    enabled: true,
    expression,
    snippet_name: name,
  }];

  const applied = await apiCall(`/zones/${zone}/snippets/snippet_rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  console.log(
    `snippet rules set: ${applied.result?.rules?.length ?? rules.length} rules, ` +
    `expression ${expression}`
  );
}

/* ---------------------------------------------------------------- *
 * Main.
 * ---------------------------------------------------------------- */

async function main() {
  const started = Date.now();
  console.log(`build started ${new Date().toISOString()}`);

  const archive = await locateArchive();

  step("split archive into asset files");
  const haveAssets = split(archive);

  if (haveAssets) {
    step("verify the asset files");
    verify(archive);

    step("upload the assets");
    deployAssets();
  } else {
    console.log("\n=== no asset tree to upload, skipping verify and upload");
  }

  step("minify and deploy the snippet");
  await deploySnippet();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nbuild finished in ${seconds}s`);
}

// Running this file directly starts the build. Importing it, as the tests do,
// must not. Compare real paths, because a caller may import through a symlink
// or a file URL, and import.meta.url is always a URL.
const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => fail(error.stack || String(error)));
}

// Exported so deploy-test.js can drive the build against a mock API.
export { main, minify as minifySource };