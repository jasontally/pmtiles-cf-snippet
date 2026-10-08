/**
 * Tests for the deploy path in build.mjs. Run with: node deploy-test.js
 *
 * These run against a mock Cloudflare API, so they check the requests the build
 * sends without real credentials and without touching a live zone.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "build.mjs");

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

/** A mock Cloudflare API that records what the build sent. */
async function mockApi() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      // Record a snapshot. Two rules calls land on the same URL, so a reference
      // to the live array would be overwritten by the second.
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/zones?name=")) {
        // Answer a zone name lookup the way Cloudflare would.
        const wanted = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("name"));
        if (wanted === "example.com") {
          res.end(JSON.stringify({
            success: true,
            result: [{
              id: "zone-from-lookup",
              name: "example.com",
              account: { id: "acct-from-lookup" },
            }],
          }));
          return;
        }
        res.end(JSON.stringify({ success: true, result: [] }));
        return;
      }
      if (req.url === "/user/tokens/verify") {
        res.end(JSON.stringify({ success: true, result: { status: "active" } }));
        return;
      }
      if (req.url.endsWith("/snippet_rules")) {
        // The API returns the rule list as a bare array in `result`, and each
        // rule carries read-only id and last_updated fields.
        res.end(JSON.stringify({
          success: true,
          result: [
            {
              id: "rule-icanhazip",
              snippet_name: "icanhazip",
              expression: '(http.host in {"ip.jasontally.com"})',
              description: "another project on this zone",
              enabled: true,
              last_updated: "2026-10-01T00:00:00Z",
            },
            {
              id: "rule-mcp",
              snippet_name: "mcp_lookup",
              expression: '(http.host eq "mac.jasontally.com")',
              description: "another project on this zone",
              enabled: true,
              last_updated: "2026-10-01T00:00:00Z",
            },
          ],
        }));
        return;
      }
      res.end(JSON.stringify({ success: true, result: { snippet_name: "pmtiles" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    base: `http://127.0.0.1:${server.address().port}`,
    // closeAllConnections matters: node fetch keeps connections alive, so a
    // plain close() waits forever and the test hangs.
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

/**
 * Run build.mjs in a child process with fetch pointed at the mock API.
 * env overrides the environment. Returns the spawn result.
 */
/**
 * Run build.mjs in a child process with fetch pointed at the mock API.
 * env overrides the environment. Resolves to { status, stdout, stderr }.
 *
 * This must be async. The mock server runs in this process, so the event loop
 * here has to stay free to answer the child's requests. A sync spawn would block
 * that loop and the two processes would wait on each other.
 */
function runBuild(env, apiBase, mode) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-test-"));
  const shim = join(dir, "shim.mjs");
  writeFileSync(shim, `
const original = globalThis.fetch;
const base = ${JSON.stringify(apiBase)};
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  return original(url.replace("https://api.cloudflare.com/client/v4", base), init);
};
const { main } = await import(${JSON.stringify(BUILD)});
await main(${JSON.stringify(mode || "all")});
process.exit(0);
`);
  return new Promise((resolve) => {
    const child = spawn("node", [shim], {
      cwd: dirname(BUILD),
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_ZONE_ID: "",
        ARCHIVE_PATH: "",
        ARCHIVE_URL: "",
        SKIP_ASSETS: "1",
        DOWNLOAD: "0",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}

const CREDENTIALS = {
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_ZONE_ID: "zone123",
};

await check("uploads the minified snippet and sets the rule", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base);
    assert.equal(run.status, 0, `build failed:\n${run.stdout}\n${run.stderr}`);

    const upload = api.requests.find((r) => r.url === "/zones/zone123/snippets/pmtiles");
    assert.ok(upload, "did not PUT the snippet");
    assert.equal(upload.method, "PUT");
    assert.ok(
      upload.headers.authorization === "Bearer test-token",
      `expected a bearer token, got ${upload.headers.authorization}`
    );
    assert.ok(upload.body.includes("main_module"), "must send metadata.main_module");
    assert.ok(upload.body.includes("export default"), "must contain the code");
    assert.ok(
      !upload.body.includes("Ceiling:"),
      "comments should be stripped by the minifier"
    );
  } finally {
    await api.close();
  }
});

await check("keeps every other snippet rule on the shared zone", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base);
    assert.equal(run.status, 0, `build failed:\n${run.stdout}\n${run.stderr}`);

    // PUT replaces the whole list, so the body must carry the other rules.
    const puts = api.requests.filter(
      (r) => r.url.endsWith("/snippet_rules") && r.method === "PUT"
    );
    assert.ok(puts.length >= 1, "did not PUT any rules");
    const sent = JSON.parse(puts.at(-1).body).rules;

    const names = sent.map((r) => r.snippet_name);
    assert.ok(names.includes("icanhazip"), `icanhazip was dropped: ${JSON.stringify(names)}`);
    assert.ok(names.includes("mcp_lookup"), `mcp_lookup was dropped: ${JSON.stringify(names)}`);
    assert.ok(names.includes("pmtiles"), "our rule is missing");
    assert.equal(new Set(names).size, names.length, "duplicate rules were sent");

    // A foreign rule keeps its own expression and enabled flag.
    const kept = sent.find((r) => r.snippet_name === "icanhazip");
    assert.equal(kept.expression, '(http.host in {"ip.jasontally.com"})');
    assert.equal(kept.enabled, true);
    assert.equal(kept.description, "another project on this zone");

    // Read-only fields must not be sent back.
    for (const rule of sent) {
      assert.equal(rule.id, undefined, "id is read-only");
      assert.equal(rule.last_updated, undefined, "last_updated is read-only");
    }
  } finally {
    await api.close();
  }
});

await check("does not reorder the rule list on a redeploy", async () => {
  const api = await mockApi();
  try {
    await runBuild(CREDENTIALS, api.base);
    await runBuild(CREDENTIALS, api.base);
    const puts = api.requests.filter(
      (r) => r.url.endsWith("/snippet_rules") && r.method === "PUT"
    );
    const names = JSON.parse(puts.at(-1).body).rules.map((r) => r.snippet_name);
    assert.deepEqual(
      names,
      ["icanhazip", "mcp_lookup", "pmtiles"],
      `the list changed order: ${JSON.stringify(names)}`
    );
  } finally {
    await api.close();
  }
});

await check("reports the foreign rules it kept and verifies they survived", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base);
    assert.match(
      run.stdout,
      /keeping {2}2 rule\(s\) owned by others: icanhazip, mcp_lookup/,
      "must name the rules it kept"
    );
    assert.match(
      run.stdout,
      /verify {4}\d+ rule\(s\); 2 foreign rule\(s\) intact/,
      "must read the list back and confirm the foreign rules"
    );
  } finally {
    await api.close();
  }
});

