// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — `pome run -n k` group orchestration, unit level.
//
// Locked decisions under test:
//   - all k sessions minted UPFRONT with ONE shared `grp_` + nanoid21 id
//     stamped on every mint body, and a FRESH idempotency key per mint;
//   - trials run SEQUENTIALLY against the pre-minted sessions
//     (runScenarioHosted stays the isolation unit, abandonOnFailure on);
//   - an errored trial renders as an errored row and the remaining trials
//     continue; errored rows are excluded from the verdict fraction;
//   - group exit code: 0 iff ≥1 trial completed AND every completed trial
//     passed; 1 when a completed trial failed; 2 when nothing completed;
//   - the default hosted client carries the explicit 60s finalize timeout.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedClient, type HostedClient } from "../../../src/hosted/client.js";
import { HostedOrchError, HostedTrialError } from "../../../src/hosted/errors.js";
import {
  GROUP_FINALIZE_TIMEOUT_MS,
  runTrialGroup,
} from "../../../src/runner/runTrialGroup.js";
import type {
  RunScenarioHostedOptions,
  RunScenarioHostedResult,
} from "../../../src/runner/runScenarioHosted.js";
import type { Score } from "../../../src/score/view.js";

vi.mock("../../../src/hosted/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/hosted/client.js")>();
  return { ...original, createHostedClient: vi.fn(original.createHostedClient) };
});

const SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n";

async function scenarioFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-group-"));
  const path = join(dir, "scn.md");
  await writeFile(path, SCENARIO, "utf8");
  return path;
}

interface FakeCloud {
  client: HostedClient;
  events: string[];
  mints: Array<{ groupId?: string; idempotencyKey?: string; twins: string[] }>;
  deleted: string[];
  abandoned: Array<{ sessionId: string; errorCode?: string }>;
  failMintAt?: number;
}

