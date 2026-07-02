// SPDX-License-Identifier: Apache-2.0
// Twin-stripe Hono app. AGENT-A owns the chassis and exports `sessionRouter`
// (a Hono sub-app already mounted under `/s/:sid`) for AGENT-B and AGENT-C
// to extend with the Stripe REST, MCP, and x402 routes.
//
// Important wiring contracts:
//   - bearerAuth() runs at the session level; downstream code can read
//     `c.get('session')` to get the resolved sid + account_id.
//   - idempotencyMiddleware() runs after bearerAuth() so account_id is set.
//   - The catch-all `app.all('*')` returning the loud 501 envelope MUST be
//     registered AFTER any extending agent calls. The recommended pattern
//     is for extenders to call `extendSessionRouter(s => s.post(...))` and
//     to NOT touch the catch-all; we re-register the catch-all last in
//     createTwinStripeApp().
import { Hono } from "hono";
import { z } from "zod";
import { bearerAuth } from "./auth.js";
import { openTwinStripeDatabase } from "./db.js";
import { stripeError, TwinError, unsupported } from "./errors.js";
import {
  createFailureInjectionStore,
  failureInjectionMiddleware,
  type FailureInjectionStore,
} from "./failure-injection.js";
import { idempotencyMiddleware } from "./idempotency.js";
import {
  mountRootPomeRoutes,
  mountSessionPomeRoutes,
  type StateProvider,
} from "./pome-routes.js";
import { applySeed, defaultSeed } from "./seed.js";
import type { Recorder, TwinStripeDatabase } from "./types.js";
import { createRecorder } from "./recorder.js";
import { requestId } from "./util.js";

export type TwinStripeAppOptions = {
  db?: TwinStripeDatabase;
  recorder?: Recorder;
  /** Defaults to `Date.now()` at app creation. */
  startedAtMs?: number;
  runId?: string;
  /** Skip default seed (for empty-state tests). */
  noSeed?: boolean;
  /**
   * Pre-built failure-injection store, supplied when the embedder needs
   * to seed `failure_injection` rules into the store BEFORE the app is
   * wired up (e.g. `server.ts` applies `loadSeedFromEnv()` against this
   * store ahead of constructing the app, see FDRS-369). When omitted,
   * the app creates its own empty store.
   */
  failureInjection?: FailureInjectionStore;
  /**
   * Hook called once with the per-session router so domain agents (B/C)
   * can register routes. Runs after auth + idempotency middleware are
   * installed and after the `mcp/*` and `_pome/{health,events}` routes
   * are mounted, but BEFORE `/_pome/state` and BEFORE the catch-all 501.
   * Embedders use this to mount the Stripe REST, MCP, and x402 routes.
   *
   * Returning a `stateProvider` from this hook lets the domain agent
   * supply the body for `GET /_pome/state` (F4). When omitted, the
   * chassis default is mounted instead.
   */
  extendSession?: (
    session: Hono,
    ctx: TwinStripeContext
  ) => { stateProvider?: StateProvider } | void;
  /**
   * Tool count to advertise on /healthz. AGENT-B registers tools and can
   * pass the real count; chassis-only it's 0.
   */
  toolCount?: number;
};

export type TwinStripeContext = {
  db: TwinStripeDatabase;
  recorder: Recorder;
  runId: string;
  startedAtMs: number;
  failureInjection: FailureInjectionStore;
};

