// SPDX-License-Identifier: Apache-2.0
//
// Shared presigned-upload + finalize-score orchestration for cloud sessions
// (ADR-013). Extracted verbatim from runScenarioHosted.ts (FDRS-656) so
// `pome eval <run-dir>` reuses the exact same best-effort PUT semantics
// without duplicating them. Behavior-preserving for the hosted run path:
// warning text, the 30s PUT timeout, and the null-key fallbacks all match
// the pre-extraction runner.

import type { HostedClient } from "./client.js";
import type { FinalizeResponse } from "../types/shared.js";
import type { Score } from "../score/view.js";
import { outcomeOf } from "../score/view.js";
import { redactSecrets } from "../recorder/redaction.js";

/** The narrow client surface the upload orchestration needs. `pome eval`
 *  mocks exactly this in tests instead of the full HostedClient. */
export type UploadClient = Pick<
  HostedClient,
  | "requestEventsUploadUrl"
  | "requestStateUploadUrl"
  | "requestSignalsUploadUrl"
>;

export interface RunBlobs {
  eventsJsonl: string;
  stateInitialJson: string;
  stateFinalJson: string;
  /** Pre-redacted JSONL. Empty / whitespace-only skips the signals upload
   *  entirely so cloud doesn't allocate storage for "{}" payloads (F0-4 / L7). */
  signalsJsonl: string;
}

export interface UploadedBlobKeys {
  eventsKey: string | null;
  stateInitialKey: string | null;
  stateFinalKey: string | null;
  signalsKey: string | null;
}