await check("records the build id so a stale zone is visible", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(
      { ...CREDENTIALS, WORKERS_CI_BUILD_UUID: "11111111-2222-3333-4444-555555555555" },
      api.base
    );
    assert.match(run.stdout, /build {4}11111111-2222-3333-4444-555555555555/);
    const puts = api.requests.filter(
      (r) => r.url.endsWith("/snippet_rules") && r.method === "PUT"
    );
    const ours = JSON.parse(puts.at(-1).body).rules.find((r) => r.snippet_name === "pmtiles");
    assert.ok(
      ours.description.includes("11111111-2222-3333-4444-555555555555"),
      `description was ${JSON.stringify(ours.description)}`
    );
  } finally {
    await api.close();
  }
});

await check("uploads the snippet as multipart with main_module", async () => {
  const api = await mockApi();
  try {
    await runBuild(CREDENTIALS, api.base);
    const upload = api.requests.find((r) => /\/snippets\/pmtiles$/.test(r.url));
    assert.equal(upload.method, "PUT");
    assert.ok(
      String(upload.headers["content-type"]).startsWith("multipart/form-data"),
      `expected multipart, got ${upload.headers["content-type"]}`
    );
    assert.ok(upload.body.includes('name="metadata"'), "metadata part is required");
    assert.ok(upload.body.includes('"main_module"'), "metadata must name the entry point");
    assert.ok(upload.body.includes('name="snippet.js"'), "the module part must be present");
  } finally {
    await api.close();
  }
});
await check("uses SNIPPET_RULE when it is set", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(
      { ...CREDENTIALS, SNIPPET_RULE: 'http.host eq "tiles.example.com"' },
      api.base
    );
    assert.equal(run.status, 0, run.stderr);
    const puts = api.requests.filter(
      (r) => r.url.endsWith("/snippet_rules") && r.method === "PUT"
    );
    const mine = JSON.parse(puts.at(-1).body).rules.find((r) => r.snippet_name === "pmtiles");
    assert.equal(mine.expression, 'http.host eq "tiles.example.com"');
  } finally {
    await api.close();
  }
});

await check("refuses a snippet name Cloudflare will not accept", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild({ ...CREDENTIALS, SNIPPET_NAME: "Bad-Name" }, api.base);
    assert.notEqual(run.status, 0, "a bad snippet name must fail the build");
    assert.ok(
      run.stderr.includes("a-z, 0-9 and _"),
      `expected a clear message, got: ${run.stderr.slice(0, 300)}`
    );
    assert.equal(
      api.requests.filter((r) => r.url.includes("/snippets/")).length,
      0,
      "nothing should be sent when the name is invalid"
    );
  } finally {
    await api.close();
  }
});

await check("names the missing secret", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild({ CLOUDFLARE_ACCOUNT_ID: "acct" }, api.base);
    assert.notEqual(run.status, 0, "a missing secret must fail the build");
    assert.ok(
      /set CLOUDFLARE_(API_TOKEN|ZONE_ID)/.test(run.stderr),
      `expected a message naming the secret, got: ${run.stderr.slice(0, 300)}`
    );
  } finally {
    await api.close();
  }
});

