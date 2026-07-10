// SPDX-License-Identifier: Apache-2.0
//
// Internal helpers for `@pome-sh/sdk/server` (`createApp`/`serve`). Split
// out of server.ts (F-685) purely for module-size hygiene; everything a twin
// may import (TwinBootError, isLoopbackHost) is re-exported from server.ts,
// which stays the only public entry.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESERVED_SESSION_PREFIXES, type ToolSpec, type TwinDefinition } from "./index.js";
import { UnknownToolError } from "./errors.js";

export class TwinBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwinBootError";
  }
}

/** Engine-owned `/_pome/*` route names a twin's `pomeRoutes` may not shadow. */
export const POME_CORE_ROUTE_NAMES = new Set(["health", "state", "events"]);

export function makeDeltaSink() {
  let delta: import("@pome-sh/shared-types").RecorderEvent["state_delta"] = null;
  return {
    report(d: import("@pome-sh/shared-types").RecorderEvent["state_delta"]) {
      delta = d;
    },
    value() {
      return delta;
    },
  };
}

/** Hostnames the boot guard treats as loopback binds. */
export function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

/**
 * F-708: self-generate `TWIN_AUTH_SECRET` on first boot. An env-injected
 * secret always wins (pome-cloud injects per-tenant secrets — that contract
 * is untouched), and loopback binds keep the dev-fallback path. Otherwise
 * the secret persisted at the compose-era contract location
 * `.pome-data/<twin>/secret` (cwd-relative; `POME_TWIN_DATA_DIR` overrides
 * the directory) is reused, or a fresh 32-byte hex secret is generated,
 * persisted there, and printed once to stdout so the operator can mint JWTs.
 *
 * The resolved secret lands in `process.env.TWIN_AUTH_SECRET`, which is
 * process-global by design: the engine's auth (`resolveAuthSecret`) reads
 * the env, so one process serves one secret — the frozen boot contract is
 * one twin per process, and a multi-twin process shares the first secret.
 */
export function ensureTwinAuthSecret(twin: string, host: string): void {
  if (process.env.TWIN_AUTH_SECRET) return;
  if (isLoopbackHost(host)) return;

  const dataDir = process.env.POME_TWIN_DATA_DIR || join(".pome-data", twin);
  const secretPath = join(dataDir, "secret");

  try {
    const persisted = readSecretFile(secretPath);
    if (persisted) {
      process.env.TWIN_AUTH_SECRET = persisted;
      console.log(`[twin-${twin}] TWIN_AUTH_SECRET not set — using the persisted secret from ${secretPath}`);
      return;
    }

    const secret = randomBytes(32).toString("hex");
    mkdirSync(dataDir, { recursive: true });
    try {
      // Compose-era file format: hex secret + trailing newline, owner-only.
      // "wx" never clobbers a secret written by a concurrent first boot.
      writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const winner = readSecretFile(secretPath);
      if (winner) {
        process.env.TWIN_AUTH_SECRET = winner;
        console.log(`[twin-${twin}] TWIN_AUTH_SECRET not set — using the persisted secret from ${secretPath}`);
        return;
      }
      // A blank file is an aborted earlier write: remove it and retry the
      // exclusive write, so a concurrent booter losing this second race
      // adopts the winner's secret instead of overwriting it.
      rmSync(secretPath, { force: true });
      try {
        writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== "EEXIST") throw err2;
        const late = readSecretFile(secretPath);
        if (!late) throw err2;
        process.env.TWIN_AUTH_SECRET = late;
        console.log(`[twin-${twin}] TWIN_AUTH_SECRET not set — using the persisted secret from ${secretPath}`);
        return;
      }
    }
    process.env.TWIN_AUTH_SECRET = secret;
    console.log(
      `[twin-${twin}] TWIN_AUTH_SECRET not set — generated ${secret} (persisted to ${secretPath}; subsequent boots reuse it, an env-injected TWIN_AUTH_SECRET overrides it)`
    );
  } catch (err) {
    if (err instanceof TwinBootError) throw err;
    throw new TwinBootError(
      `TWIN_AUTH_SECRET is not set and self-generating one at ${secretPath} failed: ${(err as Error).message}`
    );
  }
}

/** The persisted secret, trimmed; undefined when absent or blank. */
function readSecretFile(secretPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(secretPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // The compose-era contract documents >= 32 chars. A shorter file (hand
  // edit, truncation) must fail the boot loudly — never silently serve a
  // weak HS256 key, and never silently regenerate over operator content.
  if (trimmed.length < 32) {
    throw new TwinBootError(
      `TWIN_AUTH_SECRET is not set and the persisted secret at ${secretPath} is shorter than 32 chars — fix or delete the file, or inject TWIN_AUTH_SECRET.`
    );
  }
  return trimmed;
}

export function shadowedPrefix(routePath: string): string | null {
  for (const prefix of RESERVED_SESSION_PREFIXES) {
    if (routePath === prefix || routePath.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

export function assertUniqueToolNames<TDomain>(
  tools: ReadonlyArray<ToolSpec<TDomain>>,
  twinId: string
) {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new TwinBootError(`Twin "${twinId}" has duplicate tool name: ${tool.name}`);
    }
    seen.add(tool.name);
  }
}

export function findTool<TDb, TSeed, TDomain>(
  definition: TwinDefinition<TDb, TSeed, TDomain>,
  name: string
): ToolSpec<TDomain> {
  const tool = definition.tools.find((t) => t.name === name);
  if (!tool) {
    throw new UnknownToolError(name);
  }
  return tool;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    const cloned = req.clone();
    const text = await cloned.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    return null;
  }
}

/**
 * Convenience helper for `recorder.handle` inner functions. Returns a
 * 200 response with the supplied `mutation` flag (default: false). Mirrors
 * `packages/twin-github/src/app.ts:ok`.
 */
export function ok(body: unknown, mutation = false): { status: 200; body: unknown; mutation: boolean } {
  return { status: 200, body, mutation };
}

/**
 * Convenience helper for `recorder.handle` inner functions. Returns a
 * 201 response with `mutation: true`. Mirrors
 * `packages/twin-github/src/app.ts:created`.
 */
export function created(body: unknown): { status: 201; body: unknown; mutation: true } {
  return { status: 201, body, mutation: true };
}
