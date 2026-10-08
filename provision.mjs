#!/usr/bin/env node
/**
 * Create the shard Workers and attach a Custom Domain to each.
 *
 * One archive is split across several Worker asset projects, because a Workers
 * Builds container has 20 GB of disk and 118 GiB does not fit. See sharding.md.
 *
 * This script creates the Workers and their hostnames. It does not upload any
 * data: each shard is built by its own repo through Workers Builds.
 *
 * Custom Domains rather than Routes, on purpose. A Custom Domain makes the
 * Worker the origin, and Cloudflare creates the DNS record and the certificate.
 * A Route needs a proxied DNS record to exist first, or requests never arrive.
 *
 * Required environment:
 *   CLOUDFLARE_API_TOKEN   Account Workers Scripts Edit, Zone Workers Routes
 *                          Write, Zone Snippets Edit. See the header of README.
 *   CLOUDFLARE_ACCOUNT_ID  from the dashboard, Workers overview
 *   CLOUDFLARE_ZONE_ID     from the dashboard, the zone holding the hostnames
 *
 * Optional arguments:
 *   --only N      provision only shard N. Use for a canary: verify one Worker
 *                 and one Custom Domain work before creating the rest.
 *   --from N      start at shard N, for resuming after a partial run
 *   --zones-only  attach the Custom Domains but create no Workers
 *
 * Dry run first. It prints what it would do and touches nothing:
 *   node provision.mjs --dry-run
 *
 * The recommended order:
 *   node provision.mjs --dry-run
 *   node provision.mjs --only 0
 *   curl -sI https://s.tiles0.jasontally.com/          # expect 503 placeholder
 *   node provision.mjs
 */

const API = "https://api.cloudflare.com/client/v4";

const SHARD_COUNT = 13;
// Parts per shard, from shard-plan.mjs for the Protomaps basemap.
const TILE_PARTS_PER_SHARD = 4864;
const WORKER_PREFIX = "pmtiles-shard";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const dryRun = process.argv.includes("--dry-run");

async function api(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${init.method || "GET"} ${path} -> ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok || body?.success === false) {
    const detail = (body?.errors || [])
      .map((e) => `${e.code}: ${e.message}`)
      .join("; ") || response.status;
    throw new Error(`${init.method || "GET"} ${path} -> ${response.status} ${detail}`);
  }
  return body?.result;
}

/**
 * Every hostname a shard will ever hold, so the plan can be printed and
 * checked before anything is created.
 */
export function plan({ shardCount, hostBase, workerPrefix, zoneName }) {
  const hosts = [];
  for (let i = 0; i < shardCount; i++) {
    const index = String(i).padStart(2, "0");
    hosts.push({
      index: i,
      worker: `${workerPrefix}-${index}`,
      // The first shard also carries head.bin, meta.bin, and the leaf
      // directories, because those total 324.9 MB and are much smaller than a
      // tile part.
      hostsHostnames: [],
      hostname: `${hostBase}${i}.${zoneName}`,
      firstPart: i * TILE_PARTS_PER_SHARD,
      lastPart: (i + 1) * TILE_PARTS_PER_SHARD - 1,
    });
  }
  return hosts;
}