async function putBlob(
  url: string,
  body: string,
  contentType: string,
  label: string,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const putRes = await fetch(url, {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
      signal: ctrl.signal,
    });
    if (!putRes.ok) {
      console.warn(
        `[pome] ${label} upload PUT ${url} → ${putRes.status}; continuing with key=null`,
      );
      return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload events.jsonl + state blobs + adapter signals.jsonl to cloud storage
 * in parallel. /finalize defaults the trace storage key to the conventional
 * `team-<>/session-<>/events.jsonl` path, so cloud's judge finds the trace
 * without an explicit override. State blobs and signals have no conventional
 * fallback today — without an explicit override the judge sees "{}" for
 * state files (FDRS-395) and skips the adapter-rich correlator (F0-4 / L7).
 * All four uploads are best-effort: any failure leaves the corresponding
 * blob missing (`null` key), the judge still runs against whatever it does
 * have, and the dashboard handles nulls gracefully.
 */
export async function uploadRunBlobs(
  client: UploadClient,
  sessionId: string,
  blobs: RunBlobs,
): Promise<UploadedBlobKeys> {
  async function uploadEvents(): Promise<string | null> {
    try {
      const upload = await client.requestEventsUploadUrl(sessionId);
      const ok = await putBlob(
        upload.url,
        blobs.eventsJsonl,
        "application/x-ndjson",
        "events.jsonl",
      );
      return ok ? upload.key : null;
    } catch (err) {
      console.warn(
        `[pome] events.jsonl upload skipped (${
          err instanceof Error ? err.message : String(err)
        }); continuing with events_jsonl_url=null`,
      );
      return null;
    }
  }

  // F0-4 / L7 — upload adapter signals if the agent emitted any. When the
  // payload is empty (no withPome() wrap, or no hooks fired), skip the
  // upload entirely.
  async function uploadSignals(): Promise<string | null> {
    try {
      if (blobs.signalsJsonl.trim().length === 0) {
        return null;
      }
      const upload = await client.requestSignalsUploadUrl(sessionId);
      const ok = await putBlob(
        upload.url,
        blobs.signalsJsonl,
        "application/x-ndjson",
        "signals.jsonl",
      );
      return ok ? upload.key : null;
    } catch (err) {
      console.warn(
        `[pome] signals.jsonl upload skipped (${
          err instanceof Error ? err.message : String(err)
        }); continuing with signals_storage_key=null`,
      );
      return null;
    }
  }

  async function uploadStates(): Promise<{
    initialKey: string | null;
    finalKey: string | null;
  }> {
    try {
      const upload = await client.requestStateUploadUrl(sessionId);
      const [initialOk, finalOk] = await Promise.all([
        putBlob(
          upload.state_initial.url,
          blobs.stateInitialJson,
          "application/json",
          "state_initial.json",
        ),
        putBlob(
          upload.state_final.url,
          blobs.stateFinalJson,
          "application/json",
          "state_final.json",
        ),
      ]);
      return {
        initialKey: initialOk ? upload.state_initial.key : null,
        finalKey: finalOk ? upload.state_final.key : null,
      };
    } catch (err) {
      console.warn(
        `[pome] state blob upload skipped (${
          err instanceof Error ? err.message : String(err)
        }); continuing with state_*_storage_key=null`,
      );
      return { initialKey: null, finalKey: null };
    }
  }

  const [eventsKey, stateKeys, signalsKey] = await Promise.all([
    uploadEvents(),
    uploadStates(),
    uploadSignals(),
  ]);

  return {
    eventsKey,
    stateInitialKey: stateKeys.initialKey,
    stateFinalKey: stateKeys.finalKey,
    signalsKey,
  };
}

/**
 * Synthesize a Score shape backed by the cloud-authoritative satisfaction.
 * F0-3 / L5 — Session A added `criteria_results[]` to /finalize so the CLI
 * can render per-criterion verdicts on hosted runs (`pome inspect`,
 * `pome fix-prompt`) without a follow-up cloud round-trip. Older cloud
 * builds (pre-Session A) omit the field; default to an empty array — the
 * fix-prompt action still bails cleanly when results are missing.
 *
 * A1 CAVEAT (FDRS-618): `satisfaction` here is the CLOUD-authoritative
 * score (`finalized.score`) — the hosted judge does NOT yet implement the
 * FDRS-591/611 outcome semantics, so `evaluated`/`can_pass` are derived
 * locally only when /finalize returns per-criterion results. Older cloud
 * builds omit `criteria_results`; for those, preserve the cloud score as
 * renderable instead of inventing an empty local A5 verdict.
 */
export function scoreFromFinalizeResponse(finalized: FinalizeResponse): Score {
  const hasCriteriaResults = finalized.criteria_results !== undefined;
  const results = finalized.criteria_results ?? [];
  const passed = results.filter((r) => outcomeOf(r) === "passed").length;
  const failed = results.filter((r) => outcomeOf(r) === "failed").length;
  const errored = results.filter((r) => outcomeOf(r) === "errored").length;
  const skipped = results.filter((r) => outcomeOf(r) === "skipped").length;
  const totalRequired = passed + failed;
  return {
    satisfaction: finalized.score,
    passed,
    failed,
    skipped,
    errored,
    total_required: totalRequired,
    evaluated: hasCriteriaResults ? totalRequired > 0 : true,
    can_pass: hasCriteriaResults
      ? totalRequired > 0 && skipped === 0 && errored === 0
      : true,
    results,
    judge_model: finalized.judge_model ?? null,
    judge_tokens_in: null,
    judge_tokens_out: null,
  };
}

/** Redact a JSONL payload line-by-line before upload. Lines that fail to
 *  parse as JSON are redacted as raw strings. Moved verbatim from
 *  runScenarioHosted.ts (FDRS-656). */
export function redactJsonl(body: string): string {
  const lines = body.split("\n");
  const redacted = lines
    // Whitespace-only lines are dropped (not just empty ones) so validation
    // (`validateJsonl`, which trims) and upload agree on what counts as a
    // row — a " " line must never reach cloud as a non-JSON record.
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.stringify(redactSecrets(JSON.parse(line)));
      } catch {
        return redactSecrets(line);
      }
    });
  return redacted.length > 0 ? `${redacted.join("\n")}\n` : "";
}
