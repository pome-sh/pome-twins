// SPDX-License-Identifier: Apache-2.0
// Twin-core recorder (F-681 / F-720). Home: `packages/sdk/src/recorder.ts`
// (`@pome-sh/sdk`); all first-party twins and the CLI harness consume it.
// In-memory recorder + `handle()` helper. `handle({mutation}, fn)` wraps a
// Hono handler so every wrapped route emits a `RecorderEvent` matching
// `recording-spec.md` v1.0:
//   - `latency_ms` boundary: start = Date.now() before request body parse,
//     end = Date.now() immediately before c.json() writes the response.
//   - `state_mutation` = the declared route/tool mutation flag.
//   - `error` = response_body.message when status >= 400, null otherwise.
//   - Memory is bounded by session timeout × max-rps.
// ── Write-through contract (F-720) ──────────────────────────────────────────
// Acceptance: an event is *accepted* once `RecorderStore.record()` returns.
// Heap stores retain it in memory; durable stores queue it for append.
// `flush()` / `close()` are the durability barrier; `record()` is not fsync.
// Recording pipeline: optional `recordingProjection` (twin-supplied) runs
// first, then `createRecorderHandle` redacts *before* every `store.record()`
// call — including custom stores and direct `recorder.record()` — so no
// store ever sees unredacted secrets. Stores must not re-emit raw bodies.
// Persisted row shape (F-698): durable stores write one redacted
// `TwinHttpEvent` NDJSON line per accepted event (shared-types
// `twinHttpEventSchema`) so on-disk `events.jsonl` matches the uploaded
// raw-trace byte shape. The in-memory mirror / `GET /_pome/events` still
// exposes legacy `RecorderEvent` rows.
// `flush()`: optional. When present, resolves after every accepted event is
// durable on the store's backing medium (fsync for file-backed). In-memory
// stores may omit it (no-op if called via a handle that forwards). Callers
// that need crash-bounded loss (≤ in-flight event) must await `flush()`
// before relying on the on-disk tape, or use a store that fsyncs on each
// `record()` (F-698 production default).
// `close()`: optional. When present, flushes pending writes, releases the
// backing resource, and is idempotent. After `close()`, further `record()`
// calls are undefined (stores should throw or no-op). Callers must await
// `close()` (or at least `flush()`) before upload/finalize so every accepted
// write has either landed on disk or surfaced as a flush/close error.
// Bounded stores (`maxEvents`): the cap applies only to the in-memory mirror
// used by `events()` / `GET /_pome/events` (memory pressure). The durable
// NDJSON tape is append-only and retains every accepted write — including
// rows later dropped from the heap mirror — so crash-safe upload reads the
// tape, not `events()`.
// Default runtime behavior: `createRecorderStore()` remains heap-only.
// Set `POME_RECORDER_EVENTS_PATH` (or pass `createFileBackedRecorderStore`)
// for durable write-through; twin boot resolves via `resolveRecorderStore()`.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  fsync,
  mkdirSync,
  openSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";
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

/**
 * Backing store for the twin-core recorder.
 *
 * `record` / `events` are required. `flush` / `close` are optional so existing
 * in-memory callers stay source-compatible; durable stores implement them.
 */
export interface RecorderStore {
  record(event: RecorderEvent): void;
  events(): RecorderEvent[];
  /** Event count without the O(N) copy `events()` makes. Optional for custom stores. */
  count?(): number;
  /** Events dropped by a bounded store (stripe pins a 10k cap + dropped counter). */
  dropped?(): number;
  /**
   * Durability barrier. Resolves when every previously accepted event is on
   * the backing medium. Optional for heap-only stores.
   */
  flush?(): Promise<void>;
  /**
   * Flush + release. Idempotent. Optional for heap-only stores.
   */
  close?(): Promise<void>;
}

export interface RecorderStoreOptions {
  /**
   * Bound the in-memory tape: past `maxEvents` the store drops the OLDEST
   * event and increments the `dropped()` counter (stripe's pre-port
   * D-ENG-10/E-10 recorder behavior). Default: unbounded (github/slack).
   * For file-backed stores this does **not** truncate the NDJSON tape —
   * durability stays append-only; only `events()` is capped.
   */
  maxEvents?: number;
}

export function createRecorderStore(options: RecorderStoreOptions = {}): RecorderStore {
  const items: RecorderEvent[] = [];
  const cap = options.maxEvents !== undefined ? Math.max(1, options.maxEvents) : undefined;
  let droppedCount = 0;
  return {
    record(event) {
      items.push(event);
      if (cap !== undefined) {
        while (items.length > cap) {
          items.shift();
          droppedCount += 1;
        }
      }
    },
    events() {
      return [...items];
    },
    count() {
      return items.length;
    },
    dropped() {
      return droppedCount;
    },
    async flush() {
      // Heap-only: accepted === durable for this store.
    },
    async close() {
      // No backing resource.
    },
  };
}

