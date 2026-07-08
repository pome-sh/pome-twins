// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — `pome run <task> -n k`: real trial groups end-to-end.
// FDRS-663 — bounded/lazy minting + bounded trial parallelism.
//
// Flow per the 2026-07-05 [DECISION] set, revised by FDRS-663's 2026-07-06
// [DECISION] (option A — the free-tier `concurrentTwins: 3` mint gate was
// killing the k=5 default at the 4th upfront mint):
//   1. Mint sessions upfront (POST /v1/sessions), one shared
//      `grp_` + nanoid21 group_id on EVERY mint body and a FRESH
//      idempotency key per mint — the design's "provisioning k isolated
//      github twins … ready" moment. A QUOTA error mid-mint no longer
//      aborts: it discovers the plan's concurrent-twin bound, and the
//      group proceeds with the sessions it holds (k stays the design
//      default; the wall-clock stretches). Any other failed mint — or a
//      quota error before the FIRST mint succeeds — still rolls the
//      half-group back (best-effort DELETEs) and aborts before any agent
//      spawns.
//   2. Run the k trials with concurrency = the number of upfront mints
//      (= k when quota never pushed back). runScenarioHosted stays the
//      isolation unit: each trial gets its session via the
//      `premintedSession` seam, `abandonOnFailure` on, and still DELETEs
//      its own session in its `finally` — that delete frees the quota slot
//      the next lazy mint reuses. Trials beyond the bound mint lazily as
//      slots free (quota retries with a pause: deletes propagate async);
//      rows render in trial order regardless of completion order.
//   3. Errored trials (preflight failure / agent timeout / crash / a lazy
//      mint that never cleared quota) were abandoned inside the trial where
//      possible; here they render as errored rows EXCLUDED from the verdict
//      fraction — remaining trials continue.
//   4. Verdicts are NUMERIC cloud-judge scores (capture-only CLI, ADR-013);
//      the summary hands off to the task's reliability page.
//
// k=1 never reaches this module: the single-run path in cli/main.ts stays
// exactly as it was (no group stamped — a group of 1 would flip the
// reliability page off its implicit latest-k fallback).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHostedClient, type HostedClient } from "../hosted/client.js";
import { HostedQuotaError, HostedTrialError } from "../hosted/errors.js";
import { newGroupId } from "../demo/ids.js";
import { criterionPhrase } from "../demo/render.js";
import { parseScenarioFile } from "../scenario/parseScenario.js";
import { outcomeOf } from "../hosted/evalResultView.js";
import {
  normalizeConfigAgentId,
  normalizeConfigAgentSlug,
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

/** FDRS-663 — a lazy mint can quota-fail even though a trial just finished:
 *  the finished trial's DELETE propagates asynchronously. Pause and retry a
 *  bounded number of times before declaring that trial errored. */
export const LAZY_MINT_RETRY_MS = 2_000;
export const LAZY_MINT_MAX_ATTEMPTS = 5;

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
  /** FDRS-663 — lazy-mint retry pause; defaults to a real setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
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
  const agentSlug = configRead
    ? normalizeConfigAgentSlug(configRead.config)
    : undefined;

  out(flagHintLine(agentCommandSource));
  out("");

  const sleep =
    options.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const mintOne = () =>
    client.createSession({
      scenarioSource,
      twins: scenario.config.twins,
      agentId,
      seed: scenario.seedState,
      groupId,
      // Fresh idempotency key per mint — the mint bodies are otherwise
      // identical, and the cloud would collapse them onto one session.
      idempotencyKey: randomUUID(),
    });

  // 1. Mint upfront, quota-bounded (FDRS-663). The group exists before the
  // first agent spawns, and auth/orch failures surface HERE as one clean
  // error instead of half-way through a run. A quota push-back mid-mint is
  // NOT an error: it discovers the plan's concurrent-twin bound and the
  // group proceeds at that concurrency, reusing slots as trials finish.
  const sessions: CreateSessionResponse[] = [];
  try {
    for (let i = 0; i < options.trials; i += 1) {
      try {
        sessions.push(await mintOne());
      } catch (err) {
        if (err instanceof HostedQuotaError && sessions.length > 0) break;
        throw err;
      }
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
  const concurrency = sessions.length;
  out(
    provisioningLine(options.trials, scenario.config.twins, concurrency),
  );
  out(spawningAgentLine(options.agentCommand, agentCommandSource));
  out("");

  // A trial past the upfront bound mints its session lazily, once its worker
  // slot frees. The slot's previous trial deleted its session on the way out,
  // but that DELETE propagates asynchronously — quota errors here retry with
  // a pause before the trial is declared errored.
  const mintLazily = async (): Promise<CreateSessionResponse> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await mintOne();
      } catch (err) {
        if (err instanceof HostedQuotaError && attempt < LAZY_MINT_MAX_ATTEMPTS) {
          await sleep(LAZY_MINT_RETRY_MS);
          continue;
        }
        throw err;
      }
    }
  };

  // 2. Trials at bounded concurrency (FDRS-663 resolves FDRS-636's deferred
  // "bounded trial parallelism" thread: the bound IS the plan's quota).
  // Rows render in trial order — a finished trial's line waits for every
  // earlier trial's line.
  const rows: TrialRow[] = new Array<TrialRow>(options.trials);
  const failedCriteria: string[] = [];
  let printedRows = 0;
  const flushRows = () => {
    while (printedRows < options.trials && rows[printedRows] !== undefined) {
      out(trialRowLine(printedRows + 1, rows[printedRows]!));
      printedRows += 1;
    }
  };
  const runOneTrial = async (index: number): Promise<void> => {
    let row: TrialRow;
    try {
      const session = index < sessions.length ? sessions[index]! : await mintLazily();
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
      // the point where a verdict was possible — or its lazy mint never
      // cleared quota). Errored rows are excluded from the fraction; the
      // remaining trials continue.
      row = {
        kind: "errored",
        reason:
          err instanceof HostedTrialError
            ? err.message
            : shortReason(err instanceof Error ? err.message : String(err)),
      };
    }
    rows[index] = row;
    flushRows();
  };
  let nextTrial = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (nextTrial < options.trials) {
        const index = nextTrial;
        nextTrial += 1;
        await runOneTrial(index);
      }
    }),
  );

  // 3. Summary + the framed handoff to the task's reliability page.
  // FDRS-665 — the URL carries the agent by construction (Reliability IA v1
  // decision 1): a registered repo prints /agents/<slug>/tasks/<taskName>
  // with ?group for the run set (forward-compat — the page honors it in M1).
  // Legacy fallbacks, both served by FDRS-668's cloud-side redirects:
  // agentId without a slug → /runs/task/<name>?agent=<id> (server-side
  // id→slug redirect); unregistered repo → the bare task URL, which
  // auto-selects when exactly one agent has runs for that task. Task name =
  // the slug /finalize recorded as runs.task_name.
  const failing = mostCommonFailedCriterion(failedCriteria);
  const base = options.dashboardBaseUrl.replace(/\/$/, "");
  const taskPart = encodeURIComponent(scenario.slug);
  const reliabilityUrl = agentSlug
    ? `${base}/agents/${encodeURIComponent(agentSlug)}/tasks/${taskPart}?group=${encodeURIComponent(groupId)}`
    : `${base}/runs/task/${taskPart}${
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
