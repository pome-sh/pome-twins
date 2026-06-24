// SPDX-License-Identifier: Apache-2.0
import { serve } from "@hono/node-server";
import { createGitHubCloneApp } from "./app.js";
import { openGitHubCloneDatabase } from "./db.js";
import { defaultSeedState } from "./seed.js";
import { GitHubDomain } from "./domain.js";
import { createRecorder } from "./recorder.js";

const port = Number(process.env.PORT ?? process.env.GITHUB_CLONE_PORT ?? 3333);
const host = process.env.GITHUB_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.GITHUB_CLONE_DB ?? ".github_clone/github.db";

if (!isLoopbackHost(host) && !process.env.TWIN_AUTH_SECRET) {
  throw new Error("TWIN_AUTH_SECRET is required when GitHub twin listens on a non-loopback host.");
}

const db = openGitHubCloneDatabase(dbPath);
const domain = new GitHubDomain(db);
if (process.env.GITHUB_CLONE_NO_SEED !== "1") {
  domain.seed(defaultSeedState());
}

// Wire a per-pod recorder so GET /s/:sid/_pome/events returns the real
// HTTP event log to the CLI at end-of-run. Without this the route returns
// [] and the CLI uploads a 1-byte trace.tar.gz, which is the V1 hosted-mode
// trace bug fixed in this PR. run_id comes from the spawn's env (set by
// control-plane via Fly Machines API in a future revision; for now falls
// back to "spawn").
const recorder = createRecorder();
const runId = process.env.POME_RUN_ID ?? "spawn";

const app = createGitHubCloneApp({ db, recorder, runId });
serve({ fetch: app.fetch, port, hostname: host });

console.log(`GitHub clone twin listening at http://${host}:${port}`);
console.log(`REST: http://${host}:${port}`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
