// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — `pome run <task> -n k`: real trial groups end-to-end.
//
// Flow per the 2026-07-05 [DECISION] set:
//   1. Mint ALL k sessions upfront (POST /v1/sessions), one shared
//      `grp_` + nanoid21 group_id on EVERY mint body and a FRESH
//      idempotency key per mint — the design's "provisioning k isolated
//      github twins … ready" moment. A failed mint rolls the half-group
//      back (best-effort DELETEs) and aborts before any agent spawns.
//   2. Run the k trials SEQUENTIALLY (bounded parallelism deferred —
//      plan-quota semantics unresolved). runScenarioHosted stays the
//      isolation unit: each trial gets its pre-minted session via the
//      `premintedSession` seam, `abandonOnFailure` on, and still DELETEs
//      its own session in its `finally`.
//   3. Errored trials (preflight failure / agent timeout / crash) were
//      abandoned inside the trial (POST /:id/abandon with a machine
//      error_code); here they render as errored rows EXCLUDED from the
//      verdict fraction — remaining trials continue.
//   4. Verdicts are NUMERIC cloud-judge scores (capture-only CLI, ADR-013);
//      the summary hands off to the task's reliability page
//      ({dashboard}/runs/task/<taskName>).
//
// k=1 never reaches this module: the single-run path in cli/main.ts stays
// exactly as it was (no group stamped — a group of 1 would flip the
// reliability page off its implicit latest-k fallback).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHostedClient, type HostedClient } from "../hosted/client.js";
import { HostedTrialError } from "../hosted/errors.js";
import { newGroupId } from "../demo/ids.js";
import { criterionPhrase } from "../demo/render.js";
import { parseScenarioFile } from "../scenario/parseScenario.js";
import { outcomeOf } from "../score/view.js";
import {
  normalizeConfigAgentId,
  readProjectConfig,
} from "../cli/project-config.js";
import { runScenarioHosted } from "./runScenarioHosted.js";
import {
  fixHandoffLines,
  flagHintLine,
  groupExitCode,
  groupSummaryLines,
  mostCommonFailedCriterion,
  provisioningLine,
  shortReason,
  spawningAgentLine,
  trialRowLine,
  type TrialRow,
} from "./groupRender.js";
import type { CreateSessionResponse } from "../types/shared.js";

/** Explicit finalize timeout for -n runs ([DECISION]) — the hosted client
 *  defaults to 30s; the judge measured 5-8s, 60s is belt-and-braces (same
 *  constant `pome demo` locked for its trial finalizes). */
export const GROUP_FINALIZE_TIMEOUT_MS = 60_000;

export interface RunTrialGroupOptions {
  scenarioPath: string;
  agentCommand: string;
  /** Where the agent command came from, for the header copy
   *  ("pome.config.json" | "--agent" | "built-in default"). */
  agentCommandSource?: string;
  /** Effective k (2..20). k=1 must take the single-run path instead. */
  trials: number;
  artifactsDir?: string;
  hosted: { baseUrl: string; apiKey: string };
  /** Dashboard origin for the reliability link — same source as every other
   *  CLI dashboard link (POME_DASHBOARD_URL / DEFAULT_DASHBOARD_URL). */
  dashboardBaseUrl: string;
  /** Informational; forwarded to every trial's `runs.agent_model`. */
  agentModel?: string;
  /** FDRS-644 — the literal command the fix handoff tells the user to
   *  re-run after their coding agent applies a fix. The caller knows the
   *  invocation shape (bare `pome run` vs an explicit path + -n); default
   *  reconstructs it from scenarioPath + trials. */
  rerunCommand?: string;
  out?: (line: string) => void;
  // ── test seams ─────────────────────────────────────────────────────────
  client?: HostedClient;
  runScenarioHostedFn?: typeof runScenarioHosted;
  groupId?: string;
}

export interface RunTrialGroupResult {
  groupId: string;
  rows: TrialRow[];
  exitCode: number;
  reliabilityUrl: string;
}

