// SPDX-License-Identifier: Apache-2.0
// FDRS-399 — `writeRunArtifactsCore` must append to events.jsonl so rows
// written by the capture-server child during a run are preserved alongside
// the recorder's twin-traffic rows. Pre-FDRS-399 the function truncated.

import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRunArtifactsCore } from "../../../src/recorder/artifacts.js";
import type { Scenario } from "../../../src/scenario/scenarioSchema.js";

function fakeScenario(): Scenario {
  return {
    slug: "fdrs-399-artifacts-test",
    title: "FDRS-399 artifacts test",
    prompt: "noop",
    seedState: { repositories: [] },
    config: {
      twins: ["github"],
      timeout: 5,
      passThreshold: 100,
    },
    successCriteria: [],
  } as unknown as Scenario;
}

describe("writeRunArtifactsCore — events.jsonl", () => {
  it("preserves rows already written to events.jsonl (append, not truncate)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pome-art-"));
    const scenario = fakeScenario();
    const runId = "run_test";
    const runDir = join(root, scenario.slug, runId);
    await mkdir(runDir, { recursive: true });

    // Simulate the capture-server having already appended an LlmCallEvent
    // row to events.jsonl before the runner reaches writeRunArtifactsCore.
    const preExisting = {
      ts: "2026-05-26T12:00:00.000Z",
      event_id: "evt_capture_1",
      parent_id: null,
      kind: "LlmCallEvent",
      host: "api.anthropic.com",
      port: 443,
      latency_ms: 42,
      bytes_in: 100,
      bytes_out: 200,
      url: null,
      method: null,
      status: null,
      model: null,
      prompt_tokens: null,
      completion_tokens: null,
      cost_usd: null,
    };
    await writeFile(join(runDir, "events.jsonl"), JSON.stringify(preExisting) + "\n");

    const recorderEvent = {
      ts: "2026-05-26T12:00:01.000Z",
      event_id: "evt_twin_1",
      parent_id: null,
      kind: "TwinHttpEvent",
      method: "GET",
      url: "/repos/acme/api/issues/1",
      status: 200,
    };

    await writeRunArtifactsCore({
      artifactsDir: root,
      runId,
      scenario,
      startedAt: "2026-05-26T11:59:59.000Z",
      completedAt: "2026-05-26T12:00:02.000Z",
      stdout: "",
      stderr: "",
      exitCode: 0,
      events: [recorderEvent as never],
      stateInitial: {},
      stateFinal: {},
    });

    const lines = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const kinds = lines.map((r: { kind: string }) => r.kind).sort();
    expect(kinds).toEqual(["LlmCallEvent", "TwinHttpEvent"]);
    const captureRow = lines.find((r: { event_id: string }) => r.event_id === "evt_capture_1");
    const twinRow = lines.find((r: { event_id: string }) => r.event_id === "evt_twin_1");
    expect(captureRow).toBeDefined();
    expect(twinRow).toBeDefined();
  });

  it("does not duplicate TwinHttpEvent rows already streamed by the durable recorder (F-698)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pome-art-"));
    const scenario = fakeScenario();
    const runId = "run_durable_dedupe";
    const runDir = join(root, scenario.slug, runId);
    await mkdir(runDir, { recursive: true });

    const streamed = {
      ts: "2026-05-26T12:00:01.000Z",
      run_id: runId,
      twin: "github",
      request_id: "req_streamed_1",
      step_id: null,
      tool_call_id: null,
      method: "GET",
      path: "/repos/acme/api/issues/1",
      request_body: null,
      status: 200,
      response_body: { id: 1 },
      latency_ms: 1,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: null,
      kind: "TwinHttpEvent",
      event_id: "req_streamed_1",
      parent_id: null,
    };
    await writeFile(join(runDir, "events.jsonl"), JSON.stringify(streamed) + "\n");

    await writeRunArtifactsCore({
      artifactsDir: root,
      runId,
      scenario,
      startedAt: "2026-05-26T11:59:59.000Z",
      completedAt: "2026-05-26T12:00:02.000Z",
      stdout: "",
      stderr: "",
      exitCode: 0,
      // Same event still present in the in-memory mirror at finalize.
      events: [
        {
          ts: streamed.ts,
          run_id: streamed.run_id,
          twin: streamed.twin,
          request_id: streamed.request_id,
          step_id: null,
          tool_call_id: null,
          method: streamed.method,
          path: streamed.path,
          request_body: null,
          status: 200,
          response_body: { id: 1 },
          latency_ms: 1,
          fidelity: "semantic",
          state_mutation: false,
          state_delta: null,
          error: null,
        } as never,
      ],
      stateInitial: {},
      stateFinal: {},
    });

    const lines = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event_id).toBe("req_streamed_1");
  });
});

// F-689 remainder (D6) — the run dir contains EXACTLY six files; the
// intermediate correlation artifacts (tool_calls.jsonl, state-before.json,
// state-after.json, state-diff.json) are gone for good.
describe("writeRunArtifactsCore — file-set contract (F-689 / D6)", () => {
  it("writes exactly meta.json, events.jsonl, state_initial.json, state_final.json, stdout.txt, stderr.log", async () => {
    const root = await mkdtemp(join(tmpdir(), "pome-art-"));
    const scenario = fakeScenario();
    const runId = "run_test_fileset";
    const runDir = join(root, scenario.slug, runId);

    await writeRunArtifactsCore({
      artifactsDir: root,
      runId,
      scenario,
      startedAt: "2026-05-26T11:59:59.000Z",
      completedAt: "2026-05-26T12:00:02.000Z",
      stdout: "hi",
      stderr: "bye",
      exitCode: 0,
      events: [],
      stateInitial: {},
      stateFinal: {},
    });

    const entries = (await readdir(runDir)).sort();
    expect(entries).toEqual(
      [
        "events.jsonl",
        "meta.json",
        "state_final.json",
        "state_initial.json",
        "stderr.log",
        "stdout.txt",
      ].sort(),
    );
  });

  it("meta.json carries spec_version and twin_versions for the run's twins (D18.1)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pome-art-"));
    const scenario = fakeScenario();
    const runId = "run_test_meta";
    const runDir = join(root, scenario.slug, runId);

    await writeRunArtifactsCore({
      artifactsDir: root,
      runId,
      scenario,
      startedAt: "2026-05-26T11:59:59.000Z",
      completedAt: "2026-05-26T12:00:02.000Z",
      stdout: "",
      stderr: "",
      exitCode: 0,
      events: [],
      stateInitial: {},
      stateFinal: {},
    });

    const meta = JSON.parse(await readFile(join(runDir, "meta.json"), "utf8")) as {
      spec_version: number;
      twin_versions: Record<string, string>;
    };
    expect(meta.spec_version).toBe(1);
    // fakeScenario() declares twins: ["github"] — only that twin's pinned
    // package version should be present.
    expect(Object.keys(meta.twin_versions)).toEqual(["github"]);
    expect(meta.twin_versions.github).toMatch(/^\d+\.\d+\.\d+/);
  });
});
