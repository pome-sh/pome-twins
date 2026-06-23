import { describe, expect, it } from "vitest";
import { evaluateScenario } from "../../src/evaluator/deterministic.js";
import { parseScenarioFile } from "../../src/scenario/parseScenario.js";

const REQUIRES_API_KEY = !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;

describe.skipIf(REQUIRES_API_KEY)("real-LLM judge e2e", () => {
  it("evaluates 04-judge-context with mixed [D] + [P] using real LLM", async () => {
    const scenario = await parseScenarioFile("./scenarios/04-judge-context.md");

    const stateInitial = {
      repositories: [
        {
          full_name: "acme/api",
          labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
          issues: [{ number: 1, assignee_login: null, labels: [], title: "500 error on POST /orders after deploy" }],
        },
      ],
    };
    const stateFinal = {
      repositories: [
        {
          full_name: "acme/api",
          labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
          issues: [{ number: 1, assignee_login: null, labels: [{ name: "bug" }], title: "500 error on POST /orders after deploy" }],
        },
      ],
    };
    const events = [
      { method: "GET", path: "/repos/acme/api/issues/1", status: 200, latency_ms: 12 },
      { method: "POST", path: "/repos/acme/api/issues/1/labels", status: 201, latency_ms: 18, request_body: { labels: ["bug"] } },
    ];

    const score = await evaluateScenario({
      scenario,
      initialState: stateInitial,
      finalState: stateFinal,
      events: events as unknown as never,
      stdout: "",
    });

    expect(score.satisfaction).toBeGreaterThan(0);
    expect(score.judge_model).toBeTruthy();
    // Real providers must report usage; null here would mean a real run lands
    // in the cloud with null tokens — the production gap this e2e exists to catch.
    expect(score.judge_tokens_in).not.toBeNull();
    expect(score.judge_tokens_out).not.toBeNull();

    const pResult = score.results.find((r) => r.criterion.type === "P");
    expect(pResult).toBeDefined();
    expect(pResult!.skipped).toBe(false);
    expect(pResult!.confidence).toBeGreaterThanOrEqual(0);
    expect(pResult!.confidence).toBeLessThanOrEqual(1);
    expect(pResult!.judge_model).toBeTruthy();
  }, 60_000);
});
