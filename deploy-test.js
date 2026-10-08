/**
 * Tests for the deploy path in build.mjs. Run with: node deploy-test.js
 *
 * These run against a mock Cloudflare API, so they check the requests the build
 * sends without real credentials and without touching a live zone.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      if (req.url.endsWith("/snippet_rules")) {
        res.end(JSON.stringify({
          success: true,
          result: {
            rules: [
              {
                description: "an existing rule",
                enabled: true,
                expression: "true",
                snippet_name: "other",
              },
            ],
          },
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

await check("keeps existing snippet rules when setting ours", async () => {
  const api = await mockApi();
  try {
    const run = await runBuild(CREDENTIALS, api.base);
    assert.equal(run.status, 0, `build failed:\n${run.stderr}`);

    // The build reads the current rules then writes the set, so there are two
    // calls. Take the last one, which carries the body.
    const calls = api.requests.filter((r) => r.url === "/zones/zone123/snippets/snippet_rules");
    assert.ok(calls.length >= 1, "did not touch the snippet rules");
    const sent = JSON.parse(calls.at(-1).body);
    assert.ok(Array.isArray(sent.rules));
    assert.ok(
      sent.rules.some((r) => r.snippet_name === "other"),
      "the endpoint replaces the whole set, so an existing rule was dropped"
    );
    const mine = sent.rules.find((r) => r.snippet_name === "pmtiles");
    assert.ok(mine, "our rule is missing");
    assert.ok(mine.expression.includes(".pmtiles"), `expression was ${mine.expression}`);
    assert.equal(mine.enabled, true);
  } finally {
    await api.close();
  }
});

await check("a second build does not duplicate the rule", async () => {
  const api = await mockApi();
  try {
    await runBuild(CREDENTIALS, api.base);
    await runBuild(CREDENTIALS, api.base);
    const rules = api.requests
      .filter((r) => r.url === "/zones/zone123/snippets/snippet_rules")
      .at(-1);
    const sent = JSON.parse(rules.body);
    const ours = sent.rules.filter((r) => r.snippet_name === "pmtiles");
    assert.equal(ours.length, 1, `expected 1 rule for us, got ${ours.length}`);
    assert.equal(sent.rules.length, 2, "expected our rule plus the existing one");
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
    const calls = api.requests.filter((r) => r.url === "/zones/zone123/snippets/snippet_rules");
    const mine = JSON.parse(calls.at(-1).body).rules.find((r) => r.snippet_name === "pmtiles");
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

await check("the wrangler name matches the Worker name", async () => {
  // Workers Builds fails the build when this does not match the Worker name in
  // the dashboard, so the test pins the value.
  const config = readFileSync(join(dirname(BUILD), "wrangler.jsonc"), "utf8");
  const name = /"name"\s*:\s*"([^"]+)"/.exec(config);
  assert.ok(name, "wrangler.jsonc has no name");
  assert.equal(name[1], "pmtiles-cf-snippet", "the Worker name must match the dashboard");
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