// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../scenario/scenarioSchema.js";
import type { Score } from "../evaluator/score.js";
import type { RecorderEvent } from "../twin/github/types.js";
import { redactEvent, redactSecrets } from "./redaction.js";

// FDRS-399 / FDRS-398 — wrap a legacy RecorderEvent (or pass through any row
// that already carries a `kind` discriminator) into the unified events.jsonl
// shape. Reuses `request_id` as `event_id` so within-run lookups stay stable
// across the legacy and unified views.
//
// Exported so `runScenarioHosted` can apply the same wrap before uploading
// events.jsonl to cloud storage. Without it, cloud's FDRS-398 schema gate
// rejects the upload as "legacy single-shape RecorderEvent".
export function toTwinHttpEvent(event: RecorderEvent): RecorderEvent & { kind: "TwinHttpEvent"; event_id: string; parent_id: null } {
  const maybeKind = (event as { kind?: unknown }).kind;
  if (typeof maybeKind === "string") {
    return event as RecorderEvent & { kind: "TwinHttpEvent"; event_id: string; parent_id: null };
  }
  return {
    ...event,
    kind: "TwinHttpEvent",
    event_id: event.request_id,
    parent_id: null,
  };
}

export type RunArtifacts = {
  runId: string;
  runDir: string;
};

export type RunArtifactCoreInput = {
  artifactsDir: string;
  runId: string;
  scenario: Scenario;
  startedAt: string;
  completedAt: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  events: RecorderEvent[];
  stateInitial: unknown;
  stateFinal: unknown;
};

export type RunArtifactInput = RunArtifactCoreInput & {
  score: Score;
};

// Hosted runs need to write traces + state before they know the score (cloud
// judges authoritatively per ADR-013), then drop score.json once /finalize
// returns. Self-host scores locally and writes everything in one shot. Both
// converge through this core writer + `writeScoreJson` below.
export async function writeRunArtifactsCore(input: RunArtifactCoreInput): Promise<RunArtifacts> {
  const runDir = join(input.artifactsDir, input.scenario.slug, input.runId);
  await mkdir(runDir, { recursive: true });

  await writeJson(join(runDir, "meta.json"), {
    run_id: input.runId,
    scenario: input.scenario.slug,
    title: input.scenario.title,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    exit_code: input.exitCode,
    twins: input.scenario.config.twins
  });
  // tool_calls.jsonl keeps the legacy recorder shape (no `kind`) — it's the
  // pre-FDRS-398 view that some downstream consumers still read.
  const toolCallsJsonl = input.events.map((event) => JSON.stringify(redactEvent(event))).join("\n") + "\n";
  await writeFile(join(runDir, "tool_calls.jsonl"), toolCallsJsonl);
  // events.jsonl is the unified discriminated-union view (FDRS-398). The
  // in-process twin recorders still emit legacy RecorderEvent rows; wrap each
  // one into a TwinHttpEvent before serializing so `pome inspect` (FDRS-403)
  // and the dashboard ingest (FDRS-415) can parse them. APPEND (not
  // truncate) so rows already written by the capture-server child
  // (FDRS-399) during the run survive.
  const eventsJsonl =
    input.events.map((event) => JSON.stringify(redactEvent(toTwinHttpEvent(event)))).join("\n") + "\n";
  await appendFile(join(runDir, "events.jsonl"), eventsJsonl);
  await writeJson(join(runDir, "state_initial.json"), input.stateInitial);
  await writeJson(join(runDir, "state_final.json"), input.stateFinal);
  await writeJson(join(runDir, "state-before.json"), input.stateInitial);
  await writeJson(join(runDir, "state-after.json"), input.stateFinal);
  await writeJson(join(runDir, "state-diff.json"), summarizeStateDiff(input.stateInitial, input.stateFinal));
  await writeFile(join(runDir, "stdout.txt"), redactText(input.stdout));
  await writeFile(join(runDir, "stderr.log"), redactText(input.stderr));
  await writeJson(join(input.artifactsDir, "latest.json"), {
    run_id: input.runId,
    scenario: input.scenario.slug,
    run_dir: runDir
  });

  return { runId: input.runId, runDir };
}

export async function writeScoreJson(runDir: string, score: Score): Promise<void> {
  await writeJson(join(runDir, "score.json"), score);
}

export async function writeRunArtifacts(input: RunArtifactInput): Promise<RunArtifacts> {
  const out = await writeRunArtifactsCore(input);
  await writeScoreJson(out.runDir, input.score);
  return out;
}

export async function readLatestRun(artifactsDir: string) {
  const latestPath = join(artifactsDir, "latest.json");
  if (!existsSync(latestPath)) return undefined;
  return JSON.parse(await readFile(latestPath, "utf8")) as { run_id: string; scenario: string; run_dir: string };
}

export async function readScore(runDir: string) {
  return JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as Score;
}

// `inspect` runs against hosted-mode runs whose score.json may not yet be
// written (cloud /finalize hasn't returned) — in that case we still want to
// render trace health + events, so this returns `null` instead of throwing.
export async function readScoreOrNull(runDir: string): Promise<Score | null> {
  try {
    return await readScore(runDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export type RunMetaSummary = {
  run_id?: string;
  scenario?: string;
  title?: string;
  twins: string[];
};

export async function readMetaSummary(runDir: string): Promise<RunMetaSummary> {
  try {
    const raw = await readFile(join(runDir, "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<RunMetaSummary> & { twins?: unknown };
    const twins = Array.isArray(parsed.twins)
      ? parsed.twins.filter((t): t is string => typeof t === "string")
      : [];
    return { ...parsed, twins };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { twins: [] };
    throw err;
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}

function redactText(value: string): string {
  return redactSecrets(value) as string;
}

function summarizeStateDiff(before: unknown, after: unknown) {
  const beforeSummary = summarizeState(before);
  const afterSummary = summarizeState(after);
  const keys = Array.from(new Set([...Object.keys(beforeSummary), ...Object.keys(afterSummary)])).sort();
  return {
    summary: keys.map((key) => ({
      path: key,
      before: beforeSummary[key] ?? 0,
      after: afterSummary[key] ?? 0,
      delta: (afterSummary[key] ?? 0) - (beforeSummary[key] ?? 0)
    }))
  };
}

function summarizeState(value: unknown, prefix = ""): Record<string, number> {
  if (Array.isArray(value)) {
    return prefix ? { [prefix]: value.length } : {};
  }
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    Object.assign(out, summarizeState(child, path));
  }
  return out;
}