export async function runTrialGroup(
  options: RunTrialGroupOptions,
): Promise<RunTrialGroupResult> {
  if (!Number.isInteger(options.trials) || options.trials < 2) {
    throw new Error(
      `runTrialGroup requires k>1 (got ${options.trials}); k=1 takes the single-run path so no group is stamped.`,
    );
  }
  const out = options.out ?? ((line: string) => console.error(line));
  const runFn = options.runScenarioHostedFn ?? runScenarioHosted;
  const client =
    options.client ??
    createHostedClient({
      baseUrl: options.hosted.baseUrl,
      apiKey: options.hosted.apiKey,
      timeoutMs: GROUP_FINALIZE_TIMEOUT_MS,
    });
  const groupId = options.groupId ?? newGroupId();
  const agentCommandSource = options.agentCommandSource ?? "pome.config.json";

  const scenario = await parseScenarioFile(options.scenarioPath);
  const scenarioSource = await readFile(options.scenarioPath, "utf8");
  // Same agent resolution as the single-run path (ADR-013): the group's
  // trials are recorded under the agent pinned in pome.config.json.
  const configRead = await readProjectConfig(dirname(options.scenarioPath));
  const agentId = configRead
    ? normalizeConfigAgentId(configRead.config)
    : undefined;

  out(flagHintLine(agentCommandSource));
  out("");

  // 1. Mint all k sessions upfront. The group exists before the first agent
  // spawns, and quota/auth failures surface HERE as one clean error instead
  // of half-way through a run. Fresh idempotency key per mint — the k mint
  // bodies are otherwise identical, and the cloud would collapse them onto
  // one session.
  const sessions: CreateSessionResponse[] = [];
  try {
    for (let i = 0; i < options.trials; i += 1) {
      sessions.push(
        await client.createSession({
          scenarioSource,
          twins: scenario.config.twins,
          agentId,
          seed: scenario.seedState,
          groupId,
          idempotencyKey: randomUUID(),
        }),
      );
    }
  } catch (err) {
    // Roll the half-group back so abandoned mints never linger as open
    // sessions polluting the reliability view; then let the caller map the
    // error to the documented exit code.
    await Promise.all(
      sessions.map((s) => client.deleteSession(s.session_id).catch(() => undefined)),
    );
    throw err;
  }
  out(provisioningLine(options.trials, scenario.config.twins));
  out(spawningAgentLine(options.agentCommand, agentCommandSource));
  out("");

  // 2. Sequential trials over the pre-minted sessions ([DECISION]: bounded
  // parallelism deferred until plan-quota semantics are resolved).
  const rows: TrialRow[] = [];
  const failedCriteria: string[] = [];
  for (let i = 0; i < options.trials; i += 1) {
    const session = sessions[i]!;
    let row: TrialRow;
    try {
      const result = await runFn({
        scenarioPath: options.scenarioPath,
        agentCommand: options.agentCommand,
        artifactsDir: options.artifactsDir,
        hosted: options.hosted,
        client,
        agentModel: options.agentModel,
        premintedSession: session,
        abandonOnFailure: true,
        // FDRS-644 — stamped into the trial's verdict.json so fix-prompt
        // can reassemble this run set from local artifacts.
        groupId,
      });
      const failing = result.score.results.filter(
        (r) => outcomeOf(r) === "failed",
      );
      for (const r of failing) failedCriteria.push(r.criterion.text);
      row = {
        kind: "completed",
        score: result.score.satisfaction,
        passed: result.exitCode === 0,
        seconds: result.durationMs / 1000,
        note:
          failing.length > 0
            ? failing.map((r) => criterionPhrase(r.criterion.text)).join(" · ")
            : undefined,
      };
    } catch (err) {
      // The trial abandoned its session before throwing (or crashed past
      // the point where a verdict was possible). Errored rows are excluded
      // from the fraction; the remaining trials continue.
      row = {
        kind: "errored",
        reason:
          err instanceof HostedTrialError
            ? err.message
            : shortReason(err instanceof Error ? err.message : String(err)),
      };
    }
    rows.push(row);
    out(trialRowLine(i + 1, row));
  }

  // 3. Summary + the framed handoff to the task's reliability page. Route
  // shape from the dashboard app (/runs/task/[taskName], ?agent read
  // client-side); task name = the slug /finalize recorded as
  // runs.task_name.
  const failing = mostCommonFailedCriterion(failedCriteria);
  const base = options.dashboardBaseUrl.replace(/\/$/, "");
  const reliabilityUrl = `${base}/runs/task/${encodeURIComponent(scenario.slug)}${
    agentId ? `?agent=${encodeURIComponent(agentId)}` : ""
  }`;
  for (const line of groupSummaryLines({
    rows,
    failingCriterionPhrase: failing?.phrase,
    failingCriterionCount: failing?.count,
    reliabilityUrl,
  })) {
    out(line);
  }

  // 4. FDRS-644 — the fix & green handoff, only when a COMPLETED trial
  // failed. Errored trials are sandbox noise: the answer there is re-run,
  // not a code fix, so an errored-only group gets no handoff.
  const failedCompleted = rows.filter(
    (r) => r.kind === "completed" && !r.passed,
  ).length;
  if (failedCompleted > 0) {
    const artifactsDir = options.artifactsDir ?? "runs";
    const fixPromptCommand =
      artifactsDir === "runs"
        ? "pome fix-prompt"
        : `pome fix-prompt ${artifactsDir}`;
    const rerunCommand =
      options.rerunCommand ??
      `pome run ${options.scenarioPath} -n ${options.trials}`;
    for (const line of fixHandoffLines({ fixPromptCommand, rerunCommand })) {
      out(line);
    }
  }

  return { groupId, rows, exitCode: groupExitCode(rows), reliabilityUrl };
}
