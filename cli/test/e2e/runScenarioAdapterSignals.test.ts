// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../src/runner/runScenario.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";

// FDRS-411 e2e: a fake CAS-style adapter agent writes M0 HookEvent rows to
// POME_ADAPTER_SIGNALS_PATH. The runner must (a) inject that env var
// pointing at <runDir>/signals.jsonl, (b) leave signals.jsonl populated
// post-run, and (c) merge those rows into events.jsonl so the merged file
// is the canonical view for downstream consumers.
describe("runScenario + POME_ADAPTER_SIGNALS_PATH", () => {
  it(
    "injects POME_ADAPTER_SIGNALS_PATH and merges signals.jsonl into events.jsonl",
    async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));
      const result = await runScenario({
        scenarioPath: "scenarios/01-bug-happy-path.md",
        captureServerCommand: captureServerForTests,
        agentCommand: "bun test/fixtures/adapter-signals-agent.ts",
        artifactsDir,
      });

      const signalsPath = join(result.artifacts.runDir, "signals.jsonl");
      const eventsPath = join(result.artifacts.runDir, "events.jsonl");

      expect(existsSync(signalsPath)).toBe(true);
      expect(existsSync(eventsPath)).toBe(true);

      // signals.jsonl carries the two HookEvent rows the fake adapter wrote.
      const signalsRows = (await readFile(signalsPath, "utf8"))
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
      expect(signalsRows).toHaveLength(2);
      expect(signalsRows.map((r) => r.hook_name)).toEqual(["SessionStarted", "PostToolUse"]);
      for (const r of signalsRows) {
        expect(r.kind).toBe("HookEvent");
      }

      // events.jsonl now contains those HookEvent rows in addition to the
      // recorder-sourced TwinHttp rows. The merged view is what `pome
      // inspect` and the dashboard read.
      const eventsRows = (await readFile(eventsPath, "utf8"))
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
      const hookRows = eventsRows.filter((r) => r.kind === "HookEvent");
      expect(hookRows).toHaveLength(2);
      expect(hookRows.map((r) => r.hook_name).sort()).toEqual(["PostToolUse", "SessionStarted"]);

      // Sanity: at least one recorder-sourced row also landed in events.jsonl.
      expect(eventsRows.length).toBeGreaterThan(2);
    },
    90_000,
  );

  it(
    "tolerates an agent that never touches POME_ADAPTER_SIGNALS_PATH (empty signals.jsonl)",
    async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));
      const result = await runScenario({
        scenarioPath: "scenarios/01-bug-happy-path.md",
        captureServerCommand: captureServerForTests,
        agentCommand: "bun examples/agents/scripted-triage-agent.ts",
        artifactsDir,
      });

      const signalsPath = join(result.artifacts.runDir, "signals.jsonl");
      const eventsPath = join(result.artifacts.runDir, "events.jsonl");
      expect(existsSync(signalsPath)).toBe(true);
      expect(await readFile(signalsPath, "utf8")).toBe("");
      // events.jsonl unchanged shape — no HookEvent rows appended.
      const hookRows = (await readFile(eventsPath, "utf8"))
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
        .filter((r) => r.kind === "HookEvent");
      expect(hookRows).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    },
    90_000,
  );
});
