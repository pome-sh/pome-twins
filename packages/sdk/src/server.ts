// SPDX-License-Identifier: Apache-2.0
//
// `@pome-sh/sdk/server` — boot a `TwinDefinition` into a Hono app and
// optionally bind a Node HTTP server. `createApp()` returns the bare app
// (no port binding) for tests; `serve()` wraps it with `@hono/node-server`.
//
// Auto-mounted routes:
//   GET  /healthz                          (root, no auth)
//   POST /admin/reset                      (localhost-only)
//   POST /admin/seed                       (localhost-only)
//   GET  /s/:sid/healthz                   (bearer)
//   GET  /s/:sid/_pome/health              (bearer)
//   GET  /s/:sid/_pome/state               (bearer)
//   GET  /s/:sid/_pome/events              (bearer)
//   GET  /s/:sid/mcp/tools                 (bearer)
//   POST /s/:sid/mcp/tools/:name           (bearer)
//   POST /s/:sid/mcp/call                  (bearer)
//
// User routes registered via `definition.routes(app, ctx)` are mounted under
// `/s/:sid/*`. The SDK refuses to boot if any user route shadows the
// `/_pome/*` or `/mcp/*` prefixes (OQ-B6 invariant).

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  RESERVED_SESSION_PREFIXES,
  toolInputSchema,
  type RecorderHandle,
  type ToolSpec,
  type TwinDefinition,
} from "./index.js";
import { bearerAuth, requireAdminAuth } from "./auth.js";
import { createAdminGate } from "./admin-gate.js";
import { makeToolCallContext } from "./tool-context.js";
import { twinBuildInfo } from "./build-info.js";
import { handleMcpJsonRpc, mcpMethodNotAllowed } from "./mcp-jsonrpc.js";
import { createRecorderHandle, type RecorderStore } from "./recorder.js";
import { redactSecrets } from "./redaction.js";
import { TwinError, UnknownToolError, envelopeFor } from "./errors.js";
import {
  POME_CORE_ROUTE_NAMES,
  TwinBootError,
  assertUniqueToolNames,
  findTool,
  isLoopbackHost,
  makeDeltaSink,
  readJson,
  shadowedPrefix,
} from "./server-helpers.js";

// Public boot surface consumed by twin entrypoints
// (`import { TwinBootError, isLoopbackHost, serve } from "@pome-sh/sdk/server"`).
export { TwinBootError, isLoopbackHost, created, ok } from "./server-helpers.js";

export {
  createRecorderHandle,
  createRecorderStore,
  createFileBackedRecorderStore,
} from "./recorder.js";
export type {
  RecorderStore,
  RecorderStoreOptions,
  FileBackedRecorderStoreOptions,
  ErrorEnvelopeFn,
} from "./recorder.js";
export { bearerAuth, requireAdminAuth, resolveAuthSecret } from "./auth.js";
// Alternate serving bridges (anything that isn't @hono/node-server) must feed
// the gate the transport-level peer address via setClientIp from an upstream
// middleware; createAdminGate lets custom twins mount the gate with their own
// 403 envelope. See the SECURITY note on setClientIp — never derive the value
// from request headers.
export { createAdminGate, setClientIp } from "./admin-gate.js";
export type { AdminGateOptions } from "./admin-gate.js";
export { TwinError, UnknownToolError } from "./errors.js";
export { redactEvent, redactSecrets } from "./redaction.js";
export {
  FAILURE_INJECTION_OVERRIDE_KEY,
  createFailureInjectionStore,
  failureInjectionMiddleware,
  failureInjectionRuleSchema,
} from "./failure-injection.js";
export type {
  FailureInjectionMiddlewareOptions,
  FailureInjectionMode,
  FailureInjectionOverride,
  FailureInjectionRule,
  FailureInjectionStore,
} from "./failure-injection.js";
export {
  PROVIDER_SHAPED_TEAM_ID,
  formTokenResolver,
  mintProviderToken,
  queryTokenResolver,
  verifyProviderToken,
} from "./auth.js";
export type {
  AuthEnvelope,
  BearerAuthOptions,
  MintProviderTokenOptions,
  ProviderTokenSpec,
  SessionClaims,
  SessionValue,
  TokenResolver,
  UnauthorizedKind,
} from "./auth.js";
export { twinBuildInfo } from "./build-info.js";
export type { TwinBuildInfo } from "./build-info.js";

