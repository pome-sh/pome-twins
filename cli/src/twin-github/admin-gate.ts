// SPDX-License-Identifier: Apache-2.0
// MIRRORED FILE — byte-identical copies enforced by
// scripts/check-admin-gate-mirrors.mjs (root script `lint:admin-gate-mirrors`,
// wired into .github/workflows/ci.yml). Edit the canonical copy, then re-copy.
//
// Canonical: packages/sdk/src/admin-gate.ts
// Mirrors:   packages/twin-github/src/admin-gate.ts
//            packages/twin-slack/src/admin-gate.ts
//            packages/twin-stripe/src/admin-gate.ts
//            cli/src/twin-github/admin-gate.ts
//            cli/src/twin-slack/admin-gate.ts
//
// Shared admin-endpoint gate (FDRS-587 / FDRS-616). Twins cannot depend on
// @pome-sh/sdk (twin-stripe is vendored into the CLI as a file: tarball, so
// a workspace dep would break off-workspace installs) — hence the mirror
// pattern, same as redaction.ts.
//
// Tiered policy (semantics unchanged from the per-twin copies it replaces):
//   1. TWIN_ADMIN_TOKEN set → require X-Admin-Token to match (timing-safe).
//   2. TWIN_ADMIN_TOKEN unset + client IP known → allow only loopback.
//   3. TWIN_ADMIN_TOKEN unset + client IP unknown → deny in production,
//      allow otherwise (accepted fail-open for in-process test harnesses).

import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

/** Context variable consulted first by getClientIp(). */
export const CLIENT_IP_VAR = "pomeClientIp";

type ClientIpEnv = { Variables: { pomeClientIp?: string } };

type ConnInfoLike = { remote?: { address?: string } };
type GetConnInfoFn = (c: Context) => ConnInfoLike;

let nodeGetConnInfo: Promise<GetConnInfoFn | undefined> | undefined;

// Lazily import the node bridge's official ConnInfo helper. Dynamic because
// @pome-sh/sdk declares @hono/node-server as an *optional* peer dependency —
// a static import would crash consumers that never bind a Node socket.
// Works with both @hono/node-server v1 and v2 (same subpath + signature).
function loadNodeGetConnInfo(): Promise<GetConnInfoFn | undefined> {
  nodeGetConnInfo ??= import("@hono/node-server/conninfo").then(
    (mod) => mod.getConnInfo as unknown as GetConnInfoFn,
    () => undefined
  );
  return nodeGetConnInfo;
}

/**
 * Explicitly record the peer address for this request. Alternate serving
 * bridges (or tests) call this from an upstream middleware so the gate never
 * reaches into runtime-private internals.
 *
 * SECURITY: the value passed here MUST be the transport-level peer address
 * (the socket's remote address as reported by the serving bridge). It takes
 * precedence over getConnInfo, so deriving it from any request-controlled
 * input — X-Forwarded-For or any other client-supplied header — would make
 * the loopback-only admin gate spoofable by whoever sets that header. If you
 * are behind a reverse proxy, use TWIN_ADMIN_TOKEN instead of trying to
 * recover the "real" client IP.
 */
export function setClientIp(c: Context, ip: string): void {
  (c as Context<ClientIpEnv>).set(CLIENT_IP_VAR, ip);
}

/**
 * Runtime-neutral client-IP accessor (FDRS-587). Resolution order:
 *   1. Explicit override set via setClientIp() (alternate bridges / tests).
 *   2. The node serving bridge's official getConnInfo helper.
 *   3. undefined — no live socket (e.g. app.request() in-process tests).
 */
export async function getClientIp(c: Context): Promise<string | undefined> {
  const override = (c as Context<ClientIpEnv>).get(CLIENT_IP_VAR);
  if (typeof override === "string" && override.length > 0) return override;
  const getConnInfo = await loadNodeGetConnInfo();
  if (!getConnInfo) return undefined;
  try {
    const address = getConnInfo(c).remote?.address;
    return typeof address === "string" && address.length > 0 ? address : undefined;
  } catch {
    // The helper throws when the context has no node socket behind it.
    return undefined;
  }
}

export function isLoopbackAddress(remote: string): boolean {
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote === "localhost"
  );
}

export interface AdminGateOptions {
  /** 403 response factory so each twin keeps its own error envelope. */
  forbidden?: () => Response;
}

function defaultForbidden(): Response {
  return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 403 });
}

/**
 * Admin endpoint protection shared by every twin (FDRS-616). Each twin's
 * auth.ts wraps this with its own `forbidden` envelope. Semantics are
 * identical to the per-twin requireAdminAuth() copies this replaces.
 */
export function createAdminGate(options: AdminGateOptions = {}): MiddlewareHandler {
  const forbidden = options.forbidden ?? defaultForbidden;
  return async (c, next) => {
    const adminToken = process.env.TWIN_ADMIN_TOKEN;
    if (adminToken && adminToken.length > 0) {
      // Web Headers lookups are case-insensitive, so one lookup covers every
      // casing a client might send.
      const provided = c.req.header("X-Admin-Token");
      if (!provided) return forbidden();
      const a = Buffer.from(provided);
      const b = Buffer.from(adminToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return forbidden();
      await next();
      return;
    }
    const remote = await getClientIp(c);
    if (!remote) {
      if (process.env.NODE_ENV === "production") return forbidden();
      await next();
      return;
    }
    if (!isLoopbackAddress(remote)) return forbidden();
    await next();
  };
}
