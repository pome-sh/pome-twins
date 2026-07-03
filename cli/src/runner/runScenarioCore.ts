// SPDX-License-Identifier: Apache-2.0
import type { Scenario } from "../scenario/scenarioSchema.js";
import { writeRunArtifactsCore } from "../recorder/artifacts.js";
import type { RecorderEvent } from "../twin/github/types.js";

export interface WriteRunInput {
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

// Self-host (`pome run --local`) is CAPTURE-ONLY (FDRS-657): write the raw
// trace + state artifacts and DO NOT score, judge, or correlate. Local
// evaluation was removed entirely from the OSS CLI — a verdict comes only from
// the cloud (`pome eval <dir>`, or a hosted `pome run`). This produces an audit
// log; there is no score.json and no verdict on this path.
//
// Exit code reflects only whether the agent ran cleanly (0) or failed/timed
// out (3) — there is no scenario verdict to gate on.
export async function writeRunNoScore(
  input: WriteRunInput,
): Promise<{ artifacts: Awaited<ReturnType<typeof writeRunArtifactsCore>>; exitCode: number }> {
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

  return { artifacts, exitCode };
}
