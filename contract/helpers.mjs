// SPDX-License-Identifier: Apache-2.0
//
// Zero-dependency helpers for the black-box twin contract suite (FDRS-711).
// Plain node:child_process + node:crypto + global fetch, so the same suite
// can run against any built twin artifact — the workspace dist today, a
// cloud-built snapshot tomorrow (FDRS-714) — without installing this repo's
// dependencies. The wire format is the contract, not a library.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const AUTH_SECRET = "contract-suite-secret-0123456789abcdef";

const ALL_TWINS = [
  { name: "github", pkg: "packages/twin-github", dbEnv: "GITHUB_CLONE_DB", hostEnv: "GITHUB_CLONE_HOST" },
  { name: "slack", pkg: "packages/twin-slack", dbEnv: "SLACK_CLONE_DB", hostEnv: "SLACK_CLONE_HOST" },
  { name: "stripe", pkg: "packages/twin-stripe", dbEnv: "STRIPE_CLONE_DB", hostEnv: "STRIPE_CLONE_HOST" },
];

// FDRS-714: the suite can target an external built twin — e.g. a cloud-built
// Vercel Sandbox — instead of this repo's workspace dists. CONTRACT_TWIN_ONLY
// narrows the run to one twin; CONTRACT_TWIN_PKG_ROOT (absolute path) replaces
// the repo-relative package root as the spawn cwd, and only makes sense
// together with CONTRACT_TWIN_ONLY.
const only = process.env.CONTRACT_TWIN_ONLY;
if (only && !ALL_TWINS.some((t) => t.name === only)) {
  throw new Error(`CONTRACT_TWIN_ONLY=${only} is not one of: ${ALL_TWINS.map((t) => t.name).join(", ")}`);
}
export const TWIN_PKG_ROOT_OVERRIDE = process.env.CONTRACT_TWIN_PKG_ROOT;
if (TWIN_PKG_ROOT_OVERRIDE && !only) {
  throw new Error("CONTRACT_TWIN_PKG_ROOT requires CONTRACT_TWIN_ONLY to name the twin it points at");
}
export const TWINS = only ? ALL_TWINS.filter((t) => t.name === only) : ALL_TWINS;

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

/** Hand-minted HS256 session JWT — claims shape: { sid, team_id, exp, ...extra }. */
export function mintSessionJwt({ sid, teamId = "tm_contract", expSeconds = 3600, secret = AUTH_SECRET, extra = {} }) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sid, team_id: teamId, exp: Math.floor(Date.now() / 1000) + expSeconds, ...extra })
  );
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export async function freePort() {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// A twin descriptor may carry an `entry` (repo-root-relative) to boot an
// alternate server entry — used by the sdk-boot proof suite (FDRS-681).
// Default is the contract's own `dist/src/server.js`.
function entryArgs(twin) {
  return [twin.entry ? path.join(REPO_ROOT, twin.entry) : "dist/src/server.js"];
}

// Package root the twin is spawned from: the repo-relative workspace dist by
// default, or CONTRACT_TWIN_PKG_ROOT when the suite targets an external built
// twin (FDRS-714).
function twinCwd(twin) {
  return TWIN_PKG_ROOT_OVERRIDE ?? path.join(REPO_ROOT, twin.pkg);
}

/**
 * Spawn a built twin exactly the way the cloud does: `node dist/src/server.js`
 * with cwd = the package root. Resolves once GET /healthz answers 200, which
 * the contract requires within 3 seconds of spawn.
 */
export async function spawnTwin(twin, { env = {}, port: portIn, healthzDeadlineMs = 3_000 } = {}) {
  const port = portIn ?? (await freePort());
  const cwd = twinCwd(twin);
  // Plain `node` from PATH, never process.execPath: the contract is the cloud's
  // CMD ["node", "dist/src/server.js"], not process.execPath from the test runner.
  const child = spawn("node", entryArgs(twin), {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      TWIN_AUTH_SECRET: AUTH_SECRET,
      [twin.dbEnv]: ":memory:",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + healthzDeadlineMs;
  let healthz;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200) {
        healthz = await res.json();
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      await exited;
      throw new Error(
        `${twin.name}: GET /healthz did not answer 200 within ${healthzDeadlineMs}ms of spawn (contract bound).\n--- twin output ---\n${output}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  return {
    twin,
    base,
    port,
    healthz,
    output: () => output,
    exited,
    async close() {
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited;
      clearTimeout(hardKill);
    },
  };
}

/**
 * Spawn the twin entry WITHOUT the helper's default env (no auth secret
 * injection) — for boot-guard assertions. Resolves with { code, output }.
 */
export async function spawnTwinRaw(twin, env, timeoutMs = 5_000) {
  const cwd = twinCwd(twin);
  const child = spawn("node", entryArgs(twin), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await Promise.race([
    new Promise((resolve) => child.once("exit", (c) => resolve(c))),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs)),
  ]);
  return { code, output };
}

export async function req(base, pathname, { method = "GET", token, headers = {}, body } = {}) {
  const finalHeaders = { ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && !finalHeaders["content-type"]) finalHeaders["content-type"] = "application/json";
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}
