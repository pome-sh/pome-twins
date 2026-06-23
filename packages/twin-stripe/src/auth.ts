// SPDX-License-Identifier: Apache-2.0
// Dual auth (D-ENG-1) — accept BOTH:
//   - Stripe-style API keys: `Authorization: Bearer sk_test_pome_<sid>...`
//     (resolved via the api_keys table)
//   - JWTs with `sid` claim: `Authorization: Bearer <jwt>` or just `<jwt>`
//     (the twin-github MCP-client shape)
//
// Either path resolves to a sid, which must match the URL's :sid param. A
// mismatch is 403, not 401, so the agent gets a clear "you have a valid
// credential but for the wrong session" signal.
import type { Context, MiddlewareHandler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verify } from "hono/jwt";
import { looksLikeApiKey, resolveSidFromKey } from "./api-keys.js";
import { forbidden, unauthorized } from "./errors.js";
import type { ResolvedSession, SessionClaims, TwinStripeDatabase } from "./types.js";

export function resolveAuthSecret(): string {
  const secret = process.env.TWIN_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("TWIN_AUTH_SECRET required in production");
  }
  return secret ?? "dev-only-insecure-secret";
}

function jsonError(envelope: { status: number; body: unknown }) {
  return Response.json(envelope.body, { status: envelope.status });
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

function readBearer(c: Context): string | undefined {
  const header = c.req.header("Authorization") ?? c.req.header("authorization");
  if (!header) return undefined;
  // Accept "Bearer <token>" (Stripe SDK shape), "bearer <token>" (case-
  // insensitive), and "<token>" (twin-github MCP-client backwards compat).
  const trimmed = header.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

export function bearerAuth(db: TwinStripeDatabase): MiddlewareHandler {
  return async (c, next) => {
    const token = readBearer(c);
    if (!token) return jsonError(unauthorized("Bad credentials"));

    // Path may or may not carry a :sid prefix. The path-prefixed mount
    // (`/s/:sid/...`) requires the bearer-resolved sid match the path
    // sid; the SDK-compat root mount (`/v1/...`) skips the comparison
    // and trusts the bearer alone (F3). Either way, we resolve a
    // session from the bearer.
    const pathSid = c.req.param("sid") ?? extractSidFromUrl(c.req.url);

    let resolved: ResolvedSession | undefined;

    if (looksLikeApiKey(token)) {
      const row = resolveSidFromKey(db, token);
      if (row) {
        resolved = { sid: row.sid, account_id: row.account_id, via: "api_key" };
      } else {
        const providerSid = verifyProviderToken("stripe", token);
        if (!providerSid) return jsonError(unauthorized("Invalid API Key provided."));
        resolved = { sid: providerSid, account_id: `acct_${providerSid}`, via: "api_key" };
      }
    } else {
      // JWT path. Mirrors twin-github exactly.
      let claims: SessionClaims;
      try {
        claims = (await verify(
          token,
          resolveAuthSecret(),
          "HS256"
        )) as unknown as SessionClaims;
      } catch {
        return jsonError(unauthorized("Bad credentials"));
      }
      if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
        return jsonError(unauthorized("Token expired"));
      }
      if (!claims.sid) return jsonError(unauthorized("Bad credentials"));
      resolved = {
        sid: claims.sid,
        account_id: claims.account_id ?? `acct_${claims.sid}`,
        via: "jwt"
      };
    }

    // Only enforce sid match when the URL has a :sid component. Root-
    // mounted /v1/* requests carry no path sid; the bearer alone is
    // sufficient and the resolved sid is whatever the bearer says.
    if (pathSid && resolved.sid !== pathSid) {
      return jsonError(forbidden("Session id mismatch."));
    }

    c.set("session", resolved);
    await next();
  };
}

function verifyProviderToken(provider: "stripe", token: string): string | undefined {
  const match = token.match(/^sk_test_pome_([^_]+)_(.+)$/);
  if (!match) return undefined;
  const sid = decodeBase64Url(match[1]!);
  if (!sid) return undefined;
  const expected = signProvider(provider, sid, resolveAuthSecret());
  const actual = match[2]!;
  if (safeEqual(actual, expected)) return sid;
  return undefined;
}

function signProvider(provider: string, sid: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${provider}:${sid}`)
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

export function localhostOnly(): MiddlewareHandler {
  return async (c, next) => {
    const remote: string | undefined = (
      c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    )?.incoming?.socket?.remoteAddress;
    if (!remote) {
      // No socket info → in-process invocation (e.g., vitest app.request).
      // Treat as localhost.
      await next();
      return;
    }
    const isLocal =
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1" ||
      remote === "localhost";
    if (!isLocal) return jsonError(forbidden("Forbidden"));
    await next();
  };
}
