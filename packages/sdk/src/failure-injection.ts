// SPDX-License-Identifier: Apache-2.0
//
// Scenario-level failure injection (FDRS-339), graduated from twin-stripe
// into the engine by the F-684 port ruling: making a twin fail on attempt N
// of a (method, path) tuple is a generic twin capability — any provider
// double needs "the server processed it but the client never saw the
// response" to reproduce lost-response retry bugs. Only the rule *payloads*
// (status + error envelope) are twin-domain; they ride in via the seed.
//
// Two modes:
//
//   - `before_handler` → the matched request never reaches the route
//     handler; the middleware returns the configured envelope directly and
//     records a `state_mutation: false`, `state_delta: null` event.
//   - `after_handler` → the handler is invoked normally (state mutation
//     and `state_delta` capture proceed). The middleware parks the override
//     on the context under `FAILURE_INJECTION_OVERRIDE_KEY`; the twin's
//     response path substitutes status + body on the way out, so the
//     recorded event and the wire agree. This models a "server processed
//     but response delivery failed" failure — required to reproduce the
//     FDRS-316 hero scenario.
//
// Counters live per `(account_id, method, path)` so successive POSTs from
// the same account to the same path resolve to `attempt: 1`, `attempt: 2`,
// …, deterministically. Other routes don't influence the counter — only
// requests to a tuple that has at least one registered rule are counted.

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { RecorderEvent } from "@pome-sh/shared-types";

export const FAILURE_INJECTION_OVERRIDE_KEY = "failureInjectionOverride";

export type FailureInjectionOverride = {
  status: number;
  body: unknown;
};

export type FailureInjectionMode = "before_handler" | "after_handler";

export type FailureInjectionRule = {
  method: string;
  path: string;
  attempt: number;
  mode: FailureInjectionMode;
  status: number;
  body: unknown;
};

export const failureInjectionRuleSchema = z.object({
  method: z.string().min(1).transform((s) => s.toUpperCase()),
  path: z.string().min(1),
  attempt: z.number().int().positive(),
  mode: z
    .enum(["before_handler", "after_handler"] as const satisfies readonly FailureInjectionMode[])
    .default("after_handler"),
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
});

export type FailureInjectionStore = {
  setRules(rules: FailureInjectionRule[]): void;
  clear(): void;
  matchAndConsume(
    accountId: string,
    method: string,
    path: string
  ): FailureInjectionRule | null;
};

export function createFailureInjectionStore(): FailureInjectionStore {
  // The store is intentionally global across accounts. The (account_id,
  // method, path) counter keys keep accounts independent for matching;
  // rules themselves apply to whichever account issues the matching
  // request. Single-account scenarios (the common case, including the
  // FDRS-316 hero) don't need to express scope per rule.
  let rules: FailureInjectionRule[] = [];
  const counters = new Map<string, number>();
  const tuplesWithRules = new Set<string>();

  function tupleKey(method: string, path: string) {
    return `${method.toUpperCase()}\0${path}`;
  }
  function counterKey(accountId: string, method: string, path: string) {
    return `${accountId}\0${method.toUpperCase()}\0${path}`;
  }
  function rebuildIndex() {
    tuplesWithRules.clear();
    for (const r of rules) tuplesWithRules.add(tupleKey(r.method, r.path));
  }

  return {
    setRules(next) {
      rules = next.slice();
      counters.clear();
      rebuildIndex();
    },
    clear() {
      rules = [];
      counters.clear();
      tuplesWithRules.clear();
    },
    matchAndConsume(accountId, method, path) {
      const tk = tupleKey(method, path);
      if (!tuplesWithRules.has(tk)) return null;
      const ck = counterKey(accountId, method, path);
      const count = (counters.get(ck) ?? 0) + 1;
      counters.set(ck, count);
      return (
        rules.find(
          (r) =>
            r.method.toUpperCase() === method.toUpperCase() &&
            r.path === path &&
            r.attempt === count
        ) ?? null
      );
    },
  };
}

export interface FailureInjectionMiddlewareOptions {
  /** Sink for before_handler events. Optional — a recorderless app still injects. */
  recorder?: { record(event: RecorderEvent): void };
  runId: string;
  twin: string;
}

export function failureInjectionMiddleware(
  store: FailureInjectionStore,
  options: FailureInjectionMiddlewareOptions
): MiddlewareHandler {
  return async (c, next) => {
    const session = c.get("session") as { account_id?: unknown; sid?: unknown } | undefined;
    // Auth runs first; if it failed there's no session and we shouldn't
    // shadow that with a manufactured failure.
    if (!session) {
      await next();
      return;
    }
    const accountId =
      typeof session.account_id === "string" ? session.account_id : String(session.sid ?? "_anon");

    const method = c.req.method.toUpperCase();
    const rawPath = new URL(c.req.url).pathname;
    // Rules are written against the canonical provider path
    // (e.g., "/v1/refunds"). Strip the session prefix when present so
    // path-mounted (`/s/:sid/v1/refunds`) and root-mounted (`/v1/refunds`,
    // stripe F3 SDK compat) requests both match.
    const path = stripSessionPrefix(rawPath);

    const rule = store.matchAndConsume(accountId, method, path);
    if (!rule) {
      await next();
      return;
    }

    if (rule.mode === "before_handler") {
      const started = Date.now();
      let requestBody: unknown = null;
      try {
        requestBody = await c.req.raw.clone().text();
      } catch {
        requestBody = null;
      }
      const requestId = `req_${randomUUID()}`;
      const stepId = c.req.header("x-pome-scenario-step-id") ?? null;
      options.recorder?.record({
        ts: new Date().toISOString(),
        run_id: options.runId,
        twin: options.twin,
        request_id: requestId,
        correlation_id: c.req.header("x-pome-correlation-id") ?? requestId,
        task_step_id: stepId,
        scenario_step_id: stepId,
        step_id: null,
        tool_call_id: null,
        method,
        path: rawPath,
        request_body: requestBody,
        status: rule.status,
        response_body: rule.body,
        latency_ms: Date.now() - started,
        fidelity: "semantic",
        state_mutation: false,
        state_delta: null,
        error: rule.status >= 400 ? errorMessage(rule.body) : null,
      });
      return c.json(rule.body as never, rule.status as never);
    }

    // after_handler: let the handler run, but stash the override so the
    // twin's response path can substitute status + body on the way out.
    // state_mutation + state_delta keep the real-handler truth.
    const override: FailureInjectionOverride = { status: rule.status, body: rule.body };
    c.set(FAILURE_INJECTION_OVERRIDE_KEY as never, override as never);
    await next();
  };
}

function stripSessionPrefix(path: string): string {
  const match = path.match(/^\/s\/[^/]+(\/.*)$/);
  return match?.[1] ?? path;
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "request failed";
}
