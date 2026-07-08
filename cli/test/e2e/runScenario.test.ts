import { mkdtemp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../src/runner/runScenario.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";

// F-689 remainder (D6/R1) — `writeRunArtifactsCore` writes EXACTLY six files
// (asserted directly at the unit level in
// test/unit/recorder/artifacts.test.ts). The full self-host `runScenario()`
// surface tested here also writes its own pre-existing, unrelated sidecars
// (signals.jsonl for adapter signals, egress.jsonl for refused CONNECTs) —
// so this e2e checks the REQUIRED six are present and the four deleted
// correlation artifacts never come back, without over-claiming an exact set.
const REQUIRED_RUN_DIR_FILES = [
  "events.jsonl",
  "meta.json",
  "state_final.json",
  "state_initial.json",
  "stderr.log",
  "stdout.txt",
];
const DELETED_RUN_DIR_FILES = [
  "tool_calls.jsonl",
  "state-before.json",
  "state-after.json",
  "state-diff.json",
];

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
          agentCommand: "npx tsx examples/agents/scripted-triage-agent.ts",
          artifactsDir,
          captureServerCommand: captureServerForTests,
        });

        // No local verdict is produced or returned.
        expect("score" in result).toBe(false);
        // Agent ran cleanly → exit 0. There is no scenario verdict to gate on.
        expect(result.exitCode).toBe(0);
        // Raw trace + state are captured...
        const entries = new Set(await readdir(result.artifacts.runDir));
        for (const required of REQUIRED_RUN_DIR_FILES) {
          expect(entries.has(required)).toBe(true);
        }
        // ...and the correlation artifacts F-689 deleted never come back.
        for (const deleted of DELETED_RUN_DIR_FILES) {
          expect(entries.has(deleted)).toBe(false);
        }
        expect(entries.has("score.json")).toBe(false);
      }
    },
    90_000,
  );

  it("captures the github identity-spoof scenario trace without a verdict", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));

    const result = await runScenario({
      scenarioPath: "scenarios/05-github-identity-spoof.md",
      agentCommand: "npx tsx examples/agents/scripted-pr-reviewer-agent.ts",
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
