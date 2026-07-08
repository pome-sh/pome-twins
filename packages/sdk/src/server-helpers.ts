// SPDX-License-Identifier: Apache-2.0
//
// Internal helpers for `@pome-sh/sdk/server` (`createApp`/`serve`). Split
// out of server.ts (F-685) purely for module-size hygiene; everything a twin
// may import (TwinBootError, isLoopbackHost) is re-exported from server.ts,
// which stays the only public entry.

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
