// SPDX-License-Identifier: Apache-2.0
// Pome-specific surfaces shared across twins:
//   - GET /healthz                               (root, no auth, snapshot probe)
//   - POST /admin/reset                          (root, localhost-only)
//   - POST /admin/seed                           (root, localhost-only)
//   - GET  /s/:sid/_pome/health                  (per-session, includes tthw_seconds)
//   - GET  /s/:sid/_pome/state                   (full state export)
//   - GET  /s/:sid/_pome/events                  (recorder dump)
//
// `tthw_seconds` (Time To Hello World) per D-DX-4 / §22 is the wall clock
// from process start, so the snapshot consumer can bound boot time. The
// per-session /_pome/health surfaces it because the cloud probe hits /healthz
// pre-snapshot and the agent harness hits /s/:sid/_pome/health post-spawn.
import type { Context } from "hono";
import { Hono } from "hono";
import { localhostOnly } from "./auth.js";
import { resetDatabase } from "./db.js";
import type { FailureInjectionStore } from "./failure-injection.js";
import type { Recorder, ResolvedSession, TwinStripeDatabase } from "./types.js";
import { applySeed, defaultSeed, parseSeed } from "./seed.js";
import { redactSecrets } from "./redaction.js";
import { twinBuildInfo } from "./build-info.js";

export type PomeRoutesOptions = {
  db: TwinStripeDatabase;
  recorder: Recorder;
  toolCount: number;
  /** Process start time in ms (Date.now() at module load). */
  startedAtMs: number;
  /** Inject ms-since-start so tests can stub the clock. */
  nowMs?: () => number;
  /** FDRS-339: in-memory rule store for scenario-level failure injection. */
  failureInjection?: FailureInjectionStore;
};

/**
 * Optional callback used by `mountSessionPomeRoutes` to render the
 * `/_pome/state` payload. AGENT-B's `extendSession` passes a real one
 * that calls `domain.exportState(accountId)`. The chassis-only default
 * surfaces only what the chassis owns.
 *
 * F4: registering the route with an explicit provider — instead of
 * mounting a stub that the domain agent has to shadow — avoids the
 * Hono first-match-wins gotcha that hid real domain state.
 */
export type StateProvider = (c: Context, session: ResolvedSession | undefined) => unknown;

export function tthwSeconds(startedAtMs: number, nowMs: () => number = Date.now) {
  const ms = Math.max(0, nowMs() - startedAtMs);
  return Number((ms / 1000).toFixed(3));
}

/**
 * Mount the root-level pome surfaces (healthz + admin) onto an existing
 * root Hono app. Returns the app for chaining.
 */
export function mountRootPomeRoutes(
  root: Hono,
  opts: PomeRoutesOptions
): Hono {
  const { db, toolCount, startedAtMs, nowMs, failureInjection } = opts;

  root.get("/healthz", (c) =>
    c.json({
      ok: true,
      twin: "stripe",
      implementation: "stripe_clone",
      fidelity: "semantic",
      tools: toolCount,
      tthw_seconds: tthwSeconds(startedAtMs, nowMs),
      runtime: twinBuildInfo()
    })
  );

  const admin = new Hono();
  admin.use("*", localhostOnly());
  admin.post("/reset", (c) => {
    resetDatabase(db);
    applySeed(db, defaultSeed(), failureInjection);
    return c.json({ ok: true, message: "Stripe twin state reset to default seed." });
  });
  admin.post("/seed", async (c) => {
    let payload: unknown = null;
    try {
      payload = await c.req.json();
    } catch {
      payload = null;
    }
    const seed = payload === null ? defaultSeed() : parseSeed(payload);
    resetDatabase(db);
    applySeed(db, seed, failureInjection);
    return c.json({
      ok: true,
      api_keys: (seed.api_keys ?? []).length,
      failure_injection: (seed.failure_injection ?? []).length
    });
  });
  root.route("/admin", admin);

  return root;
}

/**
 * Mount the per-session pome surfaces (`_pome/*`) onto the session router
 * BEFORE the catch-all 501. The session router already has `bearerAuth()`
 * applied at the parent level.
 *
 * `stateProvider` (optional) lets AGENT-B inject a domain-aware payload
 * for `/_pome/state`. If omitted, a chassis-only default is mounted that
 * surfaces nothing twin-domain-specific. AGENT-B's `extendSession`
 * passes a closure over `domain.exportState(accountId)`.
 */
export function mountSessionPomeRoutes(
  session: Hono,
  opts: PomeRoutesOptions,
  stateProvider?: StateProvider
): Hono {
  const { recorder, startedAtMs, nowMs } = opts;

  session.get("/_pome/health", (c) =>
    c.json({
      ok: true,
      twin: "stripe",
      implementation: "stripe_clone",
      fidelity: "semantic",
      tthw_seconds: tthwSeconds(startedAtMs, nowMs),
      runtime: twinBuildInfo(),
      recorder: {
        events: recorder.events().length,
        dropped: recorder.dropped()
      }
    })
  );

  const provider: StateProvider =
    stateProvider ?? (() => ({ api_keys: { count: 0 } }));

  session.get("/_pome/state", (c) => {
    const sess = (c as unknown as { get(key: string): unknown }).get("session") as
      | ResolvedSession
      | undefined;
    return c.json(redactSecrets(provider(c, sess)) as Record<string, unknown>);
  });

  session.get("/_pome/events", (c) => c.json(recorder.events()));

  return session;
}
