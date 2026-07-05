// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — `pome demo` orchestration: group threading, per-trial verdicts
// from the cloud evaluation, errored exclusion, at-capacity abort.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDemo, type DemoTrialClient } from "../../../src/demo/runDemo.js";
import { DemoCapacityError } from "../../../src/demo/capacity.js";
import { HostedQuotaError } from "../../../src/hosted/errors.js";
import type { DemoSession } from "../../../src/demo/mint.js";
import type { runScenario } from "../../../src/runner/runScenario.js";
import type { FinalizeResponse } from "../../../src/types/shared.js";

type RunScenarioFn = typeof runScenario;
type RunScenarioResult = Awaited<ReturnType<RunScenarioFn>>;
type RunScenarioOpts = Parameters<RunScenarioFn>[0];

function sessionsFixture(count: number): DemoSession[] {
  return Array.from({ length: count }, (_, i) => ({
    session_id: `ses_${i + 1}`,
    demo_token: `jwt.tok${i + 1}.sig`,
    expires_at: "2026-07-05T12:15:00.000Z",
  }));
}

async function artifactsDirWithBlobs(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-demo-run-"));
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ kind: "TwinHttpEvent", event_id: "e1" })}\n`,
  );
  await writeFile(join(dir, "state_initial.json"), "{}\n");
  await writeFile(join(dir, "state_final.json"), "{}\n");
  return dir;
}

function fakeRunScenario(
  perTrial: Array<{ exitCode: number; stderr?: string; timedOut?: boolean }>,
  seenOptions: RunScenarioOpts[],
): RunScenarioFn {
  let call = 0;
  return (async (options: RunScenarioOpts) => {
    seenOptions.push(options);
    const spec = perTrial[Math.min(call, perTrial.length - 1)]!;
    call += 1;
    const runDir = await artifactsDirWithBlobs();
    return {
      scenario: { slug: "first-run-demo" },
      runId: `run_${call}`,
      artifacts: { runId: `run_${call}`, runDir },
      agent: {
        stdout: "",
        stderr: spec.stderr ?? "",
        exitCode: spec.exitCode === 0 ? 0 : 1,
        timedOut: spec.timedOut ?? false,
      },
      exitCode: spec.exitCode,
      blockedEgress: [],
    } as unknown as RunScenarioResult;
  }) as RunScenarioFn;
}

function passedResult(): FinalizeResponse["criteria_results"] {
  return [
    criterion("The bug label was applied to the 500-error issue.", "passed"),
    criterion(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders).",
      "passed",
    ),
  ];
}

function failedResult(): FinalizeResponse["criteria_results"] {
  return [
    criterion("The bug label was applied to the 500-error issue.", "passed"),
    criterion(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders).",
      "failed",
    ),
  ];
}

function criterion(text: string, outcome: "passed" | "failed") {
  return {
    criterion: { type: "P" as const, text },
    outcome,
    passed: outcome === "passed",
    skipped: false,
    reason: outcome === "passed" ? "ok" : "not satisfied",
  };
}

function fakeClient(
  finalizeFor: (sessionId: string) => FinalizeResponse | Error,
  finalizeCalls: Array<{ sessionId: string; input: unknown }>,
): (session: DemoSession) => DemoTrialClient {
  return (session) => ({
    requestEventsUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    requestStateUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    requestSignalsUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    finalize: vi.fn(async (sessionId: string, input: unknown) => {
      finalizeCalls.push({ sessionId, input });
      const out = finalizeFor(session.session_id);
      if (out instanceof Error) throw out;
      return out;
    }),
  });
}

function finalizeResponse(
  score: number,
  results: FinalizeResponse["criteria_results"],
): FinalizeResponse {
  return {
    run_id: "run_x",
    score,
    judge_model: "google/gemini-3.1-flash-lite",
    dashboard_url: "https://app.pome.sh/runs/run_x",
    criteria_results: results,
  };
}

describe("runDemo (FDRS-643)", () => {
  it("threads one grp_ id through every mint, runs k trials, renders verdict words + preview link", async () => {
    const out: string[] = [];
    const seenOptions: RunScenarioOpts[] = [];
    const finalizeCalls: Array<{ sessionId: string; input: unknown }> = [];
    const mintFn = vi.fn(async (opts: { groupId: string; count: number }) =>
      sessionsFixture(opts.count),
    );

    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runScenarioFn: fakeRunScenario(
        [
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 3, timedOut: true },
        ],
        seenOptions,
      ),
      mintFn: mintFn as never,
      trialClientFactory: fakeClient((sessionId) => {
        if (sessionId === "ses_1" || sessionId === "ses_2") {
          return finalizeResponse(100, passedResult());
        }
        return finalizeResponse(50, failedResult());
      }, finalizeCalls),
      skipTwinWarmup: true,
    });

    // Group threading: one grp_ id, shared by all 5 mints (single call, count 5).
    expect(mintFn).toHaveBeenCalledOnce();
    const mintArgs = mintFn.mock.calls[0]![0] as {
      groupId: string;
      count: number;
      taskName: string;
      apiBase: string;
    };
    expect(mintArgs.groupId).toMatch(/^grp_[\w-]{21}$/);
    expect(mintArgs.count).toBe(5);
    expect(mintArgs.taskName).toBe("first-run-demo");
    expect(result.groupId).toBe(mintArgs.groupId);

    // Each trial got ITS session's gateway coordinates + the egress valve.
    expect(seenOptions).toHaveLength(5);
    seenOptions.forEach((options, i) => {
      expect(options.scenarioPath.endsWith("first-run-demo.md")).toBe(true);
      expect(options.extraAgentEnv).toMatchObject({
        POME_DEMO_LLM_URL: `https://api.example.com/v1/demo/sessions/ses_${i + 1}/llm`,
        POME_DEMO_TOKEN: `jwt.tok${i + 1}.sig`,
        POME_DEMO_TASK_NAME: "first-run-demo",
        POME_DEMO_REPO: "acme/api",
      });
      expect(options.egressExtraHosts).toEqual(["api.example.com"]);
    });

    // Finalize went to the 4 evaluated sessions with the demo contract:
    // criteria [] + scenario_name selects the server-owned task.
    expect(finalizeCalls.map((c) => c.sessionId)).toEqual([
      "ses_1",
      "ses_2",
      "ses_3",
      "ses_4",
    ]);
    for (const call of finalizeCalls) {
      expect(call.input).toMatchObject({
        criteria: [],
        scenarioName: "first-run-demo",
        stopReason: "completed",
      });
    }

    const text = out.join("\n");
    expect(text).toContain("No signup. No API keys.");
    expect(text).toContain("running 5 isolated trials of first-run-demo …");
    expect(text).toMatch(/trial 1 {2}✓ {2}passed {3}\d+\.\ds/);
    expect(text).toMatch(/trial 3 {2}✗ {2}failed {3}\d+\.\ds {2}exactly one comment/);
    expect(text).toContain("trial 5  ⚠  errored         trial timed out — excluded");
    expect(text).toContain(
      "2 of 4 passed · 1 trial errored on trial timed out, excluded from the fraction",
    );
    expect(text).toMatch(/exactly one comment .* in 2 of 4 — start there/);
    expect(text).toContain(`→ https://app.pome.sh/demo/${result.groupId}`);
    // Verdicts are words, never scores.
    expect(text).not.toMatch(/\d+\/100/);
    expect(result.exitCode).toBe(0);
  });

  it("renders an honest labeled state and exits 4 when the mint is at capacity", async () => {
    const out: string[] = [];
    const runScenarioFn = vi.fn();
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runScenarioFn: runScenarioFn as never,
      mintFn: (async () => {
        throw new DemoCapacityError(
          "demo_ip_mint_cap",
          "Daily demo limit reached for this network.",
        );
      }) as never,
      trialClientFactory: fakeClient(() => new Error("unreachable"), []),
      skipTwinWarmup: true,
    });

    expect(result.exitCode).toBe(4);
    expect(runScenarioFn).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("limit for this network — try again tomorrow");
    expect(text).not.toMatch(/at Object|\.ts:\d+/); // no stack traces
  });

  it("stops launching trials when finalize hits the daily judge cap, keeping earlier verdicts", async () => {
    const out: string[] = [];
    const seenOptions: RunScenarioOpts[] = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runScenarioFn: fakeRunScenario([{ exitCode: 0 }], seenOptions),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient((sessionId) => {
        if (sessionId === "ses_1") return finalizeResponse(100, passedResult());
        return new HostedQuotaError(
          "Daily managed-judge spend cap reached for this team.",
          "req_1",
          { kind: "daily_judge_cap", spent_cents: 500, cap_cents: 500 },
        );
      }, []),
      skipTwinWarmup: true,
    });

    // Trial 1 passed, trial 2 hit the cap → no trial 3-5.
    expect(seenOptions).toHaveLength(2);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts[0]).toMatchObject({ kind: "passed" });
    expect(result.verdicts[1]).toMatchObject({ kind: "errored" });
    const text = out.join("\n");
    expect(text).toContain("evaluation budget is exhausted — try again tomorrow");
    expect(text).toContain("1 of 1 passed");
    expect(result.exitCode).toBe(0);
  });

  it("treats an agent capacity marker (gateway 402 mid-trial) as a demo-wide honest stop", async () => {
    const out: string[] = [];
    const seenOptions: RunScenarioOpts[] = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runScenarioFn: fakeRunScenario(
        [
          {
            exitCode: 3,
            stderr: "POME_DEMO_CAPACITY:daily_model_cap\nbudget exhausted\n",
          },
        ],
        seenOptions,
      ),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(() => new Error("unreachable"), []),
      skipTwinWarmup: true,
    });

    expect(seenOptions).toHaveLength(1);
    expect(result.exitCode).toBe(4);
    const text = out.join("\n");
    expect(text).toContain("daily model budget is exhausted — try again tomorrow");
  });

  it("boots the packaged demo task's twin for the warm-up line (real seed parse)", async () => {
    const out: string[] = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 1,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runScenarioFn: fakeRunScenario([{ exitCode: 0 }], []),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(() => finalizeResponse(100, passedResult()), []),
      // REAL warm-up: parses src/demo/first-run-demo.md + its hand-written
      // sidecar and boots the github twin against that seed.
      skipTwinWarmup: false,
    });
    expect(result.exitCode).toBe(0);
    expect(out.join("\n")).toMatch(/spinning up github twin … ready \(\d+\.\ds\)/);
  });
});