export interface FileBackedRecorderStoreOptions extends RecorderStoreOptions {
  /**
   * Path to the NDJSON tape (typically a run's `events.jsonl` or a sidecar).
   * Parent directories are created if missing. Opens append-mode.
   */
  path: string;
  /**
   * When true, each accepted write is `fsync`'d so a `kill -9` loses at most
   * the in-flight event. Default true for the production durable path (F-698).
   */
  fsync?: boolean;
}

/**
 * Env key for the durable recorder tape. When set, twin boot paths and the
 * self-host harness use `createFileBackedRecorderStore` instead of heap-only.
 * Architecture (F-698 / §9 Q3): recorder *transport* lives in twin-core
 * (`packages/sdk`); twins inherit durability by reading this env.
 */
export const POME_RECORDER_EVENTS_PATH = "POME_RECORDER_EVENTS_PATH";

/**
 * Wrap a legacy `RecorderEvent` into the unified `TwinHttpEvent` NDJSON row
 * shape used by uploaded `events.jsonl` (FDRS-398). Pass-through only when
 * `kind` is already `"TwinHttpEvent"`; any other kind is re-wrapped so the
 * durable tape never persists a mismatched discriminator. Disk rows from the
 * durable store use this shape so finalize/upload does not need a second wrap
 * for crash-streamed events.
 */
export function toTwinHttpEventRow(
  event: RecorderEvent
): RecorderEvent & { kind: "TwinHttpEvent"; event_id: string; parent_id: null } {
  const maybeKind = (event as { kind?: unknown }).kind;
  if (maybeKind === "TwinHttpEvent") {
    const existing = event as RecorderEvent & {
      kind: "TwinHttpEvent";
      event_id?: string;
      parent_id?: null;
    };
    return {
      ...existing,
      event_id: typeof existing.event_id === "string" ? existing.event_id : event.request_id,
      parent_id: null,
    };
  }
  return {
    ...event,
    kind: "TwinHttpEvent",
    event_id: event.request_id,
    parent_id: null,
  };
}

/**
 * Durable recorder store (F-720 contract / F-698 implementation).
 *
 * Keeps an in-memory mirror of legacy `RecorderEvent` rows for `events()` /
 * `GET /_pome/events` (unchanged API), and appends each accepted event as a
 * `TwinHttpEvent` NDJSON line so on-disk `events.jsonl` matches the uploaded
 * raw-trace byte shape. `flush()` drains pending writes and rethrows the
 * first append/fsync failure; `fsync` (default true) bounds crash loss to
 * the in-flight event. `maxEvents` caps only the heap mirror — the NDJSON
 * tape stays append-only.
 */
