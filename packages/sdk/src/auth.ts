// SPDX-License-Identifier: Apache-2.0
//
// Bearer-token + localhost-only middleware. Mirrors the semantics of
// `packages/twin-github/src/auth.ts`: a session JWT must carry `sid` that
// matches the `/s/:sid` path segment, and admin routes are only reachable
// from a localhost client.
import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  sid: string;
  team_id: string;
  exp: number;
}

export function resolveAuthSecret(): string {
  const secret = process.env.TWIN_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("TWIN_AUTH_SECRET required in production");
  }
  return secret ?? "dev-only-insecure-secret";
}

function unauthorized(message: string) {
  return Response.json({ message, documentation_url: "" }, { status: 401 });
}

function extractSidFromUrl(rawUrl: string): string | undefined {
  try {
    const path = new URL(rawUrl).pathname;
    const match = path.match(/^\/s\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return unauthorized("Bad credentials");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) return unauthorized("Bad credentials");

    let claims: SessionClaims;
    try {
      claims = (await verify(token, resolveAuthSecret(), "HS256")) as unknown as SessionClaims;
    } catch {
      return unauthorized("Bad credentials");
    }

    if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
      return unauthorized("Token expired");
    }

    const pathSid = c.req.param("sid") ?? extractSidFromUrl(c.req.url);
    if (!claims.sid || claims.sid !== pathSid) {
      return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 401 });
    }

    c.set("session", { sid: claims.sid, team_id: claims.team_id });
    await next();
  };
}

export function requireAdminAuth(): MiddlewareHandler {
  return async (c, next) => {
    const adminToken = process.env.TWIN_ADMIN_TOKEN;
    if (adminToken && adminToken.length > 0) {
      const provided = c.req.header("X-Admin-Token") ?? c.req.header("x-admin-token");
      if (!provided) {
        return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 403 });
      }
      const a = Buffer.from(provided);
      const b = Buffer.from(adminToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 403 });
      }
      await next();
      return;
    }
    const remote: string | undefined = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
      ?.remoteAddress;
    if (!remote) {
      if (process.env.NODE_ENV === "production") {
        return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 403 });
      }
      await next();
      return;
    }
    const isLocal =
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1" ||
      remote === "localhost";
    if (!isLocal) {
      return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 403 });
    }
    await next();
  };
}

export const localhostOnly = requireAdminAuth;
