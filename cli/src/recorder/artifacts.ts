// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../scenario/scenarioSchema.js";
import type { RecorderEvent } from "@pome-sh/shared-types";
import { redactEvent, redactSecrets } from "./redaction.js";
import { META_SPEC_VERSION, resolveTwinPackageVersions } from "./specMeta.js";

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

// FDRS-657 / F-689 — the OSS CLI is CAPTURE-ONLY: it writes raw trace + state
// artifacts and NEVER a score.json. Local artifacts are trace/audit only; a
// verdict comes only from the cloud and is printed ephemerally to the
// terminal (hosted `pome run`, `pome eval`) — never persisted next to the
// trace. There is no `writeScoreJson`/`readScore` anymore.
//
// F-689 remainder (D6) — a completed run dir contains EXACTLY these six
// files: `meta.json`, `events.jsonl`, `state_initial.json`,
// `state_final.json`, `stdout.txt`, `stderr.log`. The intermediate
// correlation artifacts this CLI used to also write (`tool_calls.jsonl`,
// `state-before.json`, `state-after.json`, `state-diff.json`) were deleted —
// they duplicated `events.jsonl`/`state_*.json` and existed only to feed the
// local correlator/evaluator, which no longer runs here. `stdout.txt` and
// `stderr.log` are NOT part of the trace contract cloud judges against; they
// are non-trace debug sidecars — raw agent-process output, kept only so a
// human (or `pome inspect`) can read what the agent printed when a run needs
// forensics.
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
    twins: input.scenario.config.twins,
    // D18.1 — the meta.json contract half: spec_version lets cloud's ingest
    // (a parallel PR) validate the shape it's parsing; twin_versions lets it
    // attribute the captured behavior to the exact twin build that produced
    // it. Both additive — an older CLI's meta.json simply omits them.
    spec_version: META_SPEC_VERSION,
    twin_versions: resolveTwinPackageVersions(input.scenario.config.twins),
  });
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
  await writeFile(join(runDir, "stdout.txt"), redactText(input.stdout));
  await writeFile(join(runDir, "stderr.log"), redactText(input.stderr));
  await writeJson(join(input.artifactsDir, "latest.json"), {
    run_id: input.runId,
    scenario: input.scenario.slug,
    run_dir: runDir
  });

  return { runId: input.runId, runDir };
}

export async function readLatestRun(artifactsDir: string) {
  const latestPath = join(artifactsDir, "latest.json");
  if (!existsSync(latestPath)) return undefined;
  return JSON.parse(await readFile(latestPath, "utf8")) as { run_id: string; scenario: string; run_dir: string };
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