export interface ServeOptions<TDb = unknown, TSeed = unknown> {
  /** Optional. When set, `serve()` binds a Node HTTP server. */
  port?: number;
  /** Bind hostname. Defaults to "127.0.0.1". */
  hostname?: string;
  /** Opaque database handle forwarded to `definition.domain({ db })`. */
  db?: TDb;
  /** Initial seed forwarded to `definition.domain({ seed })`. Validated against `definition.seed` if provided. */
  seed?: TSeed;
  /** Custom recorder store. Defaults to in-memory. */
  recorder?: RecorderStore;
  /** Run identifier embedded in every recorder event. Defaults to "local". */
  runId?: string;
}

const jsonRecord = z.record(z.string(), z.unknown());

export function createApp<TDb, TSeed, TDomain>(
  definition: TwinDefinition<TDb, TSeed, TDomain>,
  options: ServeOptions<TDb, TSeed> = {}
): Hono {
  // 1. Validate + build seed
  let seed: TSeed | undefined;
  if (options.seed !== undefined) {
    if (definition.seed) {
      seed = definition.seed.parse(options.seed);
    } else {
      seed = options.seed;
    }
  }

  // 2. Build domain
  const domain = definition.domain({ db: options.db as TDb, seed });

  // 3. Build recorder. The manifest's `errorEnvelope` (if set) is forwarded
  //    here so API-mirroring twins control their error shape without
  //    bypassing the recorder middleware.
  const runId = options.runId ?? "local";
  const recorder = createRecorderHandle({
    runId,
    twin: definition.id,
    store: options.recorder,
    errorEnvelope: definition.errorEnvelope,
    stampToolCallId: definition.stampToolCallId,
  });

  // 4. Boot-time invariant: user routes must not shadow reserved prefixes.
  const userApp = new Hono();
  if (definition.routes) {
    definition.routes(userApp, { domain, recorder, runId, twin: definition.id });
    for (const route of userApp.routes) {
      const shadowed = shadowedPrefix(route.path);
      if (shadowed) {
        throw new TwinBootError(
          `Twin "${definition.id}" route ${route.method} ${route.path} shadows reserved SDK prefix ${shadowed}/*`
        );
      }
    }
  }

  // 5. Tool name uniqueness sanity (defineTwin already enforces, but a
  //    test that hand-builds a TwinDefinition could bypass it).
  assertUniqueToolNames(definition.tools, definition.id);

  // 6. Build root app
  const root = new Hono();

  // Contract core: {ok, twin, implementation, tools, runtime}. Extras
  // default to the pre-F-681 fields; a twin with a frozen healthz shape
  // supplies its own (possibly empty) extras via `definition.healthz`.
  const healthzExtras =
    definition.healthz ??
    (() => ({ version: definition.version, fidelity: definition.fidelity.default }));
  root.get("/healthz", (c) =>
    c.json({
      ok: true,
      twin: definition.id,
      implementation: definition.implementation ?? `${definition.id}_clone`,
      tools: definition.tools.length,
      runtime: twinBuildInfo(definition.packageName ?? `@pome-sh/twin-${definition.id}`),
      ...healthzExtras(),
    })
  );

  // Per-twin body reader for the engine-owned JSON surfaces. Default is
  // strict JSON (malformed → SyntaxError into the twin's errorEnvelope);
  // twins with frozen tolerant/form parsing (slack, stripe) declare theirs.
  const readBody = definition.bodyReader ?? ((c: Context) => readJson(c.req.raw));

  // 7. Admin sub-app. Gate mechanism is the engine's; a twin with a frozen
  //    403 body declares it via `admin.forbidden` (F-683).
  const adminForbidden = definition.admin?.forbidden;
  const adminApp = new Hono();
  adminApp.use(
    "*",
    adminForbidden
      ? createAdminGate({
          forbidden: () => {
            const envelope = adminForbidden();
            return Response.json(envelope.body, { status: envelope.status });
          },
        })
      : requireAdminAuth()
  );
  const adminEnvelope = definition.admin?.errorEnvelope;
  // stripe pin: its pre-port recorder never saw admin traffic, so
  // admin.recorded=false serves the same handlers without emitting events.
  const wrapAdmin =
    definition.admin?.recorded !== false
      ? (fn: (c: Context) => Promise<{ status: number; body: unknown; delta?: unknown }>) =>
          recorder.handle({ mutation: true, errorEnvelope: adminEnvelope }, fn as never)
      : (fn: (c: Context) => Promise<{ status: number; body: unknown; delta?: unknown }>) =>
          async (c: Context) => {
            try {
              const result = await fn(c);
              return c.json(result.body as never, result.status as never);
            } catch (err) {
              const envelope = (adminEnvelope ?? definition.errorEnvelope ?? envelopeFor)(err);
              return c.json(envelope.body as never, envelope.status as never);
            }
          };
  adminApp.post(
    "/reset",
    wrapAdmin(async () => {
      if (!definition.admin?.reset) {
        throw new TwinError("admin.reset is not configured for this twin", 501);
      }
      const delta = makeDeltaSink();
      const body = (await definition.admin.reset({ domain, reportDelta: delta.report })) ?? { ok: true };
      return { status: 200, body, delta: delta.value() };
    })
  );
  adminApp.post(
    "/seed",
    wrapAdmin(async (c) => {
      if (!definition.admin?.seed) {
        throw new TwinError("admin.seed is not configured for this twin", 501);
      }
      if (!definition.seed) {
        throw new TwinError(
          "Twin manifest has no `seed` schema; cannot accept POST /admin/seed",
          501
        );
      }
      const raw = await readBody(c);
      const parsed = definition.seed.parse(raw) as TSeed;
      const delta = makeDeltaSink();
      const body =
        (await definition.admin.seed({ domain, seed: parsed, reportDelta: delta.report })) ?? { ok: true };
      return { status: 200, body, delta: delta.value() };
    })
  );
  root.route("/admin", adminApp);

  // 8. Session sub-app. Auth mechanism is the engine's; the twin's declared
  //    shape (F-712) rides in via `definition.auth`.
  const session = new Hono();
  session.use("*", bearerAuth(definition.auth));

  // Session-wide middleware slot — the pre-port `session.use("*")` position,
  // mounted BEFORE the engine's MCP / `/_pome/*` routes so twin middleware
  // (stripe failure-injection, idempotency) covers MCP dispatch too.
  if (definition.middleware) {
    definition.middleware(session, { domain, recorder, runId, twin: definition.id });
  }

  // Per-session healthz is contract-frozen per twin: github/slack answer
  // 200 {ok, sid}; stripe has NO such route (falls to the 501 catch-all).
  if (definition.sessionHealthz !== false) {
    session.get("/healthz", (c) => c.json({ ok: true, sid: c.req.param("sid") }));
  }
  // `pomeHealth` extras replace the default {version, fidelity} for twins
  // with a frozen per-session health shape (slack: bare {ok, twin};
  // github: no version; stripe adds recorder counters).
  const pomeHealthExtras =
    definition.pomeHealth ??
    (() => ({ version: definition.version, fidelity: definition.fidelity.default }));
  session.get("/_pome/health", (c) =>
    c.json({
      ok: true,
      twin: definition.id,
      ...pomeHealthExtras({ recorder }),
    })
  );
  // NOT recorder-wrapped: no pre-port twin recorded /_pome/state fetches on
  // the tape (F-683 review pin) — the export is a read-side probe, and
  // recording it would embed the full state as an event response_body.
  session.get("/_pome/state", async (c: Context) => {
    try {
      if (!definition.state) {
        throw new TwinError("state introspection is not configured for this twin", 501);
      }
      const session = c.get("session") as import("./auth.js").SessionValue | undefined;
      const state = await definition.state({ domain, session });
      // Central redaction: the state export feeds cloud-side scoring and the
      // CLI trace; a twin must not be able to leak secrets by omission.
      return c.json(redactSecrets(state) as never);
    } catch (err) {
      const envelope = (definition.errorEnvelope ?? envelopeFor)(err);
      return c.json(envelope.body as never, envelope.status as never);
    }
  });
  session.get("/_pome/events", (c) => c.json(recorder.events()));

  // 8b. Extra per-twin `/_pome/*` routes (github's frozen
  //     GET /s/:sid/_pome/access-control, F-682). Registered after the core
  //     routes so the platform surface can never be shadowed; core names are
  //     rejected outright at boot.
  if (definition.pomeRoutes) {
    for (const [name, handler] of Object.entries(definition.pomeRoutes)) {
      if (POME_CORE_ROUTE_NAMES.has(name)) {
        throw new TwinBootError(
          `Twin "${definition.id}" pome route "/_pome/${name}" shadows a reserved engine route`
        );
      }
      session.get(`/_pome/${name}`, async (c) => c.json((await handler({ domain })) as never));
    }
  }

  // 9. MCP routes from tool registry. `/mcp` is the streamable-HTTP
  //    JSON-RPC endpoint (stateless — GET/DELETE answer 405); `/mcp/tools`,
  //    `/mcp/tools/:name`, `/mcp/call` are the legacy dispatch surface.
  session.post("/mcp", (c) => handleMcpJsonRpc(c, { definition, domain, recorder, runId }));
  session.get("/mcp", (c) => mcpMethodNotAllowed(c));
  session.delete("/mcp", (c) => mcpMethodNotAllowed(c));
  session.get("/mcp/tools", (c) =>
    c.json({
      tools: definition.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: toolInputSchema(tool),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    })
  );
  session.post(
    "/mcp/tools/:name",
    recorder.handle({ mutation: false }, async (c) => {
      const name = c.req.param("name") ?? "";
      const tool = findTool(definition, name);
      const args = await readBody(c);
      const parsed = tool.schema.parse(args ?? {});
      const call = makeToolCallContext(c);
      const result = await tool.handler(domain, parsed, call.ctx);
      return { status: 200, body: result, mutation: tool.mutation, delta: call.delta() };
    })
  );
  session.post(
    "/mcp/call",
    recorder.handle({ mutation: false }, async (c) => {
      const raw = await readBody(c);
      let call: { tool: string; arguments: Record<string, unknown> };
      if (definition.legacyMcp?.aliases) {
        // Frozen slack surface: {name}/{params} alias {tool}/{arguments};
        // a body naming no tool answers the twin's own envelope (400
        // invalid_arguments) instead of the strict-parse error.
        const rec = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
        const name = rec.tool ?? rec.name;
        if (typeof name !== "string" || name.length === 0) {
          const missing = definition.legacyMcp.missingTool;
          if (missing) {
            const envelope = missing();
            return { status: envelope.status, body: envelope.body };
          }
          z.object({ tool: z.string().min(1) }).parse(rec); // throws the strict-parse error
        }
        call = {
          tool: name as string,
          arguments: (rec.arguments ?? rec.params ?? {}) as Record<string, unknown>,
        };
      } else {
        call = z
          .object({ tool: z.string().min(1), arguments: jsonRecord.default({}) })
          .parse(raw) as { tool: string; arguments: Record<string, unknown> };
      }
      const tool = findTool(definition, call.tool);
      const parsed = tool.schema.parse(call.arguments);
      const toolCall = makeToolCallContext(c);
      const result = await tool.handler(domain, parsed, toolCall.ctx);
      return { status: 200, body: result, mutation: tool.mutation, delta: toolCall.delta() };
    })
  );

  // 10. User routes
  if (definition.routes) {
    session.route("/", userApp);
  }

  // 11. Catch-all for unsupported surfaces. Recorder records
  //     fidelity:"unsupported" and returns 501 so unmatched routes surface
  //     as a fidelity-gap signal in the trace instead of silently 404'ing.
  //     Not opt-out per OQ-B6: every community twin auto-surfaces fidelity
  //     gaps in the trace.
  session.all(
    "*",
    recorder.handle({ mutation: false, fidelity: "unsupported" }, async (c) => {
      const ctx = { method: c.req.method, path: new URL(c.req.url).pathname };
      if (definition.unsupported) return definition.unsupported(ctx);
      return {
        status: 501,
        body: {
          message: `Endpoint not modeled by twin "${definition.id}".`,
          fidelity: "unsupported",
          method: ctx.method,
          path: ctx.path,
        },
      };
    })
  );

  root.route("/s/:sid", session);

  // 11b. SDK-compat root mount (stripe F3, F-684): the same session router
  //      answers at the root path. Root /healthz + /admin/* were registered
  //      first and stay first-match; unknown root paths hit the twin's auth
  //      wall (bearerAuth answers 401 before the 501 catch-all). Pair with
  //      `auth.requirePathSid: false` so the bearer alone resolves the sid.
  if (definition.mountSessionAtRoot) {
    root.route("/", session);
  }

  // 12. Footgun warning: clean-state-per-test workflows rely on
  //     /admin/reset. Warn loudly if a twin ships without it so authors
  //     don't discover the gap mid-CI-debug.
  if (!definition.admin?.reset) {
    console.warn(
      `[@pome-sh/sdk] twin "${definition.id}" has no admin.reset configured — POST /admin/reset returns 501. Most CI workflows rely on this for clean-state-per-test.`
    );
  }

  return root;
}

