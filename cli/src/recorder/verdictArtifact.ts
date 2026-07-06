// SPDX-License-Identifier: Apache-2.0
// FDRS-644 — the per-trial CLOUD verdict artifact.
//
// Hosted `pome run` persists each finalized trial's cloud verdict payload
// (what /finalize returned and the terminal rendered) as `verdict.json`
// next to the trial's raw trace. This is a provenance-labeled CACHE of the
// cloud judge's output — NOT a local score: the OSS CLI still has no
// scoring engine (FDRS-657 / no-eval-in-oss), score.json is still never
// written, and deleting verdict.json loses nothing the dashboard doesn't
// hold. `pome fix-prompt` reads these to hand grouped failure signatures
// to the user's coding agent without a credentialed cloud round-trip —
// the F0-3 / L5 intent recorded in uploadAndFinalize.ts ("so the CLI can
// render per-criterion verdicts … without a follow-up cloud round-trip").
//
// Artifact-layout knowledge lives HERE and only here:
//   <artifacts-root>/<task-slug>/<session-id>/verdict.json
// (runDir shape from recorder/artifacts.ts `writeRunArtifactsCore`).

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CriterionResult } from "../types/shared.js";

export const VERDICT_ARTIFACT_VERSION = 1;

export const VERDICT_FILENAME = "verdict.json";

export interface VerdictArtifact {
  version: number;
  /** Provenance: the only writer is the /finalize response path. */
  source: "cloud-finalize";
  task_name: string;
  /** The scenario path as the run invocation saw it (may move later —
   *  readers must tolerate a dangling path). */
  scenario_path: string;
  /** Shared trial-group id (`grp_` + nanoid21); null on single runs. */
  group_id: string | null;
  session_id: string;
  cloud_run_id: string;
  cloud_dashboard_url: string;
  judge_model: string | null;
  /** Cloud-authoritative satisfaction score, 0-100. */
  score: number;
  pass_threshold: number;
  passed: boolean;
  criteria_results: CriterionResult[];
  duration_ms: number;
  finalized_at: string;
}

export interface TrialVerdict {
  runDir: string;
  verdict: VerdictArtifact;
}

export async function writeVerdictArtifact(
  runDir: string,
  verdict: VerdictArtifact,
): Promise<void> {
  await writeFile(
    join(runDir, VERDICT_FILENAME),
    `${JSON.stringify(verdict, null, 2)}\n`,
    "utf8",
  );
}

/** Read one trial's verdict.json. Returns null when absent or when the file
 *  isn't a recognizable verdict artifact (foreign/corrupt files are skipped,
 *  never thrown on — fix-prompt discovery must survive a messy runs/). */
/** Every field the fix-prompt pipeline dereferences must hold its declared
 *  shape, or the FILE is rejected — discovery treats a half-recognizable
 *  verdict.json as foreign rather than crashing downstream on it. */
function isVerdictArtifact(parsed: unknown): parsed is VerdictArtifact {
  if (typeof parsed !== "object" || parsed === null) return false;
  const v = parsed as Record<string, unknown>;
  if (v.source !== "cloud-finalize") return false;
  if (typeof v.session_id !== "string") return false;
  if (typeof v.task_name !== "string") return false;
  if (typeof v.scenario_path !== "string") return false;
  if (v.group_id !== null && typeof v.group_id !== "string") return false;
  if (typeof v.finalized_at !== "string") return false;
  if (typeof v.passed !== "boolean") return false;
  if (typeof v.score !== "number") return false;
  if (!Array.isArray(v.criteria_results)) return false;
  return v.criteria_results.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const result = r as Record<string, unknown>;
    const criterion = result.criterion as Record<string, unknown> | null;
    return (
      typeof criterion === "object" &&
      criterion !== null &&
      typeof criterion.text === "string" &&
      typeof result.reason === "string" &&
      typeof result.passed === "boolean" &&
      typeof result.skipped === "boolean"
    );
  });
}

export async function readVerdictArtifact(
  runDir: string,
): Promise<TrialVerdict | null> {
  const path = join(runDir, VERDICT_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isVerdictArtifact(parsed)) return null;
    return { runDir, verdict: parsed };
  } catch {
    return null;
  }
}

/** Scan an artifacts root for finalized trials — exactly the two-level
 *  layout `<root>/<task-slug>/<session-id>/verdict.json`. Anything
 *  unreadable is skipped. */
