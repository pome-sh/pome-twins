// SPDX-License-Identifier: Apache-2.0
import type { Scenario } from "../scenario/scenarioSchema.js";
import type { Score } from "../evaluator/score.js";
import { scenarioPassed } from "../evaluator/score.js";
import { evaluateScenario } from "../evaluator/deterministic.js";
import { writeRunArtifacts, writeRunArtifactsCore } from "../recorder/artifacts.js";
import type { RecorderEvent } from "../twin/github/types.js";

export interface ScoreAndWriteInput {
  artifactsDir: string;
  runId: string;
  scenario: Scenario;
  startedAt: string;
  completedAt: string;
  agentStdout: string;
  agentStderr: string;
  agentExitCode: number | null;
  agentTimedOut: boolean;
  events: RecorderEvent[];
  stateInitial: unknown;
  stateFinal: unknown;
}

// Score the run + write the local artifacts directory. Used by both
// self-host (in-process twin) and hosted (twin pod) runners — the only
// difference upstream is how stateInitial/stateFinal/events are sourced.
export async function scoreAndWriteRun(input: ScoreAndWriteInput) {
  const score = await evaluateScenario({
    scenario: input.scenario,
    initialState: input.stateInitial,
    finalState: input.stateFinal,
    events: input.events,
    stdout: input.agentStdout,
  });

  const artifacts = await writeRunArtifacts({
    artifactsDir: input.artifactsDir,
    runId: input.runId,
    scenario: input.scenario,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    stdout: input.agentStdout,
    stderr: input.agentStderr,
    exitCode: input.agentExitCode,
    events: input.events,
    stateInitial: input.stateInitial,
    stateFinal: input.stateFinal,
    score,
  });

  // Map score + agent state → exit code: agent failure trumps a passing
  // score; otherwise pass/fail against the scenario's threshold. `scenarioPassed`
  // encodes the A5 guard (FDRS-611) — an "un-evaluated" run (all criteria
  // skipped/errored, or any required criterion not evaluated) is NEVER exit 0;
  // it lands on 1 ("did not pass") rather than being read as a hard fail at 0%.
  const exitCode =
    input.agentExitCode !== 0 || input.agentTimedOut
      ? 3
      : scenarioPassed(score, input.scenario.config.passThreshold)
        ? 0
        : 1;

  return { score, artifacts, exitCode };
}

// Self-host (`pome run --local`) variant: write the trace + state artifacts but
// DO NOT score. Evaluation (`[D]` deterministic + `[P]` LLM judge) is a hosted
// feature — see ADR-004. A self-hoster gets the full recorded trace to observe
// locally; the pass/fail verdict comes from Pome cloud. Returns `score: null`
// so callers branch on "trace captured, not evaluated" vs. a real verdict.
//
// Exit code here reflects only whether the agent ran cleanly (0) or
// failed/timed out (3) — there is no scenario verdict to gate on.
export async function writeRunNoScore(
  input: ScoreAndWriteInput,
): Promise<{ score: null; artifacts: Awaited<ReturnType<typeof writeRunArtifactsCore>>; exitCode: number }> {
  const artifacts = await writeRunArtifactsCore({
    artifactsDir: input.artifactsDir,
    runId: input.runId,
    scenario: input.scenario,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    stdout: input.agentStdout,
    stderr: input.agentStderr,
    exitCode: input.agentExitCode,
    events: input.events,
    stateInitial: input.stateInitial,
    stateFinal: input.stateFinal,
  });

  const exitCode = input.agentExitCode !== 0 || input.agentTimedOut ? 3 : 0;

  return { score: null, artifacts, exitCode };
}

// Re-exported for callers that want to discriminate a no-score run result.
export type { Score };
