// SPDX-License-Identifier: Apache-2.0
//
// The Stripe twin as a thin `@pome-sh/sdk` plugin (F-684). This manifest is
// pure declaration: domain factory, seed schema, tools, routes, and the
// wire-frozen Stripe shapes (FDRS-711 / F-712) — errors.ts envelopes, the
// liberal-bearer + 403-sid-mismatch + root-/v1/*-mount auth pins, healthz
// extras (fidelity + tthw_seconds), the 501 unsupported envelope, the
// admin-gate 403 body. All mechanism (HTTP mount, auth, recorder +
// redaction, MCP dispatch, /_pome/*, admin gate, db driver, failure
// injection) lives in the engine.
//
// Unlike slack/github the definition is built by a FACTORY: the manifest
// closes over the database (api_keys credential lookup, idempotency cache,
// admin reset/seed) and a per-app failure-injection store, so each app gets
// its own. Always pass the same `db` here and to `createApp`/`serve`.

import { z, ZodError } from "zod";
import {
  defineTwin,
  type ToolCallContext,
  type TwinDefinition,
} from "@pome-sh/sdk";
import {
  UnknownToolError,
  createFailureInjectionStore,
  failureInjectionMiddleware,
  twinBuildInfo,
  type RecorderStore,
  type SessionValue,
} from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { createApp } from "@pome-sh/sdk/server";
import type { RouteContext } from "@pome-sh/sdk";
import { resolveSidFromKey } from "./api-keys.js";
import { openTwinStripeDatabase, resetDatabase } from "./db.js";
import { StripeDomain } from "./domain/index.js";
import { TwinError, forbidden, stripeError, unauthorized, unsupported } from "./errors.js";
import { looksLikeApiKey } from "./api-keys.js";
import { idempotencyMiddleware } from "./idempotency.js";
import { registerStripeRoutes } from "./routes/index.js";
import { applySeed, defaultSeed, seedSchema } from "./seed.js";
import { registerX402Routes } from "./session.js";
import { executeTool, isMutatingTool, listTools, toolDefinitions } from "./tools.js";
import type { SeedState, TwinStripeDatabase } from "./types.js";

// Stripe admin/seed is tolerant: an absent body falls back to the default
// seed (frozen: garbage object → 200 {ok:true, ...}; seedSchema defaults
// every collection). Malformed collections still fail loudly via zod.
const stripeSeedSchema = z.preprocess(
  (value) => (value === null || value === undefined ? defaultSeed() : value),
  seedSchema
) as unknown as z.ZodType<SeedState>;

/** `tthw_seconds` (Time To Hello World) per D-DX-4 / §22 — wall clock from process start. */
export function tthwSeconds(startedAtMs: number, nowMs: () => number = Date.now) {
  const ms = Math.max(0, nowMs() - startedAtMs);
  return Number((ms / 1000).toFixed(3));
}

function accountIdFrom(session: SessionValue | undefined): string {
  return typeof session?.account_id === "string" ? session.account_id : "acct_default";
}

// The engine parses tool args / mcp bodies with its own zod instance, so a
// bare `instanceof ZodError` can miss; fall back to the duck check on `name`.
function zodIssues(err: unknown): Array<{ path: ReadonlyArray<PropertyKey>; message: string }> | undefined {
  if (err instanceof ZodError) return err.issues;
  if (err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as unknown as ZodError).issues;
  }
  return undefined;
}

/**
 * Wire-frozen Stripe error projection (D-ENG-8): every error renders as the
 * nested `{error: {type, code, message, ...}}` envelope from errors.ts.
 */
function stripeErrorEnvelope(err: unknown): { status: number; body: unknown } {
  // Engine tool dispatch throws UnknownToolError; frozen stripe wire is
  // 400 `tool_unknown` (github 422, slack 404 — per-twin, FDRS-711).
  if (err instanceof UnknownToolError) {
    return stripeError("invalid_request_error", "tool_unknown", `No such MCP tool: '${err.tool}'.`, {
      param: "tool",
      statusCode: 400,
    });
  }
  if (err instanceof TwinError) {
    return { status: err.status, body: err.toEnvelope() };
  }
  const issues = zodIssues(err);
  if (issues) {
    const first = issues[0];
    return stripeError("invalid_request_error", "parameter_invalid", first?.message ?? "Invalid request parameters.", {
      param: first?.path?.join("."),
    });
  }
  if (err instanceof SyntaxError) {
    return stripeError("invalid_request_error", "invalid_json", "Could not parse request body as JSON.");
  }
  return stripeError(
    "api_error",
    "internal_error",
    err instanceof Error ? err.message : "Internal Server Error",
    { statusCode: 500 }
  );
}

// listTools() carries the frozen tool-list wire shape (z.toJSONSchema with
// the {} fallback for optional schemas).
const toolListing = new Map(listTools().map((tool) => [tool.name, tool]));

