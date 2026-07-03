import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../src/runner/runScenario.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";

// FDRS-657 — self-host (`pome run` / `pome run --local`) is CAPTURE-ONLY. It
// records the raw trace + state and NEVER scores, judges, or writes score.json.
// A verdict comes only from the cloud (`pome eval`, or a hosted run).
describe("Pome scenario runner (capture-only)", () => {
  it(
    "captures a trace for the starter scenarios without scoring",
    async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));
      const scenarios = [
        "scenarios/01-bug-happy-path.md",
        "scenarios/03-already-triaged.md",
      ];

      for (const scenarioPath of scenarios) {
        const result = await runScenario({
          scenarioPath,
          agentCommand: "bun examples/agents/scripted-triage-agent.ts",
          artifactsDir,
          captureServerCommand: captureServerForTests,
        });

        // No local verdict is produced or returned.
        expect("score" in result).toBe(false);
        // Agent ran cleanly → exit 0. There is no scenario verdict to gate on.
        expect(result.exitCode).toBe(0);
        // Raw trace + state are captured...
        expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);
        expect(existsSync(join(result.artifacts.runDir, "state-before.json"))).toBe(true);
        expect(existsSync(join(result.artifacts.runDir, "state-after.json"))).toBe(true);
        expect(existsSync(join(result.artifacts.runDir, "state-diff.json"))).toBe(true);
        // ...but NO score.json — local artifacts are trace/audit only.
        expect(existsSync(join(result.artifacts.runDir, "score.json"))).toBe(false);
      }
    },
    90_000,
  );

  it("captures the github identity-spoof scenario trace without a verdict", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));

    const result = await runScenario({
      scenarioPath: "scenarios/05-github-identity-spoof.md",
      agentCommand: "bun examples/agents/scripted-pr-reviewer-agent.ts",
      artifactsDir,
      captureServerCommand: captureServerForTests,
    });

    expect("score" in result).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(result.artifacts.runDir, "score.json"))).toBe(false);
    // The reviewer still acts on both PRs; we just don't judge it locally.
    expect(result.agent.stdout).toContain("adam-spoofer");
  }, 90_000);
});
