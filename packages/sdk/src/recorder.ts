// SPDX-License-Identifier: Apache-2.0
//
// In-memory recorder + `handle()` helper. `handle({mutation}, fn)` wraps a
// Hono handler so every wrapped route emits a `RecorderEvent` matching
// `recording-spec.md` v1.0:
//   - `latency_ms` boundary: start = Date.now() before request body parse,
//     end = Date.now() immediately before c.json() writes the response.
//   - `state_mutation` = the `mutation` flag passed in. For tool-derived
//     routes the SDK plumbs the tool's declared mutation flag, so the
//     recording-spec invariant ("must equal the tool's declared mutation
//     flag") holds by construction.
//   - `error` = response_body.message when status >= 400, null otherwise.
//   - Memory: bounded by session timeout × max-rps; events live for the
//     pod's lifetime and are read once via GET /_pome/events at end-of-run.

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { RecorderEvent, TwinId } from "@pome-sh/shared-types";
import type { RecorderHandle, RecorderHandlerResult } from "./index.js";
import { envelopeFor } from "./errors.js";
import { redactEvent } from "./redaction.js";

/**
 * Projects a thrown error into the `{ status, body }` shape a route returns.
 * Twin authors override this via `TwinDefinition.errorEnvelope` to preserve
 * the upstream API's error shape (Stripe nests under `{ error: {...} }`;
 * GitHub uses `{ message, documentation_url, errors[] }`; etc).
 */
export type ErrorEnvelopeFn = (err: unknown) => { status: number; body: unknown };

export interface RecorderStore {
  record(event: RecorderEvent): void;
  events(): RecorderEvent[];
}

export function createRecorderStore(): RecorderStore {
  const items: RecorderEvent[] = [];
  return {
    record(event) {
      items.push(event);
    },
    events() {
      return [...items];
    },
  };
}

export interface RecorderHandleOptions {
  runId: string;
  twin: TwinId;
  store?: RecorderStore;
  /**
   * Projects thrown errors into a route response. Defaults to the generic
   * `{ message, errors? }` envelope; the SDK's `createApp` forwards
   * `definition.errorEnvelope` here so API-mirroring twins control their
   * own error shape without bypassing the recorder middleware.
   */
  errorEnvelope?: ErrorEnvelopeFn;
}

export function createRecorderHandle(options: RecorderHandleOptions): RecorderHandle {
  const store = options.store ?? createRecorderStore();
  const errorEnvelope: ErrorEnvelopeFn = options.errorEnvelope ?? envelopeFor;

  function emit(
    c: Context,
    started: number,
    requestBody: unknown,
    result: RecorderHandlerResult,
    mutation: boolean,
    fidelity: "semantic" | "unsupported",
    error: string | null
  ) {
    const requestId = `req_${randomUUID()}`;
    // FDRS-402 / FDRS-653 stamping (F-683: engine parity with the per-twin
    // recorders it replaces): correlation_id persists the adapter's
    // x-pome-correlation-id (falling back to the request id), and the task
    // author's x-pome-scenario-step-id lands as the canonical task_step_id
    // plus the legacy scenario_step_id key (frozen v1 trace format —
    // preserve semantics, tolerant readers accept either).
    const stepId = c.req.header("x-pome-scenario-step-id") ?? null;
    // Redaction is unconditional at the engine layer (F-681): every event
    // that reaches any store — including custom stores — is already scrubbed.
    store.record(redactEvent({
      ts: new Date().toISOString(),
      run_id: options.runId,
      twin: options.twin,
      request_id: requestId,
      correlation_id: c.req.header("x-pome-correlation-id") ?? requestId,
      task_step_id: stepId,
      scenario_step_id: stepId,
      step_id: null,
      tool_call_id: null,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      request_body: requestBody,
      status: result.status,
      response_body: result.body,
      latency_ms: Date.now() - started,
      fidelity,
      state_mutation: mutation,
      state_delta: result.delta ?? null,
      error,
    }));
  }

  return {
    record(event) {
      store.record(redactEvent(event));
    },
    events() {
      return store.events();
    },
    handle({ mutation, fidelity = "semantic" }, fn) {
      return async (c) => {
        const started = Date.now();
        let requestBody: unknown = null;
        try {
          requestBody =
            c.req.method === "GET" || c.req.method === "HEAD"
              ? null
              : await readRequestJson(c);
          const result = await fn(c);
          const effectiveMutation = result.mutation ?? mutation;
          const errorMsg =
            result.status >= 400 ? extractMessage(result.body) ?? "request failed" : null;
          emit(c, started, requestBody, result, effectiveMutation, fidelity, errorMsg);
          return c.json(result.body as never, result.status as never);
        } catch (caught) {
          const envelope = errorEnvelope(caught);
          // Failed routes never mutated state — record as state_mutation=false
          // regardless of the declared flag. Per recording-spec § state_mutation,
          // the field reflects whether the request *did* mutate state.
          const errMsg =
            extractMessage(envelope.body) ??
            (caught instanceof Error ? caught.message : "request failed");
          emit(
            c,
            started,
            requestBody,
            { status: envelope.status, body: envelope.body },
            false,
            fidelity,
            errMsg
          );
          return c.json(envelope.body as never, envelope.status as never);
        }
      };
    },
  };
}

// `clone()` throws synchronously once the body stream is disturbed — e.g.
// after the form token resolver's parseBody() read a form-encoded POST
// (F-683). A consumed or non-JSON body records as null, never a 500.
async function readRequestJson(c: Context): Promise<unknown> {
  try {
    return await c.req.raw.clone().json();
  } catch {
    return null;
  }
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}
