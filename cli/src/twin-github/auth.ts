// SPDX-License-Identifier: Apache-2.0
import type { MiddlewareHandler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verify } from "hono/jwt";
import { createAdminGate } from "./admin-gate.js";

export interface SessionClaims {
  sid: string;
  team_id: string;
  exp: number;
  login?: string;
}

export interface Session {
  sid: string;
  team_id: string;
  login?: string;
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

    const providerSid = verifyProviderToken("github", token);
    if (providerSid) {
      const pathSid = c.req.param("sid") ?? extractSidFromUrl(c.req.url);
      if (providerSid !== pathSid) {
        return Response.json({ message: "Forbidden", documentation_url: "" }, { status: 401 });
      }
      c.set("session", { sid: providerSid, team_id: "provider-shaped" });
      await next();
      return;
    }

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

    const session: Session = { sid: claims.sid, team_id: claims.team_id };
    if (typeof claims.login === "string" && claims.login.length > 0) session.login = claims.login;
    c.set("session", session);
    await next();
  };
}

function verifyProviderToken(provider: "github", token: string): string | undefined {
  const match = token.match(/^(?:github_pat|ghp)_pome_([^_]+)_(?:(\d+)_)?(.+)$/);
  if (!match) return undefined;
  const sid = decodeBase64Url(match[1]!);
  if (!sid) return undefined;
  const exp = match[2] ? Number(match[2]) : undefined;
  if (exp !== undefined && (!Number.isSafeInteger(exp) || exp < Math.floor(Date.now() / 1000))) {
    return undefined;
  }
  const expected = exp === undefined
    ? signProvider(provider, sid, resolveAuthSecret())
    : signProviderExp(provider, sid, exp, resolveAuthSecret());
  const actual = match[3]!;
  if (safeEqual(actual, expected)) return sid;
  return undefined;
}

function signProvider(provider: string, sid: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${provider}:${sid}`)
    .digest("base64url")
    .slice(0, 22);
}

function signProviderExp(provider: string, sid: string, exp: number, secret: string) {
  return createHmac("sha256", secret)
    .update(`${provider}:${sid}:${exp}`)
    .digest("base64url")
    .slice(0, 22);
}

function decodeBase64Url(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Admin endpoint protection. Thin wrapper over the shared, mirrored
 * admin-gate module (FDRS-587 / FDRS-616) using the GitHub error envelope
 * (which is the gate's default).
 */
export function requireAdminAuth(): MiddlewareHandler {
  return createAdminGate();
}
