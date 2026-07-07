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

import { Hono } from "hono";
import { z } from "zod";
import {
  RESERVED_SESSION_PREFIXES,
  type RecorderHandle,
  type ToolSpec,
  type TwinDefinition,
} from "./index.js";
import { bearerAuth, requireAdminAuth } from "./auth.js";
import { twinBuildInfo } from "./build-info.js";
import { handleMcpJsonRpc, mcpMethodNotAllowed } from "./mcp-jsonrpc.js";
import { createRecorderHandle, type RecorderStore } from "./recorder.js";
import { redactSecrets } from "./redaction.js";
import { TwinError, UnknownToolError } from "./errors.js";

export { createRecorderHandle, createRecorderStore } from "./recorder.js";
export type { RecorderStore, ErrorEnvelopeFn } from "./recorder.js";
export { bearerAuth, requireAdminAuth, resolveAuthSecret } from "./auth.js";
// Alternate serving bridges (anything that isn't @hono/node-server) must feed
// the gate the transport-level peer address via setClientIp from an upstream
// middleware; createAdminGate lets custom twins mount the gate with their own
// 403 envelope. See the SECURITY note on setClientIp — never derive the value
// from request headers.
export { createAdminGate, setClientIp } from "./admin-gate.js";
export { TwinError, UnknownToolError } from "./errors.js";
export { redactEvent, redactSecrets } from "./redaction.js";
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

export class TwinBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwinBootError";
  }
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

  // 7. Admin sub-app
  const adminApp = new Hono();
  adminApp.use("*", requireAdminAuth());
  adminApp.post(
    "/reset",
    recorder.handle({ mutation: true }, async () => {
      if (!definition.admin?.reset) {
        throw new TwinError("admin.reset is not configured for this twin", 501);
      }
      const body = (await definition.admin.reset({ domain })) ?? { ok: true };
      return { status: 200, body };
    })
  );
  adminApp.post(
    "/seed",
    recorder.handle({ mutation: true }, async (c) => {
      if (!definition.admin?.seed) {
        throw new TwinError("admin.seed is not configured for this twin", 501);
      }
      if (!definition.seed) {
        throw new TwinError(
          "Twin manifest has no `seed` schema; cannot accept POST /admin/seed",
          501
        );
      }
      const raw = await readJson(c.req.raw);
      const parsed = definition.seed.parse(raw) as TSeed;
      const body = (await definition.admin.seed({ domain, seed: parsed })) ?? { ok: true };
      return { status: 200, body };
    })
  );
  root.route("/admin", adminApp);

  // 8. Session sub-app. Auth mechanism is the engine's; the twin's declared
  //    shape (F-712) rides in via `definition.auth`.
  const session = new Hono();
  session.use("*", bearerAuth(definition.auth));

  session.get("/healthz", (c) => c.json({ ok: true, sid: c.req.param("sid") }));
  session.get("/_pome/health", (c) =>
    c.json({
      ok: true,
      twin: definition.id,
      version: definition.version,
      fidelity: definition.fidelity.default,
    })
  );
  session.get(
    "/_pome/state",
    recorder.handle({ mutation: false }, async () => {
      if (!definition.state) {
        throw new TwinError(
          "state introspection is not configured for this twin",
          501
        );
      }
      const state = await definition.state({ domain });
      // Central redaction: the state export feeds cloud-side scoring and the
      // CLI trace; a twin must not be able to leak secrets by omission.
      return { status: 200, body: redactSecrets(state) };
    })
  );
  session.get("/_pome/events", (c) => c.json(recorder.events()));

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
        input_schema: z.toJSONSchema(tool.schema),
      })),
    })
  );
  session.post(
    "/mcp/tools/:name",
    recorder.handle({ mutation: false }, async (c) => {
      const name = c.req.param("name") ?? "";
      const tool = findTool(definition, name);
      const args = await readJson(c.req.raw);
      const parsed = tool.schema.parse(args ?? {});
      const result = await tool.handler(domain, parsed);
      return { status: 200, body: result, mutation: tool.mutation };
    })
  );
  session.post(
    "/mcp/call",
    recorder.handle({ mutation: false }, async (c) => {
      const raw = await readJson(c.req.raw);
      const call = z
        .object({ tool: z.string().min(1), arguments: jsonRecord.default({}) })
        .parse(raw);
      const tool = findTool(definition, call.tool);
      const parsed = tool.schema.parse(call.arguments);
      const result = await tool.handler(domain, parsed);
      return { status: 200, body: result, mutation: tool.mutation };
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

/** Hostnames the boot guard treats as loopback binds. */
export function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function shadowedPrefix(routePath: string): string | null {
  for (const prefix of RESERVED_SESSION_PREFIXES) {
    if (routePath === prefix || routePath.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

function assertUniqueToolNames<TDomain>(
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

function findTool<TDb, TSeed, TDomain>(
  definition: TwinDefinition<TDb, TSeed, TDomain>,
  name: string
): ToolSpec<TDomain> {
  const tool = definition.tools.find((t) => t.name === name);
  if (!tool) {
    throw new UnknownToolError(name);
  }
  return tool;
}

async function readJson(req: Request): Promise<unknown> {
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