export function createFileBackedRecorderStore(
  options: FileBackedRecorderStoreOptions
): RecorderStore {
  const items: RecorderEvent[] = [];
  const cap = options.maxEvents !== undefined ? Math.max(1, options.maxEvents) : undefined;
  let droppedCount = 0;
  let closed = false;
  const doFsync = options.fsync !== false;

  mkdirSync(dirname(options.path), { recursive: true });
  // Open the fd synchronously so fsync never races createWriteStream's
  // async open (which can leave `writer.fd` undefined and silently skip
  // durability on the first write).
  const fd = openSync(options.path, "a");
  const writer: WriteStream = createWriteStream(options.path, { fd, autoClose: false });
  const pending = new Set<Promise<void>>();
  // First append/fsync failure is retained so a later flush()/close() still
  // reports it even after the rejected promise leaves `pending`.
  let writeFailure: Error | null = null;

  function enqueueWrite(line: string): void {
    const write = new Promise<void>((resolve, reject) => {
      writer.write(line, (err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!doFsync) {
          resolve();
          return;
        }
        fsync(fd, (fsyncErr) => (fsyncErr ? reject(fsyncErr) : resolve()));
      });
    });
    pending.add(write);
    // Handle rejection here so a failed write before flush() is not an
    // unhandled rejection, and so flush() can still surface the error after
    // the promise has left `pending`.
    void write.then(
      () => {
        pending.delete(write);
      },
      (err: unknown) => {
        pending.delete(write);
        if (!writeFailure) {
          writeFailure = err instanceof Error ? err : new Error(String(err));
        }
      }
    );
  }

  async function flush(): Promise<void> {
    while (pending.size > 0) {
      // allSettled: individual failures are already captured in writeFailure;
      // awaiting a rejected member of `pending` must not short-circuit drain.
      await Promise.allSettled([...pending]);
    }
    if (writeFailure) {
      const err = writeFailure;
      writeFailure = null;
      throw err;
    }
  }

  return {
    record(event) {
      if (closed) {
        throw new Error("RecorderStore.record() after close()");
      }
      items.push(event);
      if (cap !== undefined) {
        while (items.length > cap) {
          items.shift();
          droppedCount += 1;
        }
      }
      enqueueWrite(`${JSON.stringify(toTwinHttpEventRow(event))}\n`);
    },
    events() {
      return [...items];
    },
    count() {
      return items.length;
    },
    dropped() {
      return droppedCount;
    },
    flush,
    async close() {
      if (closed) {
        await flush();
        return;
      }
      closed = true;
      await flush();
      await new Promise<void>((resolve, reject) => {
        writer.end((err: Error | null | undefined) => {
          try {
            closeSync(fd);
          } catch (closeErr) {
            reject(err ?? (closeErr as Error));
            return;
          }
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

/**
 * Resolve the recorder store for a twin boot: durable file-backed when
 * `POME_RECORDER_EVENTS_PATH` is set, otherwise the in-memory default.
 */
export function resolveRecorderStore(options: RecorderStoreOptions = {}): RecorderStore {
  const path = process.env[POME_RECORDER_EVENTS_PATH]?.trim();
  if (path) {
    return createFileBackedRecorderStore({ ...options, path });
  }
  return createRecorderStore(options);
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
  /**
   * FDRS-402 adapter-rich stamping pin (F-682): when true, events persist
   * the incoming `x-pome-correlation-id` header as `tool_call_id` (github's
   * frozen tape shape). Default false — slack's frozen tape stamps null.
   */
  stampToolCallId?: boolean;
  /**
   * Optional pre-redaction projection (from `TwinDefinition.recordingProjection`).
   * Runs before `redactEvent` so twins can replace raw payloads with digests
   * without bypassing the secret scrubber. Unset = no-op (existing twins).
   */
  recordingProjection?: (event: RecorderEvent) => RecorderEvent;
}

export function createRecorderHandle(options: RecorderHandleOptions): RecorderHandle {
  const store = options.store ?? createRecorderStore();
  const errorEnvelope: ErrorEnvelopeFn = options.errorEnvelope ?? envelopeFor;
  const project = options.recordingProjection;

  function accept(event: RecorderEvent): void {
    // Projection (optional) → secret redaction (always). Order is load-bearing:
    // Gmail replaces MIME/attachment bytes with digests before scrubbing.
    store.record(redactEvent(project ? project(event) : event));
  }

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
    const correlationHeader = c.req.header("x-pome-correlation-id") ?? null;
    // Redaction is unconditional at the engine layer (F-681 / F-720): every
    // event that reaches any store — including custom stores — is already
    // scrubbed. Optional recordingProjection runs immediately before that.
    accept({
      ts: new Date().toISOString(),
      run_id: options.runId,
      twin: options.twin,
      request_id: requestId,
      correlation_id: correlationHeader ?? requestId,
      task_step_id: stepId,
      scenario_step_id: stepId,
      step_id: null,
      // FDRS-402 adapter-rich path: only twins that pin `stampToolCallId`
      // persist the header here (github); the default tape stamps null.
      tool_call_id: options.stampToolCallId ? correlationHeader : null,
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
    });
  }

  return {
    record(event) {
      accept(event);
    },
    events() {
      return store.events();
    },
    count() {
      return store.count?.() ?? store.events().length;
    },
    dropped() {
      return store.dropped?.() ?? 0;
    },
    async flush() {
      await store.flush?.();
    },
    async close() {
      await store.close?.();
    },
    handle({ mutation, fidelity = "semantic", errorEnvelope: perCallEnvelope }, fn) {
      const projectError = perCallEnvelope ?? errorEnvelope;
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
          return respondWith(c, result.status, result.body);
        } catch (caught) {
          const envelope = projectError(caught);
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
          return respondWith(c, envelope.status, envelope.body);
        }
      };
    },
  };
}

// The Response constructor forbids a body on null-body statuses (204/205/
// 304) — `c.json(null, 204)` throws and surfaces as a 500. github's frozen
// surface answers deletes and the collaborator-membership check with a bare
// 204 (F-682), so those statuses return an empty body.
function respondWith(c: Context, status: number, body: unknown): Response {
  if (status === 204 || status === 205 || status === 304) {
    return c.body(null, status as never);
  }
  return c.json(body as never, status as never);
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
