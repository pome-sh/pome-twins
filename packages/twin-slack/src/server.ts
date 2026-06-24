// SPDX-License-Identifier: Apache-2.0
import { serve } from "@hono/node-server";
import { createSlackTwinApp } from "./app.js";
import { openSlackTwinDatabase } from "./db.js";
import { SlackDomain } from "./domain.js";
import { createRecorder } from "./recorder.js";
import { loadSeedFromEnv } from "./seed.js";

const port = Number(process.env.PORT ?? process.env.SLACK_CLONE_PORT ?? 3333);
const host = process.env.SLACK_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.SLACK_CLONE_DB ?? ".slack_clone/slack.db";

if (!isLoopbackHost(host) && !process.env.TWIN_AUTH_SECRET) {
  throw new Error("TWIN_AUTH_SECRET is required when Slack twin listens on a non-loopback host.");
}

const db = openSlackTwinDatabase(dbPath);
const domain = new SlackDomain(db);
if (process.env.SLACK_CLONE_NO_SEED !== "1") {
  domain.seed(loadSeedFromEnv());
}

const recorder = createRecorder();
const runId = process.env.POME_RUN_ID ?? "spawn";

const app = createSlackTwinApp({ db, domain, recorder, runId });
serve({ fetch: app.fetch, port, hostname: host });

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

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