export function createTwinStripeApp(options: TwinStripeAppOptions = {}) {
  const db = options.db ?? openTwinStripeDatabase();
  const recorder = options.recorder ?? createRecorder();
  const runId = options.runId ?? "local";
  const startedAtMs = options.startedAtMs ?? Date.now();
  const toolCount = options.toolCount ?? 0;
  const failureInjection = options.failureInjection ?? createFailureInjectionStore();

  if (!options.db && !options.noSeed) {
    applySeed(db, defaultSeed(), failureInjection);
  }

  const ctx: TwinStripeContext = {
    db,
    recorder,
    runId,
    startedAtMs,
    failureInjection,
  };

  const root = new Hono();

  mountRootPomeRoutes(root, {
    db,
    recorder,
    toolCount,
    startedAtMs,
    failureInjection
  });

  // Per-session router. bearerAuth + failureInjectionMiddleware +
  // idempotencyMiddleware run for every route mounted below. Failure
  // injection MUST run before idempotency so a configured failure
  // response isn't cached by the idempotency layer (otherwise a retry
  // under the same key would replay the synthetic 4xx instead of
  // re-invoking the handler).
  const session = new Hono();
  session.use("*", bearerAuth(db));
  session.use("*", failureInjectionMiddleware(failureInjection, recorder, runId));
  session.use("*", idempotencyMiddleware(db, recorder, runId));

  // Hand the session router to the domain agent FIRST. Hono's router is
  // first-match-wins, so AGENT-B's `/mcp/*` registrations need to land
  // before the chassis stubs below. The domain agent can also return a
  // `stateProvider` for `/_pome/state` (F4), which we apply when we
  // mount the rest of the `_pome/*` surfaces below.
  const extension = options.extendSession?.(session, ctx);
  const stateProvider = (extension && extension.stateProvider) || undefined;

  // Mount _pome/{health,state,events} AFTER extendSession has registered
  // any earlier routes. We pass the domain-aware stateProvider through
  // so /_pome/state returns real domain state (or the chassis default).
  mountSessionPomeRoutes(
    session,
    {
      db,
      recorder,
      toolCount,
      startedAtMs
    },
    stateProvider
  );

  // MCP scaffolding — chassis returns "no tools registered" iff AGENT-B
  // didn't register handlers via `extendSession`. Hono's first-match-wins
  // routing means these only run when nothing above matched.
  session.get("/mcp/tools", (c) => c.json({ tools: [] }));
  session.post("/mcp/tools/:name", (c) => {
    const env = stripeError(
      "invalid_request_error",
      "tool_not_found",
      `Unknown MCP tool: ${c.req.param("name")}`,
      { statusCode: 404, fidelity: "unsupported" }
    );
    return c.json(env.body, env.status as never);
  });
  session.post("/mcp/call", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      // fall through with body=null
    }
    const tool = (body && typeof body === "object" && "tool" in body
      ? String((body as { tool?: unknown }).tool ?? "")
      : "");
    const env = stripeError(
      "invalid_request_error",
      "tool_not_found",
      tool ? `Unknown MCP tool: ${tool}` : "MCP tool name is required.",
      { statusCode: tool ? 404 : 400, fidelity: "unsupported" }
    );
    return c.json(env.body, env.status as never);
  });

  // Catch-all loud 501 — must be last.
  session.all("*", (c) => {
    const env = unsupported();
    return c.json(env.body, env.status as never);
  });

  // Top-level error handler for thrown TwinError / ZodError. Domain
  // handlers can also catch and return directly; this is a safety net.
  root.onError((err, c) => {
    if (err instanceof TwinError) {
      return c.json(err.toEnvelope(), err.status as never);
    }
    if (err instanceof z.ZodError) {
      const env = stripeError(
        "invalid_request_error",
        "parameter_invalid_empty",
        err.issues[0]?.message ?? "Validation failed.",
        {
          statusCode: 400,
          param: err.issues[0]?.path.join(".") || undefined
        }
      );
      return c.json(env.body, env.status as never);
    }
    if (err instanceof SyntaxError) {
      const env = stripeError(
        "invalid_request_error",
        "invalid_json",
        "Could not parse JSON body.",
        { statusCode: 400 }
      );
      return c.json(env.body, env.status as never);
    }
    const env = stripeError(
      "api_error",
      "internal_error",
      err instanceof Error ? err.message : "Internal server error.",
      { statusCode: 500 }
    );
    return c.json(env.body, env.status as never);
  });

  // Expose the request id helper on the app for downstream record() calls.
  // (Not used by chassis; AGENT-B may want it.) Registered before the
  // root-mounted session router so it isn't shadowed by the catch-all.
  root.get("/_request_id", (c) => c.json({ request_id: requestId() }));

  root.route("/s/:sid", session);

  // F3: SDK-compatibility mount. Real `stripe-node`/`stripe-python` etc.
  // build URLs like `/v1/payment_intents` and offer no way to inject a
  // `/s/:sid` prefix, so we mount the same session router at the root
  // path. The bearer alone resolves the sid (auth middleware skips the
  // sid-comparison when the URL has no `:sid` segment). `mountRootPomeRoutes`
  // ran before this, so `/healthz` and `/admin/*` win against the
  // session router's catch-all.
  root.route("/", session);

  return root;
}

/** Re-export the session Hono so AGENT-B can import the type. */
export type SessionRouter = Hono;
