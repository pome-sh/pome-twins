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
import {
  HostedOrchError,
  HostedQuotaError,
  HostedTrialError,
} from "../../../src/hosted/errors.js";
import {
  GROUP_FINALIZE_TIMEOUT_MS,
  LAZY_MINT_MAX_ATTEMPTS,
  LAZY_MINT_RETRY_MS,
  runTrialGroup,
} from "../../../src/runner/runTrialGroup.js";
import type {
  RunScenarioHostedOptions,
  RunScenarioHostedResult,
} from "../../../src/runner/runScenarioHosted.js";
import type { Score } from "../../../src/hosted/evalResultView.js";

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
        session_token: `pst_test_${n}`,
        twin_url: `https://twins.example/s/ses_${n}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        agent_token: `tok_${n}`,
        provider_credentials: {},
        openapi_url: "https://twins.example/openapi.json",
        per_twin: {},
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
    async requestMetaUploadUrl() {
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
      criterion: { type: "model" as const, text },
      passed: false,
      skipped: false,
      reason: "not met",
      confidence: 0.1,
      judge_model: "test-judge",
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

// FDRS-663 — free-tier `concurrentTwins: 3` vs the k=5 default. Decided cut
// (option A): bounded/lazy minting inside the group runner — mint ≤ the
// team's concurrent quota (discovered adaptively from the mint-gate quota
// error), run trials with that concurrency, and mint the remaining trials'
// sessions lazily as slots free up. Resolves FDRS-636's deferred "bounded
// trial parallelism (plan-quota semantics)" thread.
interface QuotaCloud {
  client: HostedClient;
  /** Every createSession attempt, successful or quota-refused. */
  attempts: number;
  mints: Array<{ groupId?: string; idempotencyKey?: string }>;
  active: number;
  peakActive: number;
  /** Simulates the slot freeing when a trial's session is deleted. */
  release: (sessionId: string) => void;
}

function makeQuotaCloud(input: {
  limit: number;
  /** 1-based createSession attempt numbers that quota-fail regardless of
   *  the limit — simulates delete-propagation lag on lazy mints. */
  forcedQuotaAttempts?: number[];
}): QuotaCloud {
  const forced = new Set(input.forcedQuotaAttempts ?? []);
  const released = new Set<string>();
  const cloud: QuotaCloud = {
    client: null as unknown as HostedClient,
    attempts: 0,
    mints: [],
    active: 0,
    peakActive: 0,
    release: (sessionId) => {
      if (released.has(sessionId)) return;
      released.add(sessionId);
      cloud.active -= 1;
    },
  };
  const unused = () => {
    throw new Error("not used");
  };
  cloud.client = {
    async createSession(sessionInput) {
      cloud.attempts += 1;
      if (forced.has(cloud.attempts) || cloud.active >= input.limit) {
        throw new HostedQuotaError("Concurrent twin quota exceeded for this team.");
      }
      cloud.active += 1;
      cloud.peakActive = Math.max(cloud.peakActive, cloud.active);
      cloud.mints.push({
        groupId: sessionInput.groupId,
        idempotencyKey: sessionInput.idempotencyKey,
      });
      const n = cloud.mints.length;
      return {
        session_id: `ses_${n}`,
        session_token: `pst_test_${n}`,
        twin_url: `https://twins.example/s/ses_${n}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        agent_token: `tok_${n}`,
        provider_credentials: {},
        openapi_url: "https://twins.example/openapi.json",
        per_twin: {},
      };
    },
    async deleteSession(sessionId) {
      cloud.release(sessionId);
    },
    createEvalSession: unused,
    listSessions: async () => [],
    getSession: unused,
    fetchState: async () => ({}),
    fetchEvents: async () => [],
    finalize: unused,
    submitResult: unused,
    requestEventsUploadUrl: unused,
    requestStateUploadUrl: unused,
    requestSignalsUploadUrl: unused,
    requestMetaUploadUrl: unused,
    abandonSession: async (sessionId) => ({
      session_id: sessionId,
      state: "failed",
      error_code: null,
      abandoned: true,
    }),
  };
  return cloud;
}

