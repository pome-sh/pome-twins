// SPDX-License-Identifier: Apache-2.0
// FDRS-644 — `pome fix-prompt` command surface:
//   - legacy 2-arg form (<events.jsonl> <scenario.md>) is unchanged;
//   - an events.jsonl target without a scenario is a usage error (exit 5);
//   - a second argument with a dir target is a usage error (exit 5);
//   - 0-arg reads ./runs and emits the latest FAILED run set's grouped
//     prompt; all-green roots print "nothing to fix" (exit 0); empty roots
//     are a usage error (exit 5);
//   - a trial run dir targets that set.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  VERDICT_ARTIFACT_VERSION,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../../src/hosted/evalResultCache.js";

const SCENARIO =
  "# scn\n\n## Prompt\nTriage the bug.\n\n## Success Criteria\n- [model] Severity is set correctly\n";

const EVENT =
  '{"twin":"github","method":"POST","path":"/repos/acme/api/issues/1/labels","status":200,"latency_ms":10,"request_body":{"labels":["bug"]},"response_body":null,"state_delta":null}\n';

function verdict(over: Partial<VerdictArtifact>): VerdictArtifact {
  return {
    version: VERDICT_ARTIFACT_VERSION,
    source: "cloud-finalize",
    task_name: "scn",
    scenario_path: "scenarios/scn.md",
    group_id: "grp_cmd",
    session_id: "ses_1",
    cloud_run_id: "run_1",
    cloud_dashboard_url: "https://app.pome.sh/runs/run_1",
    judge_model: "test-judge",
    score: 100,
    pass_threshold: 100,
    passed: true,
    criteria_results: [
      {
        criterion: { type: "model", text: "Severity is set correctly" },
        passed: true,
        skipped: false,
        reason: "ok",
      },
    ],
    duration_ms: 1000,
    finalized_at: "2026-07-06T00:00:00.000Z",
    ...over,
  };
}

async function writeTrial(
  root: string,
  sid: string,
  over: Partial<VerdictArtifact>,
): Promise<void> {
  const runDir = join(root, "runs", "scn", sid);
  await mkdir(runDir, { recursive: true });
  await writeVerdictArtifact(runDir, verdict({ session_id: sid, ...over }));
  await writeFile(join(runDir, "events.jsonl"), EVENT, "utf8");
}

describe("pome fix-prompt command (FDRS-644)", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      stdout.push(String(msg));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function run(...args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "pome", "fix-prompt", ...args]);
  }

  it("legacy 2-arg form is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-legacy-"));
    await writeFile(join(dir, "events.jsonl"), EVENT, "utf8");
    await writeFile(join(dir, "scn.md"), SCENARIO, "utf8");
    await run(join(dir, "events.jsonl"), join(dir, "scn.md"));

    expect(process.exitCode ?? 0).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("## Trace (HTTP calls the agent made)");
    expect(text).toContain("Severity is set correctly");
  });

  it("an events.jsonl target without a scenario is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-usage-"));
    await writeFile(join(dir, "events.jsonl"), EVENT, "utf8");
    await run(join(dir, "events.jsonl"));
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toContain("needs the task file");
  });

  it("a second argument with a dir target is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-usage2-"));
    await run(dir, "whatever.md");
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toContain("only applies to the events.jsonl form");
  });

  it("0-arg emits the latest FAILED run set as one grouped prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-group-"));
    await writeTrial(dir, "ses_1", {
      passed: true,
      finalized_at: "2026-07-06T00:01:00.000Z",
    });
    await writeTrial(dir, "ses_2", {
      passed: false,
      score: 50,
      finalized_at: "2026-07-06T00:02:00.000Z",
      criteria_results: [
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          passed: false,
          skipped: false,
          reason: "under-rated",
        },
      ],
    });
    await mkdir(join(dir, "scenarios"), { recursive: true });
    await writeFile(join(dir, "scenarios", "scn.md"), SCENARIO, "utf8");
    process.chdir(dir);

    await run();
    expect(process.exitCode ?? 0).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("## Grouped failure signatures (from the cloud judge)");
    expect(text).toContain("under-rated");
    expect(text).toContain("1 of 2 completed trials passed");
    expect(text).toContain("## Variance note");
  });

  it("all-green roots print nothing-to-fix (exit 0)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-green-"));
    await writeTrial(dir, "ses_1", { passed: true });
    process.chdir(dir);

    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("\n")).toBe("");
    expect(stderr.join("\n")).toContain("Nothing to fix");
  });

  it("an empty root is a usage error naming what to do", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-empty-"));
    process.chdir(dir);
    await run();
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toContain("No finalized run sets");
  });

  it("a trial run dir targets that trial's set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-trial-"));
    await writeTrial(dir, "ses_1", {
      passed: false,
      criteria_results: [
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          passed: false,
          skipped: false,
          reason: "under-rated",
        },
      ],
    });
    process.chdir(dir);

    await run(join(dir, "runs", "scn", "ses_1"));
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("\n")).toContain("## Grouped failure signatures");
  });
});