function makeFakeClient(overrides: Partial<FakeCloud> = {}): FakeCloud {
  const events: string[] = [];
  const mints: FakeCloud["mints"] = [];
  const deleted: string[] = [];
  const abandoned: FakeCloud["abandoned"] = [];
  const cloud: FakeCloud = {
    events,
    mints,
    deleted,
    abandoned,
    ...overrides,
    client: null as unknown as HostedClient,
  };
  cloud.client = {
    async createSession(input) {
      if (cloud.failMintAt !== undefined && mints.length + 1 === cloud.failMintAt) {
        throw new HostedOrchError("twin provision timeout");
      }
      mints.push({
        groupId: input.groupId,
        idempotencyKey: input.idempotencyKey,
        twins: input.twins,
      });
      events.push("mint");
      const n = mints.length;
      return {
        session_id: `ses_${n}`,
        twin_url: `https://twins.example/s/ses_${n}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        agent_token: `tok_${n}`,
        provider_credentials: {},
        openapi_url: "https://twins.example/openapi.json",
      };
    },
    async createEvalSession() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async getSession() {
      throw new Error("not used");
    },
    async fetchState() {
      return {};
    },
    async fetchEvents() {
      return [];
    },
    async finalize() {
      throw new Error("not used — trials are injected");
    },
    async submitResult() {
      throw new Error("not used");
    },
    async requestEventsUploadUrl() {
      throw new Error("not used");
    },
    async requestStateUploadUrl() {
      throw new Error("not used");
    },
    async requestSignalsUploadUrl() {
      throw new Error("not used");
    },
    async abandonSession(sessionId, input) {
      abandoned.push({ sessionId, errorCode: input?.errorCode });
      return {
        session_id: sessionId,
        state: "failed",
        error_code: input?.errorCode ?? null,
        abandoned: true,
      };
    },
    async deleteSession(sessionId) {
      deleted.push(sessionId);
    },
  };
  return cloud;
}

function scoreOf(satisfaction: number, failedTexts: string[] = []): Score {
  return {
    satisfaction,
    passed: failedTexts.length > 0 ? 1 : 2,
    failed: failedTexts.length,
    skipped: 0,
    errored: 0,
    total_required: 2,
    evaluated: true,
    can_pass: true,
    results: failedTexts.map((text) => ({
      criterion: { type: "P" as const, text },
      outcome: "failed" as const,
      passed: false,
      skipped: false,
      reason: "not met",
    })),
    judge_model: "test-judge",
    judge_tokens_in: null,
    judge_tokens_out: null,
  };
}

function trialResult(input: {
  sessionId: string;
  satisfaction: number;
  exitCode: number;
  durationMs: number;
  failedTexts?: string[];
}): RunScenarioHostedResult {
  return {
    runId: input.sessionId,
    cloudRunId: `run_${input.sessionId}`,
    cloudDashboardUrl: `https://app.example/runs/run_${input.sessionId}`,
    score: scoreOf(input.satisfaction, input.failedTexts ?? []),
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    scenario: undefined as never,
    artifacts: undefined as never,
  };
}

beforeEach(() => {
  vi.mocked(createHostedClient).mockClear();
});

describe("runTrialGroup — upfront minting (FDRS-636)", () => {
  it("mints all k sessions upfront with one shared grp_ id and fresh idempotency keys, then runs trials sequentially", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();
    const trialCalls: RunScenarioHostedOptions[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 3,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      agentModel: "claude-x",
      out: () => {},
      client: cloud.client,
      runScenarioHostedFn: async (options) => {
        trialCalls.push(options);
        cloud.events.push("trial");
        return trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1200,
        });
      },
    });

    // All mints happen before the first trial (design: "provisioning 5
    // isolated github twins … ready" precedes any agent spawn).
    expect(cloud.events).toEqual(["mint", "mint", "mint", "trial", "trial", "trial"]);

    // One shared grp_ + nanoid21 id on EVERY mint body.
    expect(result.groupId).toMatch(/^grp_[A-Za-z0-9_-]{21}$/);
    expect(cloud.mints.map((m) => m.groupId)).toEqual([
      result.groupId,
      result.groupId,
      result.groupId,
    ]);

    // Fresh idempotency key per trial mint.
    const keys = cloud.mints.map((m) => m.idempotencyKey);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(3);

    // Each trial got its own pre-minted session, in mint order, with the
    // group client + abandon-on-failure semantics and the forwarded model.
    expect(trialCalls.map((c) => c.premintedSession?.session_id)).toEqual([
      "ses_1",
      "ses_2",
      "ses_3",
    ]);
    for (const call of trialCalls) {
      expect(call.abandonOnFailure).toBe(true);
      expect(call.client).toBe(cloud.client);
      expect(call.agentModel).toBe("claude-x");
    }

    expect(result.exitCode).toBe(0);
    expect(result.rows).toHaveLength(3);
  });

  it("k=1 is never routed here — the group runner refuses it", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();
    await expect(
      runTrialGroup({
        scenarioPath,
        agentCommand: "node agent.js",
        trials: 1,
        hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
        dashboardBaseUrl: "https://app.pome.sh",
        out: () => {},
        client: cloud.client,
      }),
    ).rejects.toThrow(/k=1|single/i);
    expect(cloud.mints).toHaveLength(0);
  });

  it("a failed mint rolls back the already-minted sessions and rethrows before any trial runs", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient({ failMintAt: 2 });
    let trialsRun = 0;

    await expect(
      runTrialGroup({
        scenarioPath,
        agentCommand: "node agent.js",
        trials: 3,
        hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
        dashboardBaseUrl: "https://app.pome.sh",
        out: () => {},
        client: cloud.client,
        runScenarioHostedFn: async () => {
          trialsRun += 1;
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow(/twin provision timeout/);

    expect(trialsRun).toBe(0);
    expect(cloud.deleted).toEqual(["ses_1"]);
  });
});

describe("runTrialGroup — errored trials (FDRS-636)", () => {
  it("an errored trial renders as an errored row, the rest continue, and the fraction excludes it", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();
    const out: string[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 3,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
      client: cloud.client,
      runScenarioHostedFn: async (options) => {
        const sid = options.premintedSession!.session_id;
        if (sid === "ses_2") {
          throw new HostedTrialError("agent timed out", "agent_timeout");
        }
        return trialResult({
          sessionId: sid,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 14_300,
        });
      },
    });

    const text = out.join("\n");
    expect(text).toContain("trial 1  ✓  100      14.3s");
    expect(text).toContain("trial 2  ⚠  errored         agent timed out — excluded");
    expect(text).toContain("trial 3  ✓  100      14.3s");
    expect(text).toContain("2 of 2 passed · 1 errored, excluded from the fraction");
    expect(result.exitCode).toBe(0);
  });

  it("a non-trial error (auth/orch mid-group) still renders as errored and later trials continue", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();
    const out: string[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 2,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
      client: cloud.client,
      runScenarioHostedFn: async (options) => {
        const sid = options.premintedSession!.session_id;
        if (sid === "ses_1") throw new HostedOrchError("twin pod restarted\nmid-run");
        return trialResult({ sessionId: sid, satisfaction: 96, exitCode: 0, durationMs: 12_100 });
      },
    });

    const text = out.join("\n");
    // Reason is flattened to one short line.
    expect(text).toContain("trial 1  ⚠  errored         twin pod restarted mid-run — excluded");
    expect(text).toContain("trial 2  ✓  96       12.1s");
    expect(result.exitCode).toBe(0);
  });

  it("exit 1 when a completed trial failed; failing criteria feed the start-there line", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();
    const out: string[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 3,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
      client: cloud.client,
      runScenarioHostedFn: async (options) => {
        const sid = options.premintedSession!.session_id;
        if (sid === "ses_1") {
          return trialResult({ sessionId: sid, satisfaction: 100, exitCode: 0, durationMs: 1000 });
        }
        return trialResult({
          sessionId: sid,
          satisfaction: 58,
          exitCode: 1,
          durationMs: 15_900,
          failedTexts: ["Severity is set correctly"],
        });
      },
    });

    const text = out.join("\n");
    expect(text).toContain("trial 2  ✗  58       15.9s  severity is set correctly");
    expect(text).toContain("1 of 3 passed");
    expect(text).toContain("severity is set correctly failed in 2 of 3 — start there");
    expect(result.exitCode).toBe(1);
  });

  it("exit 2 when no trial completed", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 2,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: () => {},
      client: cloud.client,
      runScenarioHostedFn: async () => {
        throw new HostedTrialError("agent preflight failed", "preflight_failed");
      },
    });

    expect(result.rows.every((r) => r.kind === "errored")).toBe(true);
    expect(result.exitCode).toBe(2);
  });
});