describe("runTrialGroup — quota-bounded mint + bounded parallelism (FDRS-663)", () => {
  it("a quota error mid-mint bounds the group instead of aborting: k=5 completes at concurrency 3", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeQuotaCloud({ limit: 3 });
    const out: string[] = [];
    let activeTrials = 0;
    let peakTrials = 0;

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 5,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
      client: cloud.client,
      sleepFn: async () => {},
      runScenarioHostedFn: async (options) => {
        activeTrials += 1;
        peakTrials = Math.max(peakTrials, activeTrials);
        await new Promise((r) => setTimeout(r, 10));
        activeTrials -= 1;
        // runScenarioHosted deletes its own session in its finally — that is
        // what frees the quota slot for the next lazy mint.
        cloud.release(options.premintedSession!.session_id);
        return trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        });
      },
    });

    // All five trials completed without the group aborting on exit 4.
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((r) => r.kind === "completed")).toBe(true);
    expect(result.exitCode).toBe(0);

    // The cloud never saw more than the plan's concurrent quota, and the
    // trials actually ran in parallel up to that bound.
    expect(cloud.peakActive).toBe(3);
    expect(peakTrials).toBe(3);

    // 5 successful mints (3 upfront + 2 lazy), one shared group id, fresh
    // idempotency keys throughout.
    expect(cloud.mints).toHaveLength(5);
    expect(new Set(cloud.mints.map((m) => m.groupId)).size).toBe(1);
    expect(new Set(cloud.mints.map((m) => m.idempotencyKey)).size).toBe(5);

    // Honest provisioning copy: the bound is named, not silently absorbed.
    expect(out.join("\n")).toContain(
      "provisioning 3 isolated github twins … ready (plan concurrency 3 — 5 trials reuse slots as they finish)",
    );
  });

  it("a lazy mint that quota-fails on delete-propagation lag retries after a pause and completes", async () => {
    const scenarioPath = await scenarioFixture();
    // Attempts 1-2 mint, attempt 3 hits the limit (bound=2), attempt 4 is the
    // first lazy mint — forced to fail once as if the freed slot hasn't
    // propagated — and attempt 5 succeeds.
    const cloud = makeQuotaCloud({ limit: 2, forcedQuotaAttempts: [4] });
    const sleeps: number[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 3,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: () => {},
      client: cloud.client,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      runScenarioHostedFn: async (options) => {
        await new Promise((r) => setTimeout(r, 5));
        cloud.release(options.premintedSession!.session_id);
        return trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        });
      },
    });

    expect(sleeps).toEqual([LAZY_MINT_RETRY_MS]);
    expect(result.rows.every((r) => r.kind === "completed")).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(cloud.mints).toHaveLength(3);
  });

  it("a lazy mint that never clears quota errors that trial (excluded) and the rest still count", async () => {
    const scenarioPath = await scenarioFixture();
    // Bound discovery at attempt 3; the lazy mint for trial 3 quota-fails on
    // every one of its attempts.
    const lazyAttempts = Array.from(
      { length: LAZY_MINT_MAX_ATTEMPTS },
      (_, i) => 4 + i,
    );
    const cloud = makeQuotaCloud({ limit: 2, forcedQuotaAttempts: lazyAttempts });
    const out: string[] = [];

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 3,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
      client: cloud.client,
      sleepFn: async () => {},
      runScenarioHostedFn: async (options) => {
        cloud.release(options.premintedSession!.session_id);
        return trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        });
      },
    });

    const kinds = result.rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === "completed")).toHaveLength(2);
    expect(kinds.filter((k) => k === "errored")).toHaveLength(1);
    expect(out.join("\n")).toContain("2 of 2 passed · 1 errored, excluded from the fraction");
    expect(result.exitCode).toBe(0);
  });

  it("a quota error on the very first mint still aborts the group (nothing to bound)", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeQuotaCloud({ limit: 0 });
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
        sleepFn: async () => {},
        runScenarioHostedFn: async () => {
          trialsRun += 1;
          throw new Error("unreachable");
        },
      }),
    ).rejects.toBeInstanceOf(HostedQuotaError);
    expect(trialsRun).toBe(0);
  });

  it("trial rows render in trial order even when later trials finish first", async () => {
    const scenarioPath = await scenarioFixture();
    const cloud = makeQuotaCloud({ limit: 2 });
    const out: string[] = [];

    await runTrialGroup({
      scenarioPath,
      agentCommand: "node agent.js",
      trials: 2,
      hosted: { baseUrl: "https://api.example", apiKey: "pme_k" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
      client: cloud.client,
      sleepFn: async () => {},
      runScenarioHostedFn: async (options) => {
        const sid = options.premintedSession!.session_id;
        // Trial 1 is slow; trial 2 finishes well before it.
        await new Promise((r) => setTimeout(r, sid === "ses_1" ? 40 : 1));
        cloud.release(sid);
        return trialResult({
          sessionId: sid,
          satisfaction: sid === "ses_1" ? 100 : 96,
          exitCode: 0,
          durationMs: 1000,
        });
      },
    });

    const rowLines = out.filter((l) => l.startsWith("trial "));
    expect(rowLines[0]).toContain("trial 1");
    expect(rowLines[0]).toContain("100");
    expect(rowLines[1]).toContain("trial 2");
    expect(rowLines[1]).toContain("96");
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

  // FDRS-665 — the handoff link carries the agent by construction: with a
  // registered slug (written by `pome install` / `pome register agent`,
  // FDRS-669) the CLI prints /agents/<slug>/tasks/<name>?group=grp_… — the
  // run set's reliability view, never the agent-less empty state. ?group is
  // forward-compat: the page honors it in M1.
  it("prints /agents/<slug>/tasks/<name>?group=grp_… when pome.config.json carries the registered slug", async () => {
    const scenarioPath = await scenarioFixture();
    const dir = join(scenarioPath, "..");
    await writeFile(
      join(dir, "pome.config.json"),
      JSON.stringify({
        agentId: "agt_123",
        agentSlug: "triage-bot",
        agent: { command: "node agent.js" },
      }),
      "utf8",
    );
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
      groupId: "grp_C6ptcAyN31L5v58zfmYFq",
      runScenarioHostedFn: async (options) =>
        trialResult({
          sessionId: options.premintedSession!.session_id,
          satisfaction: 100,
          exitCode: 0,
          durationMs: 1000,
        }),
    });

    expect(result.reliabilityUrl).toBe(
      "https://app.pome.sh/agents/triage-bot/tasks/scn?group=grp_C6ptcAyN31L5v58zfmYFq",
    );
    expect(out.join("\n")).toContain(
      "→ https://app.pome.sh/agents/triage-bot/tasks/scn?group=grp_C6ptcAyN31L5v58zfmYFq",
    );
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