export type CreateStripeTwinDefinitionOptions = {
  /** The database every hook (auth lookup, idempotency, admin) closes over. */
  db: TwinStripeDatabase;
  /**
   * The twin's own base URL, used by the x402 payment middleware to mint +
   * settle PaymentIntents against itself over HTTP. When omitted the x402
   * surface is not mounted (in-process test apps; parity with the pre-port
   * chassis, which only wired x402 in server boot).
   */
  twinBaseUrl?: string;
  /** Process-start ms for `tthw_seconds`. Defaults to factory-call time. */
  startedAtMs?: number;
  /**
   * Test seam: extra route registrations that run after the failure
   * injection + idempotency middlewares and before the Stripe REST routes
   * (so synthetic `/v1/*` endpoints beat the /v1/* 501 catch-all).
   */
  extendRoutes?: (app: Hono, ctx: RouteContext<StripeDomain>) => void;
};

export function createStripeTwinDefinition(
  opts: CreateStripeTwinDefinitionOptions
): TwinDefinition<TwinStripeDatabase, SeedState, StripeDomain> {
  const { db } = opts;
  const startedAtMs = opts.startedAtMs ?? Date.now();
  // Per-app rule store: /admin/seed installs `failure_injection` rules into
  // the same store the session middleware reads (FDRS-369).
  const failureInjection = createFailureInjectionStore();

  return defineTwin<TwinStripeDatabase, SeedState, StripeDomain>({
    id: "stripe",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    implementation: "stripe_clone",
    packageName: "@pome-sh/twin-stripe",
    fidelity: { default: "semantic" },
    // Pre-port: `payload === null ? defaultSeed() : parseSeed(payload)` —
    // an absent/unparseable seed body applies the default world.
    seed: z.preprocess(
      (value) => (value === null || value === undefined ? defaultSeed() : value),
      stripeSeedSchema
    ) as unknown as typeof stripeSeedSchema,
    domain: ({ db: injected, seed }) => {
      if (injected && injected !== db) {
        throw new Error(
          "twin-stripe: the db passed to createApp/serve must be the db the definition was created with"
        );
      }
      const domain = new StripeDomain(db);
      if (seed !== undefined) applySeed(db, seed, failureInjection);
      return domain;
    },
    // Session-wide middleware (the pre-port `session.use("*")` position):
    // mounted by the engine BEFORE its MCP routes, so failure injection and
    // idempotency cover /mcp, /mcp/call, /mcp/tools/:name exactly as the
    // pre-port chassis did (F-684 review pin: an Idempotency-Key'd MCP
    // create must replay, and injected rules on MCP paths must fire).
    middleware: (app, ctx) => {
      // Failure injection MUST run before idempotency so a configured
      // failure response isn't cached by the idempotency layer (a retry
      // under the same key would replay the synthetic 4xx instead of
      // re-invoking the handler).
      app.use("*", failureInjectionMiddleware(failureInjection, {
        recorder: ctx.recorder,
        runId: ctx.runId,
        twin: "stripe",
      }));
      app.use("*", idempotencyMiddleware(db, ctx.recorder, ctx.runId));
    },
    // Frozen pre-port body parsing on the engine-owned surfaces (F-684
    // review pin). Two pre-port readers existed: /admin/seed was strict
    // JSON with a null fallback (null → default seed via the schema
    // preprocess below), while the MCP dispatch surfaces used
    // routes/index.ts's form-or-JSON reader ({} fallback).
    bodyReader: async (c) => {
      if (new URL(c.req.url).pathname.endsWith("/admin/seed")) {
        try {
          return await c.req.json();
        } catch {
          return null;
        }
      }
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        try {
          return await c.req.parseBody();
        } catch {
          return {};
        }
      }
      try {
        return await c.req.json();
      } catch {
        return {};
      }
    },
    routes: (app, ctx) => {
      opts.extendRoutes?.(app, ctx);
      registerStripeRoutes(app, ctx.domain, ctx.recorder, ctx.runId);
      if (opts.twinBaseUrl) {
        registerX402Routes(app, { twinBaseUrl: opts.twinBaseUrl });
      }
    },
    // Account-scoped state export (F1): two sessions sharing a DB see
    // disjoint `/_pome/state` views.
    state: ({ domain, session }) =>
      session
        ? domain.exportState(accountIdFrom(session))
        : { payment_intents: [], charges: [], balance_transactions: [], events: [] },
    admin: {
      reset: () => {
        resetDatabase(db);
        applySeed(db, defaultSeed(), failureInjection);
        return { ok: true, message: "Stripe twin state reset to default seed." };
      },
      seed: ({ seed }) => {
        resetDatabase(db);
        applySeed(db, seed, failureInjection);
        return {
          ok: true,
          api_keys: (seed.api_keys ?? []).length,
          failure_injection: (seed.failure_injection ?? []).length,
        };
      },
      // Frozen tape shape: stripe's pre-port recorder never saw admin
      // traffic — /admin/reset|seed emit no events (F-684 review pin).
      recorded: false,
      // Frozen stripe admin-gate 403 body.
      forbidden: () => forbidden("Forbidden"),
    },
    tools: toolDefinitions.map((def) => ({
      name: def.name,
      description: def.description,
      schema: def.schema as unknown as z.ZodType<unknown>,
      mutation: isMutatingTool(def.name),
      inputSchema: toolListing.get(def.name)?.input_schema as Record<string, unknown>,
      handler: (domain: StripeDomain, args: unknown, ctx: ToolCallContext) =>
        executeTool(domain, accountIdFrom(ctx.session), def.name, args),
    })),
    // Frozen healthz extras: fidelity + tthw_seconds on top of the contract
    // core {ok, twin, implementation, tools, runtime}.
    healthz: () => ({ fidelity: "semantic", tthw_seconds: tthwSeconds(startedAtMs) }),
    // Frozen per-session health shape: implementation/fidelity/tthw/runtime
    // plus recorder counters (bounded store: real dropped count, D-ENG-10).
    pomeHealth: ({ recorder }) => ({
      implementation: "stripe_clone",
      fidelity: "semantic",
      tthw_seconds: tthwSeconds(startedAtMs),
      runtime: twinBuildInfo("@pome-sh/twin-stripe"),
      recorder: { events: recorder.count(), dropped: recorder.dropped() },
    }),
    // Frozen per-twin difference: stripe has NO per-session /healthz (501).
    sessionHealthz: false,
    // F3 SDK-compat root mount: stripe-node/stripe-python URLs (/v1/*) hit
    // the same session router; the bearer alone resolves the sid.
    mountSessionAtRoot: true,
    unsupported: () => unsupported(),
    errorEnvelope: stripeErrorEnvelope,
    auth: {
      // F-712 pins: liberal bearer parsing ON (raw token + case-insensitive
      // "bearer"); sid mismatch → 403; api_keys table lookup ahead of
      // provider-shaped verify + JWT; no path sid required (root mount);
      // expired-vs-invalid classified by the engine and rendered through
      // the frozen unauthorized envelope.
      providerToken: { provider: "stripe", prefixes: ["sk_test_pome_"] },
      providerSession: (sid) => ({ account_id: `acct_${sid}`, via: "api_key" }),
      allowRawBearer: true,
      requirePathSid: false,
      resolveCredential: (token) => {
        // Perf + pre-port parity: only api-key-shaped tokens hit the DB.
        // A table miss falls through to provider verify; if that also
        // fails, the unauthorized hook renders the frozen
        // "Invalid API Key provided." for this shape.
        if (!looksLikeApiKey(token)) return undefined;
        const row = resolveSidFromKey(db, token);
        return row ? { sid: row.sid, account_id: row.account_id, via: "api_key" } : undefined;
      },
      unauthorized: (kind, info) => {
        // Frozen wire messages: api-key-shaped tokens that resolve nowhere
        // answer "Invalid API Key provided." (pre-port terminal branch);
        // JWT-shaped failures answer "Bad credentials" / "Token expired".
        const message =
          kind === "expired"
            ? "Token expired"
            : info?.token && looksLikeApiKey(info.token)
              ? "Invalid API Key provided."
              : "Bad credentials";
        const envelope = unauthorized(message);
        return { status: envelope.status, body: envelope.body };
      },
      sidMismatch: () => {
        const envelope = forbidden("Session id mismatch.");
        return { status: envelope.status, body: envelope.body };
      },
      sessionExtras: (claims) => ({
        account_id: typeof claims.account_id === "string" ? claims.account_id : `acct_${claims.sid}`,
        via: "jwt",
      }),
    },
  });
}