function wranglerConfigFor(worker) {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${worker.worker}",
  "compatibility_date": "2026-10-07",
  // No main. Requests that match a part file are served by the assets platform,
  // which is free, and no Worker is invoked and billed.
  "assets": {
    "directory": "./public"
  }
}`;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const zone = process.env.CLOUDFLARE_ZONE_ID;

  const shardCount = Number(arg("shards", String(SHARD_COUNT)));
  const zoneName = arg("zone-name", "jasontally.com");
  const hostBase = arg("host-base", "s.tiles");
  const only = arg("only", null);
  const from = Number(arg("from", "0"));
  const zonesOnly = process.argv.includes("--zones-only");
  let workers = plan({ shardCount, hostBase, workerPrefix: WORKER_PREFIX, zoneName });
  if (only !== null) {
    workers = workers.filter((worker) => String(worker.index) === String(only));
    if (workers.length === 0) {
      console.error(`--only ${only} does not match a shard in 0..${shardCount - 1}`);
      process.exit(1);
    }
  }
  if (from > 0) workers = workers.filter((worker) => worker.index >= from);

  if (dryRun) {
    console.log(`shards   ${workers.length}`);
    console.log(`zone     ${zoneName} (zone id not checked in a dry run)`);
  } else {
    if (!token || !account || !zone) {
      console.error("set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ZONE_ID");
      process.exit(1);
    }
    console.log(`account  ${account}`);
    console.log(`zone     ${zone} (${zoneName})`);
  }
  console.log(`${workers.length} shards, ${TILE_PARTS_PER_SHARD} tile parts each\n`);
  console.log(`${pad("shard", 6)} ${pad("worker", 18)} ${pad("hostname", 26)} ${pad("tile parts", 18)}`);
  for (const worker of workers) {
    console.log(
      `${pad(worker.index, 6)} ${pad(worker.worker, 18)} ${pad(worker.hostname, 26)} ` +
      `${pad(`${worker.firstPart}..${worker.lastPart}`, 18)}`
    );
  }
  console.log();

  if (dryRun) {
    console.log("--dry-run: nothing was sent.");
    console.log(`\nwrangler.jsonc for shard 00:\n\n${wranglerConfigFor(workers[0])}`);
    return;
  }

  // Confirm the token can see the zone before creating anything, so a
  // permission problem is reported before 13 half-created Workers exist.
  const zoneInfo = await api(`/zones/${zone}`, token);
  console.log(`zone name from the API: ${zoneInfo.name}`);
  if (zoneInfo.name !== zoneName) {
    console.warn(`note: --zone-name was ${zoneName} but the zone is ${zoneInfo.name}`);
  }

  const existing = await api(`/accounts/${account}/workers/scripts`, token);
  const names = new Set((existing || []).map((script) => script.id));
  console.log(`account has ${names.size} Worker(s) already\n`);

  let created = 0;
  let attached = 0;
  for (const worker of workers) {
    // A Worker with assets and no main still needs a deploy to exist, and
    // there is nothing to deploy yet. So create the Worker with a placeholder
    // and let the shard's own build replace it.
    if (!zonesOnly && !names.has(worker.worker)) {
      // The part Content-Type must be application/javascript+module. Three
      // attempts established this, and each failure looks like a code problem
      // rather than a header problem:
      //
      //   main_module + text/javascript       -> "Uncaught SyntaxError:
      //                                            Unexpected token 'export'"
      //   body_part (service worker syntax)    -> "multipart uploads must
      //                                            contain a readable
      //                                            body_part, main_module,
      //                                            or assets"
      //   main_module, part with no filename   -> "No such module"
      //
      // With text/javascript the API parses the part as a service worker
      // script, so `export default` is a syntax error. The filename must match
      // main_module. The combination below works.
      const placeholder = [
        "// Placeholder. The shard build replaces this with the asset upload.",
        "export default {",
        "  fetch() {",
        "    return new Response('shard not built yet', { status: 503 });",
        "  },",
        "};",
        "",
      ].join("\n");

      const form = new FormData();
      form.set("metadata", JSON.stringify({
        main_module: "placeholder.js",
        bindings: [],
        compatibility_date: "2026-10-07",
      }));
      form.set(
        "placeholder.js",
        new Blob([placeholder], { type: "application/javascript+module" }),
        "placeholder.js"
      );
      try {
        await api(`/accounts/${account}/workers/scripts/${worker.worker}`, token, {
          method: "PUT",
          body: form,
        });
        created++;
        console.log(`created  ${worker.worker}`);
      } catch (error) {
        console.error(`FAILED   ${worker.worker}: ${error.message}`);
        continue;
      }
    } else if (zonesOnly) {
      console.log(`skipped  ${worker.worker} (--zones-only)`);
    } else {
      console.log(`exists   ${worker.worker}`);
    }

    // Attach the Custom Domain. Cloudflare makes the DNS record and the cert.
    try {
      await api(`/accounts/${account}/workers/domains`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: worker.hostname,
          service: worker.worker,
          zone_id: zone,
          environment: "production",
        }),
      });
      attached++;
      console.log(`domain   ${worker.hostname} -> ${worker.worker}`);
    } catch (error) {
      if (/already exists/i.test(error.message)) {
        console.log(`domain   ${worker.hostname} already attached`);
      } else {
        console.error(`FAILED   ${worker.hostname}: ${error.message}`);
      }
    }
  }

  console.log(`\ncreated ${created} Worker(s), attached ${attached} domain(s)`);
  console.log("\nNext: node make-repos.mjs  to create the shard repos with the template,");
  console.log("  then node wire-shards.mjs  to bind them and set SHARD_INDEX and");
  console.log("  SHARD_COUNT. The archive comes from archive.json in each repo, not from a");
  console.log("  build variable. See refresh.md.");
}

function pad(value, width) {
  return String(value).padEnd(width);
}

main().catch((error) => {
  console.error(`provision failed: ${error.message}`);
  process.exit(1);
});