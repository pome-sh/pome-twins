// SPDX-License-Identifier: Apache-2.0
//
// `pome twin start <twin>` (F-709) — the docker-free front door. Boots any
// of the three twins as a long-lived foreground server (Ctrl-C to stop) on
// the same in-process boot path `pome run --local` uses (`bootTwin`), so
// `npx @pome-sh/cli twin start github` serves the identical control plane
// the packaged twin entries serve, with zero installs beyond Node ≥ 24.
//
// Auth: the twin's bearer middleware reads `TWIN_AUTH_SECRET` from the env
// (engine contract). The CLI resolves the secret the same way an operator
// would — an env-injected `TWIN_AUTH_SECRET` always wins, else the secret a
// prior twin boot persisted at `.pome-data/<twin>/secret` (F-708 write side;
// `POME_TWIN_DATA_DIR` overrides the directory) is reused, else a per-boot
// ephemeral secret is generated. Loopback binds deliberately do NOT persist
// a new secret file — that mirrors F-708's loopback carve-out, and the
// ready-to-use JWT is reprinted on every boot anyway.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { defaultSeedState as defaultSlackSeedState } from "@pome-sh/twin-slack";
import { defaultSeed as defaultStripeSeed } from "@pome-sh/twin-stripe";
import { bootTwin } from "./twinHarness.js";

export const SUPPORTED_STANDALONE_TWINS = ["github", "slack", "stripe"] as const;

/** The fixed session id a standalone twin serves under (`/s/standalone`). */
const STANDALONE_SID = "standalone";

export type StandaloneAuthSecret = {
  secret: string;
  source: "env" | "persisted" | "ephemeral";
  /** Set when `source` is "persisted": the file the secret was read from. */
  path?: string;
};

/**
 * Read side of the F-708 secret contract. Resolution order:
 *   1. env `TWIN_AUTH_SECRET` (always wins — same rule as the twin boots)
 *   2. the persisted `.pome-data/<twin>/secret` (`POME_TWIN_DATA_DIR`
 *      overrides the directory); blank file = absent, < 32 chars = loud
 *      error (never mint against a weak HS256 key, never guess)
 *   3. a fresh per-boot secret, NOT persisted (loopback dev path)
 */
export function resolveStandaloneAuthSecret(
  twin: string,
  env: NodeJS.ProcessEnv = process.env,
): StandaloneAuthSecret {
  const injected = env.TWIN_AUTH_SECRET;
  if (injected) return { secret: injected, source: "env" };

  const dataDir = env.POME_TWIN_DATA_DIR || join(".pome-data", twin);
  const secretPath = join(dataDir, "secret");
  let raw: string | undefined;
  try {
    raw = readFileSync(secretPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const persisted = raw?.trim() ?? "";
  if (persisted.length >= 32) {
    return { secret: persisted, source: "persisted", path: secretPath };
  }
  if (persisted.length > 0) {
    // Same rule as the engine's readSecretFile (F-708): a short secret is
    // operator content we must not silently serve or regenerate over.
    throw new Error(
      `The persisted secret at ${secretPath} is shorter than 32 chars — fix or delete the file, or inject TWIN_AUTH_SECRET.`,
    );
  }
  return { secret: randomBytes(32).toString("hex"), source: "ephemeral" };
}

function defaultSeedFor(twin: string): unknown {
  switch (twin) {
    case "slack":
      return defaultSlackSeedState();
    case "stripe":
      return defaultStripeSeed();
    default:
      // github: bootTwin's adapter seeds the default world when the seed is
      // undefined (pre-existing standalone behavior).
      return undefined;
  }
}

export async function runTwinStartCommand(
  name: string,
  options: { port?: string },
): Promise<void> {
  if (!(SUPPORTED_STANDALONE_TWINS as readonly string[]).includes(name)) {
    throw new Error(
      `Unknown twin '${name}'. Supported: ${SUPPORTED_STANDALONE_TWINS.join(", ")}.`,
    );
  }
  // `PORT` fallback keeps the spawn surface env-drivable (the contract
  // suite injects PORT, same as the packaged twin entries).
  const portRaw = options.port ?? process.env.PORT ?? "3333";
  const port = Number(portRaw);
  // Port 0 (ephemeral) is rejected: every printed URL and the status-file
  // token would name a port nobody can discover from outside the process.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`pome twin start: invalid --port "${portRaw}"`);
  }

  const resolved = resolveStandaloneAuthSecret(name);
  // The in-process twin's auth middleware (resolveAuthSecret) reads the env;
  // pinning the resolved secret here is what makes the minted JWT and the
  // running twin agree.
  process.env.TWIN_AUTH_SECRET = resolved.secret;

  const baseUrl = `http://127.0.0.1:${port}`;
  const harness = await bootTwin({
    twin: name,
    seedState: defaultSeedFor(name),
    runId: STANDALONE_SID,
    twinBaseUrl: baseUrl,
  });
  const token = await sign(
    {
      sid: STANDALONE_SID,
      team_id: "tm_local",
      // Same claims `pome run --local` mints: `login` so the GitHub REST
      // merge gate resolves the agent user; twin-supplied extras (stripe's
      // `account_id`) so the token lands on the seeded account.
      login: "pome-agent",
      ...(harness.extraClaims ?? {}),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    resolved.secret,
  );

  const restUrl = `${baseUrl}/s/${STANDALONE_SID}`;
  const mcpUrl = `${restUrl}/mcp`;
  const server = serve({ fetch: harness.app.fetch, port, hostname: "127.0.0.1" });

  await mkdir(".pome", { recursive: true });
  await writeFile(
    ".pome/twin-status.json",
    JSON.stringify(
      { name, url: restUrl, rest_url: restUrl, mcp_url: mcpUrl, auth_token: token },
      null,
      2,
    ),
  );

  console.log(`Pome ${name} twin listening at ${restUrl}`);
  if (resolved.source === "persisted") {
    console.log(
      `Auth: using the persisted secret from ${resolved.path} (an env-injected TWIN_AUTH_SECRET overrides it).`,
    );
  }
  console.log(`POME_${harness.envName}_REST_URL=${restUrl}`);
  console.log(`POME_${harness.envName}_MCP_URL=${mcpUrl}`);
  console.log(`POME_AUTH_TOKEN=${token}`);
  // F28 — every `/s/<sid>/*` endpoint requires a Bearer JWT, including
  // /s/standalone/healthz. New users curling the printed `${restUrl}` get
  // HTTP 401 and assume the twin is broken. The unauth liveness probe lives
  // at the root `/healthz`. Print the curl command so copy-paste debugging
  // works without a JWT.
  console.log(`Health check (no auth): curl ${baseUrl}/healthz`);
  console.log("Ctrl-C to stop.");

  // Foreground server: the bound socket keeps the event loop alive until a
  // signal lands. Graceful path closes the listener, then flushes the
  // recorder and releases the SQLite handle via the harness.
  const shutdown = () => {
    void (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