describe("runTrialGroup — dashboard link + client construction", () => {
  it("derives the reliability link from the dashboard base + /runs/task/<taskName>", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeFakeClient();
    const out: string[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 2,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh/",
      out: (line) => out.push(line),
      client: cloud.client,
      runScenarioHostedFn: async (options) =>
        trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        }),
    });

    // Route shape from the dashboard app: /runs/task/[taskName]; slug of the
    // fixture file is "scn". No double slash from the trailing base slash.
    expect(result.reliabilityUrl).toBe("https://app.pome.sh/runs/task/scn");
    expect(out.join("\n")).toContain("→ https://app.pome.sh/runs/task/scn");
  });

  it("appends ?agent=<agentId> when pome.config.json pins one (page groups per agent)", async () => {
    const scenarioPath = await scenarioFixture();
    const dir = join(scenarioPath, "..");
    await writeFile(
      join(dir, "pome.config.json"),
      JSON.stringify({ agentId: "agt_123", agent: { command: "node agent.js" } }),
      "utf8",
    );
    const cloud = makeFakeClient();

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 2,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: () => {},
      client: cloud.client,
      runScenarioHostedFn: async (options) =>
        trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        }),
    });

    expect(result.reliabilityUrl).toBe(
      "https://app.pome.sh/runs/task/scn?agent=agt_123",
    );
  });

  it("constructs the default client with the explicit 60s finalize timeout ([DECISION])", async () => {
    const scenarioPath = await scenarioFixture();
    const fake = makeFakeClient();
    vi.mocked(createHostedClient).mockReturnValueOnce(fake.client);

    await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 2,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: () => {},
      runScenarioHostedFn: async (options) =>
        trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        }),
    });

    expect(GROUP_FINALIZE_TIMEOUT_MS).toBe(60_000);
    expect(createHostedClient).toHaveBeenCalledWith({
      baseUrl: "https://api.example",
      apiKey: "pme_k",
      timeoutMs: 60_000,
    });
  });
});