await check("reports an API error with the reason", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      requests.push(req.url);
      res.setHeader("content-type", "application/json");
      res.statusCode = 403;
      res.end(JSON.stringify({
        success: false,
        errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await runBuild(CREDENTIALS, base);
    assert.notEqual(run.status, 0, "an API error must fail the build");
    assert.ok(
      run.stderr.includes("9109") || run.stderr.includes("Unauthorized"),
      `expected the API message, got: ${run.stderr.slice(0, 300)}`
    );
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});

await check("a non JSON API reply fails clearly", async () => {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 502;
      res.end("<html>bad gateway</html>");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await runBuild(CREDENTIALS, base);
    assert.notEqual(run.status, 0, "a non JSON reply must fail the build");
    assert.ok(
      run.stderr.includes("returned 502") || run.stderr.includes("502"),
      `expected the status in the message, got: ${run.stderr.slice(0, 300)}`
    );
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});

await check("prepare mode deploys nothing", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base, "prepare");
    assert.equal(run.status, 0, `build failed:\n${run.stdout}\n${run.stderr}`);
    assert.equal(
      api.requests.length,
      0,
      "prepare must not call the API, otherwise the snippet uploads twice"
    );
    // It still minifies, so a size regression fails the build step.
    assert.match(run.stdout, /snippet \d+ bytes -> \d+ bytes/);
    assert.match(run.stdout, /minified snippet parses/);
  } finally {
    await api.close();
  }
});

await check("prepare writes dist/snippet.min.js", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base, "prepare");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /wrote .*dist\/snippet\.min\.js/);
  } finally {
    await api.close();
  }
});

await check("a missing archive skips the split instead of failing", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base, "prepare");
    assert.equal(run.status, 0, `must not fail:\n${run.stderr}`);
    assert.match(
      run.stdout,
      /no ARCHIVE_PATH or ARCHIVE_URL, skipping the split/,
      "should say it skipped the split"
    );
  } finally {
    await api.close();
  }
});

await check("finds the zone from SNIPPET_HOST when no zone id is set", async () => {
  const api = await mockApi();
  try {
    // Without a zone id the build must look the zone up by name. Answer the
    // lookup the way Cloudflare would.
    const original = api.requests;
    await runBuild(
      { ...CREDENTIALS, CLOUDFLARE_ZONE_ID: "", SNIPPET_HOST: "tiles.example.com" },
      api.base,
      "deploy"
    );
    const lookup = original.find((r) => r.url.startsWith("/zones?name="));
    assert.ok(lookup, "did not look the zone up by name");
    assert.ok(lookup.url.includes("tiles.example.com"), lookup.url);
    // It must then use the returned id for the snippet calls.
    const upload = original.find((r) => /^\/zones\/[^/]+\/snippets\/pmtiles$/.test(r.url));
    assert.ok(upload, "did not upload with the resolved zone id");
    assert.ok(
      upload.url.startsWith("/zones/zone-from-lookup/"),
      `upload used ${upload.url}, expected the id from the lookup`
    );
  } finally {
    await api.close();
  }
});

await check("doctor reports the settings without changing anything", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base, "doctor");
    assert.equal(run.status, 0, `doctor must not fail:\n${run.stderr}`);
    assert.match(run.stdout, /build settings/);
    assert.match(run.stdout, /CLOUDFLARE_API_TOKEN/);
    // A diagnostic must never deploy.
    assert.equal(
      api.requests.filter((r) => /\/snippets\/pmtiles$/.test(r.url)).length,
      0,
      "doctor must not upload the snippet"
    );
  } finally {
    await api.close();
  }
});

await check("the wrangler name matches the Worker name", async () => {
  // Workers Builds fails the build when this does not match the Worker name in
  // the dashboard, so the test pins the value.
  const config = readFileSync(join(dirname(BUILD), "wrangler.jsonc"), "utf8");
  const name = /"name"\s*:\s*"([^"]+)"/.exec(config);
  assert.ok(name, "wrangler.jsonc has no name");
  assert.equal(name[1], "pmtiles-cf-snippet", "the Worker name must match the dashboard");
});

await check("public/_headers is committed so the assets directory exists", () => {
  // wrangler refuses to deploy when the assets directory is missing, and the
  // first build has no archive, so nothing creates public/.
  const headers = join(dirname(BUILD), "public", "_headers");
  assert.ok(existsSync(headers), "public/_headers must be committed");
  const text = readFileSync(headers, "utf8");
  assert.ok(text.includes("/s/*"), "the rule must cover the part files");
  assert.ok(
    text.includes("max-age=31536000"),
    "parts are immutable, so they must be cached for a year"
  );
});

await check("reports the minified size and the hash", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base);
    assert.match(run.stdout, /snippet \d+ bytes -> \d+ bytes/);
    assert.match(run.stdout, /sha256:[0-9a-f]{12}/);
    assert.match(run.stdout, /minified snippet parses/);
  } finally {
    await api.close();
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);