export async function scanVerdictArtifacts(
  artifactsRoot: string,
): Promise<TrialVerdict[]> {
  const found: TrialVerdict[] = [];
  let slugs: string[];
  try {
    slugs = await readdir(artifactsRoot);
  } catch {
    return found;
  }
  for (const slug of slugs) {
    const slugDir = join(artifactsRoot, slug);
    let runIds: string[];
    try {
      runIds = await readdir(slugDir);
    } catch {
      continue;
    }
    for (const runId of runIds) {
      const trial = await readVerdictArtifact(join(slugDir, runId));
      if (trial) found.push(trial);
    }
  }
  return found;
}

export interface RunSet {
  /** null = a single run that never had a group. */
  groupId: string | null;
  taskName: string;
  /** The scenario path recorded at run time (first trial's). */
  scenarioPath: string;
  /** Trials sorted by finalized_at ascending. */
  trials: TrialVerdict[];
  latestFinalizedAt: string;
  anyFailed: boolean;
}

/** Group trials into run sets: trials sharing a group_id form one set; a
 *  null group_id is its own single-run set. */
export function groupRunSets(trials: TrialVerdict[]): RunSet[] {
  const byKey = new Map<string, TrialVerdict[]>();
  for (const trial of trials) {
    const key = trial.verdict.group_id ?? `solo:${trial.verdict.session_id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(trial);
    else byKey.set(key, [trial]);
  }
  const sets: RunSet[] = [];
  for (const bucket of byKey.values()) {
    bucket.sort((a, b) =>
      a.verdict.finalized_at.localeCompare(b.verdict.finalized_at),
    );
    const last = bucket[bucket.length - 1]!;
    sets.push({
      groupId: bucket[0]!.verdict.group_id,
      taskName: bucket[0]!.verdict.task_name,
      scenarioPath: bucket[0]!.verdict.scenario_path,
      trials: bucket,
      latestFinalizedAt: last.verdict.finalized_at,
      anyFailed: bucket.some((t) => !t.verdict.passed),
    });
  }
  sets.sort((a, b) => a.latestFinalizedAt.localeCompare(b.latestFinalizedAt));
  return sets;
}

/** The newest run set with at least one failed (completed) trial. */
export function latestFailedRunSet(sets: RunSet[]): RunSet | null {
  for (let i = sets.length - 1; i >= 0; i -= 1) {
    if (sets[i]!.anyFailed) return sets[i]!;
  }
  return null;
}

export interface RunSetDiscovery {
  kind: "trial-dir" | "root";
  /** The set to build a fix prompt from (per `kind` semantics: a trial dir
   *  targets ITS set regardless of outcome; a root targets the latest
   *  FAILED set). Null when nothing matches. */
  set: RunSet | null;
  /** Total finalized run sets seen — lets the caller distinguish "no runs
   *  at all" from "runs exist but none failed". */
  totalSets: number;
}

/**
 * Resolve what `pome fix-prompt [target]` should read.
 * - `target` = a trial run dir (has verdict.json): that trial's whole set —
 *   the user pointed at it, outcome doesn't matter.
 * - `target` = an artifacts root: the latest failed set under it.
 */
export async function discoverRunSet(target: string): Promise<RunSetDiscovery> {
  const anchor = await readVerdictArtifact(target);
  if (anchor) {
    // Trial dir → its set. Layout is <root>/<slug>/<runId>, so the root is
    // two levels up; a moved/isolated dir degrades to a set of one.
    const root = join(target, "..", "..");
    const sets = groupRunSets(await scanVerdictArtifacts(root));
    const own =
      sets.find(
        (s) =>
          (anchor.verdict.group_id !== null &&
            s.groupId === anchor.verdict.group_id) ||
          (anchor.verdict.group_id === null &&
            s.trials.length === 1 &&
            s.trials[0]!.verdict.session_id === anchor.verdict.session_id),
      ) ?? groupRunSets([anchor])[0]!;
    return { kind: "trial-dir", set: own, totalSets: Math.max(sets.length, 1) };
  }

  if (!existsSync(target)) return { kind: "root", set: null, totalSets: 0 };
  const sets = groupRunSets(await scanVerdictArtifacts(target));
  return {
    kind: "root",
    set: latestFailedRunSet(sets),
    totalSets: sets.length,
  };
}

/** Load a trial's captured events.jsonl (raw trace) for prompt assembly.
 *  Missing/corrupt lines are skipped — the prompt degrades, never throws. */
export async function loadTrialEvents(runDir: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Valid JSON but not an event object (`null`, `3`, `"x"`) is corrupt
      // for our purposes — renderEvent dereferences fields on it.
      if (typeof parsed === "object" && parsed !== null) events.push(parsed);
    } catch {
      // skip corrupt row
    }
  }
  return events;
}
