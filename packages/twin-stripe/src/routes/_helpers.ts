// SPDX-License-Identifier: Apache-2.0
//
// Per-route helpers: response shaping, error → Stripe envelope conversion,
// recorder emission, query parsing.
//
// Owned by AGENT-B. AGENT-A's app.ts can import and use these directly.

import type { Context } from "hono";
import { z } from "zod";
import { TwinError, stripeError } from "../errors.js";
import {
  FAILURE_INJECTION_OVERRIDE_KEY,
  type FailureInjectionOverride,
} from "../failure-injection.js";
import type {
  Recorder,
  ResolvedSession,
  StateDelta,
  StripeFidelity,
} from "../types.js";
import { requestId } from "../util.js";

/**
 * Pull the account_id off the resolved session set by `bearerAuth()`.
 * Throws if missing — that means a route handler ran without auth, which
 * is a bug.
 */
export function accountId(c: Context): string {
  const session = c.get("session") as ResolvedSession | undefined;
  if (!session) {
    throw new TwinError(
      "api_error",
      "internal_error",
      "Missing session context (auth middleware did not run).",
      { statusCode: 500 }
    );
  }
  return session.account_id;
}

export type RouteResult = {
  status: number;
  body: unknown;
  mutation: boolean;
  /**
   * Optional row-level before/after for state-inspector rendering. When the
   * route doesn't supply one (the default), respond() emits `state_delta:
   * null` regardless of `state_mutation`. Per FDRS-318 canonical schema.
   */
  stateDelta?: StateDelta;
};

export function ok(
  body: unknown,
  mutation = false,
  stateDelta?: StateDelta
): RouteResult {
  return { status: 200, body, mutation, stateDelta };
}

export function created(body: unknown, stateDelta?: StateDelta): RouteResult {
  return { status: 200, body, mutation: true, stateDelta };
  // Stripe returns 200 on POST /v1/payment_intents (not 201). Match it.
}

/**
 * Wrap a route handler. Catches TwinError + Zod errors, emits to the
 * recorder, returns the JSON response. Mirrors twin-github's `handle()`.
 */
export async function handle(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  fn: () => Promise<RouteResult> | RouteResult
) {
  const started = Date.now();
  let requestBody: unknown = null;
  try {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      // Drain the body once for the recorder. Cheap clone since we don't
      // care about parse errors here.
      try {
        requestBody = await c.req.raw.clone().text();
      } catch {
        requestBody = null;
      }
    }
    const result = await fn();
    return respond(
      c,
      recorder,
      runId,
      started,
      requestBody,
      result.status,
      result.body,
      result.mutation,
      "semantic",
      result.stateDelta ?? null
    );
  } catch (error) {
    if (error instanceof TwinError) {
      return respond(
        c,
        recorder,
        runId,
        started,
        requestBody,
        error.status,
        error.toEnvelope(),
        false,
        error.fidelity ?? "semantic",
        null
      );
    }
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      const envelope = stripeError(
        "invalid_request_error",
        "parameter_invalid",
        first?.message ?? "Invalid request parameters.",
        { param: first?.path?.join(".") }
      );
      return respond(
        c,
        recorder,
        runId,
        started,
        requestBody,
        envelope.status,
        envelope.body,
        false,
        "semantic",
        null
      );
    }
    if (error instanceof SyntaxError) {
      const envelope = stripeError(
        "invalid_request_error",
        "invalid_json",
        "Could not parse request body as JSON."
      );
      return respond(
        c,
        recorder,
        runId,
        started,
        requestBody,
        envelope.status,
        envelope.body,
        false,
        "semantic",
        null
      );
    }
    const envelope = stripeError(
      "api_error",
      "internal_error",
      error instanceof Error ? error.message : "Internal Server Error",
      { statusCode: 500 }
    );
    return respond(
      c,
      recorder,
      runId,
      started,
      requestBody,
      envelope.status,
      envelope.body,
      false,
      "semantic",
      null
    );
  }
}

export function respond(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  started: number,
  requestBody: unknown,
  status: number,
  responseBody: unknown,
  stateMutation: boolean,
  fidelity: StripeFidelity = "semantic",
  stateDelta: StateDelta = null
) {
  const reqId = requestId();
  // FDRS-339: if the failure-injection middleware matched in `after_handler`
  // mode, it parked an override on the context. The handler has already
  // mutated state (so state_mutation + state_delta stay truthful), but the
  // status + response_body on both the recorded event and the wire response
  // are replaced with the configured envelope.
  const override = (c.get(FAILURE_INJECTION_OVERRIDE_KEY as never) as
    | FailureInjectionOverride
    | undefined) ?? null;
  const finalStatus = override ? override.status : status;
  const finalBody = override ? override.body : responseBody;
  recorder?.record({
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
    request_body: requestBody,
    status: finalStatus,
    response_body: finalBody,
    latency_ms: Date.now() - started,
    fidelity,
    state_mutation: stateMutation,
    state_delta: stateDelta,
    error: finalStatus >= 400 ? errorMessage(finalBody) : null,
  });
  return c.json(finalBody as never, finalStatus as never);
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "request failed";
}

/** Pull standard list-query params off the Hono Context. */
export function parseListQuery(c: Context) {
  const limit = c.req.query("limit");
  const numericLimit = limit !== undefined ? Number(limit) : undefined;
  const created = createdRangeFromQuery(c);
  return {
    limit: Number.isFinite(numericLimit) ? numericLimit : undefined,
    starting_after: c.req.query("starting_after"),
    ending_before: c.req.query("ending_before"),
    ...created,
  } as Record<string, unknown>;
}

function createdRangeFromQuery(c: Context) {
  const out: Record<string, number> = {};
  const flat = c.req.query("created");
  if (flat !== undefined && /^\d+$/.test(flat)) {
    out.created_gte = Number(flat);
    out.created_lte = Number(flat);
  }
  const gt = c.req.query("created[gt]");
  const gte = c.req.query("created[gte]");
  const lt = c.req.query("created[lt]");
  const lte = c.req.query("created[lte]");
  if (gt && /^\d+$/.test(gt)) out.created_gt = Number(gt);
  if (gte && /^\d+$/.test(gte)) out.created_gte = Number(gte);
  if (lt && /^\d+$/.test(lt)) out.created_lt = Number(lt);
  if (lte && /^\d+$/.test(lte)) out.created_lte = Number(lte);
  return out;
}
