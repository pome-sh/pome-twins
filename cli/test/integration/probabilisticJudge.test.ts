import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateScenario } from "../../src/evaluator/deterministic.js";
import type { Scenario } from "../../src/scenario/scenarioSchema.js";

const scenario: Scenario = {
  slug: "04-judge-context",
  title: "Judge sees context",
  setup: "",
  prompt: "Triage issue #1.",
  expectedBehavior: "",
  criteria: [
    { type: "D", text: "Issue #1 has exactly one classification label still `bug`" },
    { type: "P", text: "The classification label applied is contextually appropriate given the issue title and body" },
  ],
  config: { twins: ["github"], timeout: 60, runs: 1, passThreshold: 50 },
  seedState: {
    repositories: [
      {
        owner: "acme",
        name: "api",
        labels: [
          { name: "bug", color: "ededed", description: "" },
          { name: "feature", color: "ededed", description: "" },
          { name: "question", color: "ededed", description: "" },
        ],
        collaborators: [],
        issues: [{ number: 1, title: "500 error on POST /orders", body: "", state: "open", labels: [], assignee: null }],
      },
    ],
  },
};

const stateInitial = {
  repositories: [
    {
      full_name: "acme/api",
      labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
      issues: [{ number: 1, assignee_login: null, labels: [], title: "500 error on POST /orders" }],
    },
  ],
};

const stateFinal = {
  repositories: [
    {
      full_name: "acme/api",
      labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
      issues: [{ number: 1, assignee_login: null, labels: [{ name: "bug" }], title: "500 error on POST /orders" }],
    },
  ],
};

const events = [
  { method: "GET", path: "/repos/acme/api/issues/1", status: 200, latency_ms: 12 },
  { method: "POST", path: "/repos/acme/api/issues/1/labels", status: 201, latency_ms: 18, request_body: { labels: ["bug"] } },
];

const judgeOk = (content: string, usage = { prompt_tokens: 800, completion_tokens: 50 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.unstubAllGlobals();
});

describe("evaluateScenario with mixed [D] + [P] criteria", () => {
  it("dispatches each criterion to the right evaluator + aggregates Score", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      judgeOk('{"status":"pass","confidence":0.9,"explanation":"`bug` is appropriate for a 500 error report"}'),
    );

    const score = await evaluateScenario({
      scenario,
      initialState: stateInitial,
      finalState: stateFinal,
      events: events as unknown as never,
      stdout: "",
    });

    expect(score.satisfaction).toBe(100);
    expect(score.passed).toBe(2);
    expect(score.failed).toBe(0);

    expect(score.judge_model).toBe("gpt-4o-mini");
    expect(score.judge_tokens_in).toBe(800);
    expect(score.judge_tokens_out).toBe(50);

    const dResult = score.results.find((r) => r.criterion.type === "D")!;
    expect(dResult.confidence).toBeUndefined();
    expect(dResult.judge_model).toBeUndefined();

    const pResult = score.results.find((r) => r.criterion.type === "P")!;
    expect(pResult.confidence).toBe(0.9);
    expect(pResult.judge_model).toBe("gpt-4o-mini");
    expect(pResult.reason).toContain("bug");
  });

  it("treats partial as failed but records PARTIAL: prefix", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      judgeOk('{"status":"partial","confidence":0.55,"explanation":"close but `bug` should have been `question`"}'),
    );

    const score = await evaluateScenario({
      scenario,
      initialState: stateInitial,
      finalState: stateFinal,
      events: events as unknown as never,
      stdout: "",
    });

    expect(score.passed).toBe(1);
    expect(score.failed).toBe(1);
    expect(score.satisfaction).toBe(50);

    const pResult = score.results.find((r) => r.criterion.type === "P")!;
    expect(pResult.passed).toBe(false);
    expect(pResult.reason.startsWith("PARTIAL:")).toBe(true);
  });

  it("marks [P] as skipped (not failed) on judge auth error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }),
    );

    const score = await evaluateScenario({
      scenario,
      initialState: stateInitial,
      finalState: stateFinal,
      events: events as unknown as never,
      stdout: "",
    });

    expect(score.passed).toBe(1);
    expect(score.failed).toBe(0);
    expect(score.skipped).toBe(1);
    expect(score.satisfaction).toBe(100);

    const pResult = score.results.find((r) => r.criterion.type === "P")!;
    expect(pResult.skipped).toBe(true);
    expect(pResult.reason).toMatch(/auth/i);
  });

  it("returns null run-level tokens when no judge env is set", async () => {
    delete process.env.OPENAI_API_KEY;

    const score = await evaluateScenario({
      scenario,
      initialState: stateInitial,
      finalState: stateFinal,
      events: events as unknown as never,
      stdout: "",
    });

    expect(score.judge_tokens_in).toBeNull();
    expect(score.judge_tokens_out).toBeNull();
    expect(score.judge_model).toBeNull();
  });
});