export interface ServeResult {
  app: Hono;
  /**
   * Stop the bound HTTP server. Resolves once the server is fully closed.
   * Throws if `serve()` was called without a `port` (no server was bound).
   */
  close(): Promise<void>;
}

/**
 * Build the app and bind a Node HTTP server. If `port` is omitted, no
 * server is bound and `close()` is a no-op — useful for tests that drive
 * the app via `app.request(...)`.
 */
export async function serve<TDb, TSeed, TDomain>(
  definition: TwinDefinition<TDb, TSeed, TDomain>,
  options: ServeOptions<TDb, TSeed> = {}
): Promise<ServeResult> {
  const hostname = options.hostname ?? "127.0.0.1";
  // Contract boot guard: a twin must refuse to serve real traffic with the
  // dev fallback secret. Checked before the app is built so the process
  // exits non-zero without ever listening.
  if (options.port !== undefined && !isLoopbackHost(hostname) && !process.env.TWIN_AUTH_SECRET) {
    throw new TwinBootError(
      `TWIN_AUTH_SECRET is required when a twin listens on a non-loopback host (${hostname}).`
    );
  }
  const app = createApp(definition, options);
  if (options.port === undefined) {
    return { app, close: async () => undefined };
  }
  const { serve: nodeServe } = await import("@hono/node-server");
  const server = await new Promise<ReturnType<typeof nodeServe>>((resolve) => {
    const bound = nodeServe(
      {
        fetch: app.fetch,
        port: options.port,
        hostname,
      },
      () => resolve(bound)
    );
  });
  return {
    app,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      }),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Engine-owned `/_pome/*` route names a twin's `pomeRoutes` may not shadow. */