export type CreateTwinStripeAppOptions = {
  db?: TwinStripeDatabase;
  recorder?: RecorderStore;
  runId?: string;
  /** Boot seed. Defaults to `defaultSeed()` when the factory opens its own db. */
  seed?: SeedState;
  /** Skip the default seed (for empty-state tests). */
  noSeed?: boolean;
  twinBaseUrl?: string;
  startedAtMs?: number;
  extendRoutes?: (app: Hono, ctx: RouteContext<StripeDomain>) => void;
};

/** Assemble the Stripe twin app on the engine (in-process; no port bind). */
export function createTwinStripeApp(opts: CreateTwinStripeAppOptions = {}): Hono {
  const db = opts.db ?? openTwinStripeDatabase(":memory:");
  const definition = createStripeTwinDefinition({
    db,
    twinBaseUrl: opts.twinBaseUrl,
    startedAtMs: opts.startedAtMs,
    extendRoutes: opts.extendRoutes,
  });
  // Pre-port semantics: the default seed applies only when the factory
  // opened the db itself (callers passing a db manage their own seed).
  const seed = opts.noSeed ? undefined : opts.seed ?? (opts.db ? undefined : defaultSeed());
  return createApp(definition, {
    db,
    recorder: opts.recorder,
    runId: opts.runId ?? "local",
    seed,
  });
}
