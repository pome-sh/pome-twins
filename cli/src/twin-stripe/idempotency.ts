// SPDX-License-Identifier: Apache-2.0
// Per D-ENG-7 / E-7: `Idempotency-Key` middleware backed by the
// `idempotency_keys` table. Behavior:
//   - GET / HEAD → never cache.
//   - Missing header → never cache.
//   - Header present + cache hit + matching request hash → return cached
//     response (status + body) untouched, do NOT invoke the handler.
//   - Header present + cache hit + different hash → 400 with code
//     `idempotency_key_in_use`.
//   - Header present + miss → invoke handler; on response, store row.
import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { stripeError } from "./errors.js";
import type {
  IdempotencyKeyRow,
  Recorder,
  ResolvedSession,
  TwinStripeDatabase,
} from "./types.js";
import { nowIso, requestId } from "./util.js";

const CACHEABLE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type CachedResponse = { status: number; bodyText: string };

function hashRequest(method: string, path: string, body: string): string {
  return createHash("sha256")
    .update(method)
    .update("\0")
    .update(path)
    .update("\0")
    .update(body)
    .digest("hex");
}

function getAccountId(c: Context): string {
  const session = c.get("session") as ResolvedSession | undefined;
  // Admin/healthz routes have no session; bucket them by sid path param if
  // present, otherwise the sentinel "_anon" (admin idempotency rarely matters).
  if (session) return session.account_id;
  const sid = c.req.param("sid");
  return sid ? `acct_${sid}` : "_anon";
}

export function idempotencyMiddleware(
  db: TwinStripeDatabase,
  recorder?: Recorder,
  runId: string = "local"
): MiddlewareHandler {
  const select = db.prepare(
    `SELECT key, account_id, method, path, request_hash, response_status, response_body_json, created_at
       FROM idempotency_keys
      WHERE key = ? AND account_id = ? AND method = ? AND path = ?`
  );
  const insert = db.prepare(
    `INSERT INTO idempotency_keys
       (key, account_id, method, path, request_hash, response_status, response_body_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key, account_id, method, path) DO NOTHING`
  );
  const pending = new Map<string, { requestHash: string; promise: Promise<CachedResponse> }>();

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (!CACHEABLE_METHODS.has(method)) {
      await next();
      return;
    }

    const headerKey = c.req.header("Idempotency-Key") ?? c.req.header("idempotency-key");
    if (!headerKey) {
      await next();
      return;
    }

    const startedAt = Date.now();
    const account_id = getAccountId(c);
    const path = new URL(c.req.url).pathname;

    // Read raw body once; downstream handlers will re-parse via c.req.json().
    // Hono buffers the body so re-reading is fine.
    const rawBody = await c.req.raw
      .clone()
      .text()
      .catch(() => "");
    const requestHash = hashRequest(method, path, rawBody);
    const pendingKey = [headerKey, account_id, method, path].join("\0");

    const existing = select.get(headerKey, account_id, method, path) as
      | IdempotencyKeyRow
      | undefined;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        const env = stripeError(
          "idempotency_error",
          "idempotency_key_in_use",
          `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${headerKey}'.`,
          { statusCode: 400 }
        );
        return c.json(env.body, env.status as never);
      }
      let cachedBody: unknown;
      try {
        cachedBody = JSON.parse(existing.response_body_json);
      } catch {
        cachedBody = null;
      }
      // Replay cached response untouched, but emit a dedupe RecorderEvent
      // so the retry is visible to the dashboard / correlator. The original
      // mutation is already in the recorder from the first call; this event
      // carries idempotency_dedupe=true + state_mutation=false +
      // state_delta=null so it can't be confused with a real mutation.
      recordDedupeEvent(c, recorder, runId, startedAt, rawBody, {
        status: existing.response_status,
        body: cachedBody,
      });
      return c.json(cachedBody, existing.response_status as never);
    }

    const inFlight = pending.get(pendingKey);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash) {
        const env = stripeError(
          "idempotency_error",
          "idempotency_key_in_use",
          `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${headerKey}'.`,
          { statusCode: 400 }
        );
        return c.json(env.body, env.status as never);
      }
      const cached = await inFlight.promise;
      if (cached.status < 400) {
        const cachedBody = parseCachedBody(cached.bodyText);
        recordDedupeEvent(c, recorder, runId, startedAt, rawBody, {
          status: cached.status,
          body: cachedBody,
        });
        return c.json(cachedBody, cached.status as never);
      }
      await next();
      return;
    }

    let resolvePending!: (value: CachedResponse) => void;
    let rejectPending!: (reason?: unknown) => void;
    const promise = new Promise<CachedResponse>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    pending.set(pendingKey, { requestHash, promise });

    try {
      await next();
    } catch (error) {
      rejectPending(error);
      pending.delete(pendingKey);
      throw error;
    }

    // On the way out: capture response and persist the row. Only cache
    // 2xx/3xx — 4xx and 5xx are not cached so a client with a typo in
    // its first request can retry under the same key against a fresh
    // handler invocation. Real Stripe re-executes on 4xx for client
    // errors; mirroring that is F5.
    try {
      const status = c.res.status;
      if (status >= 400) {
        resolvePending({ status, bodyText: "null" });
        return;
      }
      const cloned = c.res.clone();
      let bodyText = "";
      try {
        bodyText = await cloned.text();
      } catch {
        bodyText = "";
      }
      // Validate the body is JSON; fall back to "null" if not (still cacheable).
      try {
        JSON.parse(bodyText);
      } catch {
        bodyText = "null";
      }

      insert.run(
        headerKey,
        account_id,
        method,
        path,
        requestHash,
        status,
        bodyText,
        nowIso()
      );
      resolvePending({ status, bodyText });
    } catch (error) {
      rejectPending(error);
      throw error;
    } finally {
      pending.delete(pendingKey);
    }
  };
}

function recordDedupeEvent(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  startedAt: number,
  rawBody: string,
  cached: { status: number; body: unknown }
) {
  if (!recorder) return;
  const reqId = requestId();
  recorder.record({
    ts: new Date().toISOString(),
    run_id: runId,
    twin: "stripe",
    request_id: reqId,
    correlation_id: reqId,
    scenario_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
    step_id: null,
    tool_call_id: null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: rawBody === "" ? null : rawBody,
    status: cached.status,
    response_body: cached.body,
    latency_ms: Date.now() - startedAt,
    fidelity: "semantic",
    state_mutation: false,
    state_delta: null,
    idempotency_dedupe: true,
    error: null,
  });
}

function parseCachedBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}
