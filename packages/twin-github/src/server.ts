#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Boot entry (frozen contract: `node dist/src/server.js`, cwd = package
// root). Thin by design: read the env surface, open the db through the
// engine driver, load the boot seed, hand everything to the engine's
// `serve()`.

import { ensureTwinAuthSecret, serve } from "@pome-sh/sdk/server";
import { openGitHubCloneDatabase } from "./db.js";
import { loadSeedFromEnv } from "./seed.js";
import { githubTwinDefinition } from "./twin.js";

const port = Number(process.env.PORT ?? process.env.GITHUB_CLONE_PORT ?? 3333);
const host = process.env.GITHUB_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.GITHUB_CLONE_DB ?? ".github_clone/github.db";

// F-708: an env-injected TWIN_AUTH_SECRET always wins; a non-loopback bind
// with no env self-generates a secret and persists it at the compose-era
// contract location (.pome-data/github/secret). The engine's serve() runs
// the same guard; calling it here first keeps a failed boot from touching
// the filesystem (no db file is created).
ensureTwinAuthSecret("github", host);

const db = openGitHubCloneDatabase(dbPath);
// POME_SEED_JSON (FDRS-353) is strict-parsed: a malformed cloud seed fails
// the boot loudly instead of silently serving the default world.
const seed = process.env.GITHUB_CLONE_NO_SEED === "1" ? undefined : loadSeedFromEnv();

// F-698: when POME_RECORDER_EVENTS_PATH is set, createApp/serve resolves a
// durable file-backed store (twin-core transport). Otherwise heap-only.
await serve(githubTwinDefinition, {
  port,
  hostname: host,
  db,
  seed,
  runId: process.env.POME_RUN_ID ?? "spawn",
});

console.log(`GitHub clone twin listening at http://${host}:${port}`);
console.log(`REST: http://${host}:${port}`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);

if (process.env.NODE_ENV === "production" && !process.env.TWIN_ADMIN_TOKEN) {
  console.warn(
    "[twin-github] WARNING: NODE_ENV=production and TWIN_ADMIN_TOKEN is unset. " +
      "Admin endpoints (/admin/reset, /admin/seed) fall back to loopback-only and " +
      "will reject all requests with unknown remoteAddress. Set TWIN_ADMIN_TOKEN " +
      "in Infisical to authorize external admin calls."
  );
}
