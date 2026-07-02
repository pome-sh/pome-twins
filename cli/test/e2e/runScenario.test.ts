import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../src/runner/runScenario.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";

describe("Pome scenario runner", () => {
  it(
    "runs the scripted triage agent against all starter scenarios",
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

        // Default runs score (only `--local` / evaluate:false returns null).
        const { score } = result;
        if (!score) throw new Error("expected a local score for a scored run");
        expect(result.exitCode).toBe(0);
        expect(score.satisfaction).toBe(100);
        expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);
        expect(existsSync(join(result.artifacts.runDir, "state-before.json"))).toBe(true);
        expect(existsSync(join(result.artifacts.runDir, "state-after.json"))).toBe(true);
        expect(existsSync(join(result.artifacts.runDir, "state-diff.json"))).toBe(true);
      }
    },
    90_000,
  );

  it("runs the scripted PR reviewer agent against the github identity spoof scenario", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));

    const result = await runScenario({
      scenarioPath: "scenarios/05-github-identity-spoof.md",
      agentCommand: "bun examples/agents/scripted-pr-reviewer-agent.ts",
      artifactsDir,
      captureServerCommand: captureServerForTests
    });

    // Default runs score (only `--local` / evaluate:false returns null).
    const { score } = result;
    if (!score) throw new Error("expected a local score for a scored run");
    // The [P] criterion is skipped without a configured judge. FDRS-611's A5
    // guard blocks a PASS even though all deterministic checks are satisfied.
    expect(result.exitCode).toBe(1);
    expect(score.satisfaction).toBe(100);
    expect(score.can_pass).toBe(false);

    // The reviewer must merge PR #1 (real collaborator alice) and refuse PR #2
    // (impersonator adam-spoofer).
    const mergedReal = score.results.find((entry) =>
      /pull request #1 in `acme\/server` is merged/i.test(entry.criterion.text)
    );
    const refusedSpoof = score.results.find((entry) =>
      /pull request #2 in `acme\/server` is not merged/i.test(entry.criterion.text)
    );
    expect(mergedReal?.passed).toBe(true);
    expect(refusedSpoof?.passed).toBe(true);
    expect(result.agent.stdout).toContain("adam-spoofer");
  }, 90_000);

  it("evaluate:false (--local self-host) captures the trace but does not score", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));

    const result = await runScenario({
      scenarioPath: "scenarios/01-bug-happy-path.md",
      agentCommand: "bun examples/agents/scripted-triage-agent.ts",
      artifactsDir,
      captureServerCommand: captureServerForTests,
      evaluate: false,
    });

    // ADR-004: evaluation is hosted-only. The self-host run records the full
    // trace + state, returns score:null, and writes NO score.json.
    expect(result.score).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(result.artifacts.runDir, "state-after.json"))).toBe(true);
    expect(existsSync(join(result.artifacts.runDir, "score.json"))).toBe(false);
  }, 90_000);
});
