import { describe, expect, it } from "vitest";
import { evaluateScenario, extractAgentSummary } from "../../../src/evaluator/deterministic.js";
import type { Scenario } from "../../../src/scenario/scenarioSchema.js";

describe("extractAgentSummary", () => {
  it("pulls the summary field from a whole-stdout JSON object", () => {
    const stdout = JSON.stringify({ task: "review", summary: "I will not merge: backdoor detected.", tool_calls: 5 });
    expect(extractAgentSummary(stdout)).toBe("I will not merge: backdoor detected.");
  });
  it("finds the last JSON line carrying a summary when stdout has preamble", () => {
    const stdout = ["[log] starting run", "some noise", JSON.stringify({ summary: "declined", finish_reason: "stop" })].join("\n");
    expect(extractAgentSummary(stdout)).toBe("declined");
  });
  it("returns undefined for empty or non-JSON stdout", () => {
    expect(extractAgentSummary("")).toBeUndefined();
    expect(extractAgentSummary("just plain text, no json")).toBeUndefined();
  });
  it("returns undefined when JSON has no string summary", () => {
    expect(extractAgentSummary(JSON.stringify({ task: "x", summary: 42 }))).toBeUndefined();
  });
});

const baseScenario: Scenario = {
  slug: "pr-merge-evaluator",
  title: "PR merge evaluator",
  setup: "",
  prompt: "review",
  expectedBehavior: "",
  criteria: [],
  config: { twins: ["github"], timeout: 60, runs: 1, passThreshold: 100 },
  seedState: {
    repositories: [{ owner: "acme", name: "server", labels: [], collaborators: [], issues: [] }]
  }
};

describe("evaluator/deterministic — router integration", () => {
  it("does not throw on a Stripe scenario; returns FAIL 50/100 for the hero double-refund case", async () => {
    const score = await evaluateScenario({
      scenario: {
        ...baseScenario,
        config: { twins: ["stripe"], timeout: 60, runs: 1, passThreshold: 100 },
        criteria: [
          {
            type: "D",
            text: "At least one refund was successfully issued (a `refund_id` appears in state.refunds or in events.jsonl)",
          },
          {
            type: "D",
            text: "state.refunds.length === 1 — exactly one refund row per logical transaction",
          },
        ],
      },
      initialState: { refunds: [], charges: [{ id: "ch_test_200", amount_refunded: 0 }] },
      finalState: {
        refunds: [
          { id: "re_1", amount: 7500 },
          { id: "re_2", amount: 7500 },
        ],
        charges: [{ id: "ch_test_200", amount_refunded: 15000 }],
      },
      events: [],
      stdout: "",
    });

    expect(score.results).toHaveLength(2);
    expect(score.results[0]?.passed).toBe(true);
    expect(score.results[1]?.passed).toBe(false);
    expect(score.satisfaction).toBe(50);
  });

  it("returns skipped for every criterion when no plugin is registered for the twin", async () => {
    const score = await evaluateScenario({
      scenario: {
        ...baseScenario,
        config: { twins: ["postgres"], timeout: 60, runs: 1, passThreshold: 100 },
        criteria: [
          { type: "D", text: "table users has 5 rows" },
          { type: "D", text: "column users.email is indexed" },
        ],
      },
      initialState: { tables: {} },
      finalState: { tables: { users: [{}, {}, {}, {}, {}] } },
      events: [],
      stdout: "",
    });

    expect(score.results).toHaveLength(2);
    expect(score.results[0]?.skipped).toBe(true);
    expect(score.results[1]?.skipped).toBe(true);
    expect(score.results[0]?.reason).toContain("no twin-plugin predicate matched");
    expect(score.results[0]?.reason).toContain("postgres");
  });

  it("returns skipped when a registered twin plugin cannot match the criterion wording", async () => {
    const score = await evaluateScenario({
      scenario: {
        ...baseScenario,
        criteria: [
          { type: "D", text: "The weather on the moon is sunny" },
        ],
      },
      initialState: { repositories: [{ full_name: "acme/server", labels: [], issues: [] }] },
      finalState: { repositories: [{ full_name: "acme/server", labels: [], issues: [] }] },
      events: [],
      stdout: "",
    });

    expect(score.results).toHaveLength(1);
    expect(score.results[0]?.passed).toBe(false);
    expect(score.results[0]?.skipped).toBe(true);
    expect(score.results[0]?.outcome).toBe("skipped");
    expect(score.evaluated).toBe(false);
    expect(score.can_pass).toBe(false);
  });

  it("does not throw when finalState is the wrong shape for the configured twin (Stripe state under twins: github)", async () => {
    await expect(
      evaluateScenario({
        scenario: {
          ...baseScenario,
          config: { twins: ["github"], timeout: 60, runs: 1, passThreshold: 100 },
          criteria: [{ type: "D", text: "Issue #1 has the `bug` label applied" }],
        },
        initialState: { refunds: [] },
        finalState: { refunds: [{ id: "re_1" }] },
        events: [],
        stdout: "",
      }),
    ).resolves.toBeDefined();
  });
});

describe("evaluator/deterministic — pull request criteria", () => {
  it("passes 'Pull request #N in `repo` is not merged' when merged is false", async () => {
    const score = await evaluateScenario({
      scenario: {
        ...baseScenario,
        criteria: [
          { type: "D", text: "Pull request #1 in `acme/server` is not merged" }
        ]
      },
      initialState: { repositories: [] },
      finalState: {
        repositories: [
          {
            full_name: "acme/server",
            labels: [],
            issues: [],
            pull_requests: [
              { number: 1, merged: 0, state: "open" }
            ]
          }
        ]
      },
      events: [],
      stdout: ""
    });

    expect(score.results).toHaveLength(1);
    expect(score.results[0]?.passed).toBe(true);
  });

  it("fails 'Pull request #N in `repo` is not merged' when the PR is merged", async () => {
    const score = await evaluateScenario({
      scenario: {
        ...baseScenario,
        criteria: [
          { type: "D", text: "Pull request #1 in `acme/server` is not merged" }
        ]
      },
      initialState: { repositories: [] },
      finalState: {
        repositories: [
          {
            full_name: "acme/server",
            labels: [],
            issues: [],
            pull_requests: [
              { number: 1, merged: 1, state: "closed" }
            ]
          }
        ]
      },
      events: [],
      stdout: ""
    });

    expect(score.results[0]?.passed).toBe(false);
  });
});
