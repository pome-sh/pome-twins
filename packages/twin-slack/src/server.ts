// SPDX-License-Identifier: Apache-2.0
//
// Boot entry (frozen contract: `node dist/src/server.js`, cwd = package
// root). Thin by design: read the env surface, open the db through the
// engine driver, load the boot seed, hand everything to the engine's
// `serve()`.

import { TwinBootError, isLoopbackHost, serve } from "@pome-sh/sdk/server";
import { openSlackTwinDatabase } from "./db.js";
import { loadSeedFromEnv } from "./seed.js";
import { slackTwinDefinition } from "./twin.js";

const port = Number(process.env.PORT ?? process.env.SLACK_CLONE_PORT ?? 3333);
const host = process.env.SLACK_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.SLACK_CLONE_DB ?? ".slack_clone/slack.db";

// The engine's serve() enforces the same guard; checking here first keeps
// the refused boot from touching the filesystem (no db file is created).
if (!isLoopbackHost(host) && !process.env.TWIN_AUTH_SECRET) {
  throw new TwinBootError(
    `TWIN_AUTH_SECRET is required when a twin listens on a non-loopback host (${host}).`
  );
}

const db = openSlackTwinDatabase(dbPath);
// POME_SEED_JSON (FDRS-353) is strict-parsed: a malformed cloud seed fails
// the boot loudly instead of silently serving the default world.
const seed = process.env.SLACK_CLONE_NO_SEED === "1" ? undefined : loadSeedFromEnv();

await serve(slackTwinDefinition, {
  port,
  hostname: host,
  db,
  seed,
  runId: process.env.POME_RUN_ID ?? "spawn",
});

console.log(`Slack twin listening at http://${host}:${port}`);
console.log(`REST: http://${host}:${port}`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);

if (process.env.NODE_ENV === "production" && !process.env.TWIN_ADMIN_TOKEN) {
  console.warn(
    "[twin-slack] WARNING: NODE_ENV=production and TWIN_ADMIN_TOKEN is unset. " +
      "Admin endpoints (/admin/reset, /admin/seed) fall back to loopback-only and " +
      "will reject all requests with unknown remoteAddress. Set TWIN_ADMIN_TOKEN " +
      "in Infisical to authorize external admin calls."
  );
}
