// SPDX-License-Identifier: Apache-2.0
//
// Shared presigned-upload + finalize-score orchestration for cloud sessions
// (ADR-013). Extracted verbatim from runScenarioHosted.ts (FDRS-656) so
// `pome eval <run-dir>` reuses the exact same best-effort PUT semantics
// without duplicating them. Behavior-preserving for the hosted run path:
// warning text, the 30s PUT timeout, and the null-key fallbacks all match
// the pre-extraction runner.

import type { HostedClient } from "./client.js";
import type { FinalizeResponse, PerTwinStateKeys } from "../types/shared.js";
import type { Score } from "./evalResultView.js";
import { outcomeOf } from "./evalResultView.js";
import { redactSecrets } from "../recorder/redaction.js";

/** The narrow client surface the upload orchestration needs. `pome eval`
 *  mocks exactly this in tests instead of the full HostedClient. */
export type UploadClient = Pick<
  HostedClient,
  | "requestEventsUploadUrl"
  | "requestStateUploadUrl"
  | "requestSignalsUploadUrl"
  | "requestMetaUploadUrl"
>;

export interface RunBlobs {
  eventsJsonl: string;
  stateInitialJson: string;
  stateFinalJson: string;
  /** Pre-redacted JSONL. Empty / whitespace-only skips the signals upload
   *  entirely so cloud doesn't allocate storage for "{}" payloads (F0-4 / L7). */
  signalsJsonl: string;
  /** D18.1 — the run's meta.json (spec_version + twin_versions + the rest of
   *  writeRunArtifactsCore's payload), as written to / read from disk. */
  metaJson: string;
  /** Multi-twin (M3): the session's twins. When >1, per-twin state upload URLs
   *  are requested and each twin's state blobs are uploaded under its own
   *  storage prefix. Absent / length ≤1 keeps the single-twin path unchanged. */
  twins?: string[];
  /** Multi-twin (M3): per-twin initial/final state JSON, keyed by twin id.
   *  Includes the primary twin (whose blobs also go to the legacy top-level
   *  pair). Only consumed when `twins.length > 1` and the cloud returns a
   *  `per_twin` upload block. */
  perTwinState?: Record<string, { initialJson: string; finalJson: string }>;
}

export interface UploadedBlobKeys {
  eventsKey: string | null;
  stateInitialKey: string | null;
  stateFinalKey: string | null;
  signalsKey: string | null;
  /** Multi-twin (M3): per-twin state storage keys, keyed by twin id. Each entry
   *  carries at least one uploaded key (empty entries are dropped so the
   *  finalize contract's ">=1 key per entry" invariant holds). Undefined when
   *  the session is single-twin or the cloud returned no `per_twin` block. */
  perTwinStateKeys?: PerTwinStateKeys;
  /** D18.1 — the storage key the presigned PUT landed at, or null whenever
   *  the upload didn't happen, INCLUDING the feature-detection case (older
   *  control plane 404s meta-upload-url). Never distinguished from any other
   *  failure — same best-effort contract as every other blob here.
   *
   *  NOT threaded onto /finalize (unlike the state / signals keys): the cloud
   *  contract auto-discovers meta.json by the conventional session-prefixed
   *  path — see uploadRunBlobs and uploadMeta below. Returned only so callers
   *  and tests can observe whether the upload happened. */
  metaKey: string | null;
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
 * meta.json (D18.1/D18.6) DOES have a conventional fallback: cloud finalize
 * auto-discovers it at `team-<>/session-<>/meta.json`, so its key is uploaded
 * to that path and never threaded onto /finalize (see uploadMeta below).
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
    perTwinStateKeys?: PerTwinStateKeys;
  }> {
    const multiTwin = (blobs.twins?.length ?? 0) > 1;
    try {
      // Multi-twin (M3): ask for a per-twin URL block; single-twin passes
      // nothing so the request body stays `{}` (byte-identical to pre-M3).
      const upload = await client.requestStateUploadUrl(
        sessionId,
        multiTwin ? blobs.twins : undefined,
      );
      // Top-level (primary-twin) pair — always uploaded, legacy state_*_storage_key.
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

      // Multi-twin: upload each twin's blobs to its own storage prefix and
      // collect the keys. Only when the cloud actually returned a `per_twin`
      // block (an older cloud omits it → we fall back to the primary-only
      // top-level keys, degrading gracefully). Entries with no uploaded key are
      // dropped so the finalize contract's ">=1 key per entry" holds.
      let perTwinStateKeys: PerTwinStateKeys | undefined;
      if (multiTwin && upload.per_twin) {
        const collected: PerTwinStateKeys = {};
        for (const twin of blobs.twins ?? []) {
          const pair = upload.per_twin[twin];
          const state = blobs.perTwinState?.[twin];
          if (!pair || !state) continue;
          const [iOk, fOk] = await Promise.all([
            putBlob(
              pair.state_initial.url,
              state.initialJson,
              "application/json",
              `state_initial.${twin}.json`,
            ),
            putBlob(
              pair.state_final.url,
              state.finalJson,
              "application/json",
              `state_final.${twin}.json`,
            ),
          ]);
          const entry: { state_initial_key?: string; state_final_key?: string } = {};
          if (iOk) entry.state_initial_key = pair.state_initial.key;
          if (fOk) entry.state_final_key = pair.state_final.key;
          if (entry.state_initial_key !== undefined || entry.state_final_key !== undefined) {
            collected[twin] = entry;
          }
        }
        if (Object.keys(collected).length > 0) perTwinStateKeys = collected;
      }

      return {
        initialKey: initialOk ? upload.state_initial.key : null,
        finalKey: finalOk ? upload.state_final.key : null,
        perTwinStateKeys,
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

  // D18.1 / D18.6 — upload meta.json via the presigned route. The mint route
  // signs the CONVENTIONAL `team-<>/session-<>/meta.json` path, and cloud's
  // /finalize AUTO-DISCOVERS the blob at that same conventional path (it
  // downloads it unconditionally when no explicit override is given — see
  // pome-cloud services/finalize-run.ts, which defaults `metaStorageKey` to
  // the conventional path). So — unlike the state / signals keys — the
  // returned meta key is deliberately NOT threaded onto the /finalize body:
  // uploading to the conventional path is the whole contract. There is no
  // `meta_storage_key` finalize field to null out.
  //
  // FEATURE-DETECT: a control plane that predates
  // `POST /v1/sessions/:id/meta-upload-url` 404s the mint call, which lands
  // in this same catch as any other failure — warn and continue. Identical
  // best-effort shape to the other three uploads; never surfaced to the
  // caller as distinct from "upload failed".
  async function uploadMeta(): Promise<string | null> {
    try {
      const upload = await client.requestMetaUploadUrl(sessionId);
      const ok = await putBlob(
        upload.url,
        blobs.metaJson,
        "application/json",
        "meta.json",
      );
      return ok ? upload.key : null;
    } catch (err) {
      console.warn(
        `[pome] meta.json upload skipped (${
          err instanceof Error ? err.message : String(err)
        }); cloud will finalize without producing-twin metadata for this run`,
      );
      return null;
    }
  }

  const [eventsKey, stateKeys, signalsKey, metaKey] = await Promise.all([
    uploadEvents(),
    uploadStates(),
    uploadSignals(),
    uploadMeta(),
  ]);

  return {
    eventsKey,
    stateInitialKey: stateKeys.initialKey,
    stateFinalKey: stateKeys.finalKey,
    perTwinStateKeys: stateKeys.perTwinStateKeys,
    metaKey,
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
