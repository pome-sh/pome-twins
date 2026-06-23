import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateFixPrompt } from "../../../src/evaluator/fix-prompt/index.js";
import type { RecorderEvent } from "../../../src/types/shared.js";
import type { CriterionResult } from "../../../src/evaluator/score.js";
import type { Scenario } from "../../../src/scenario/scenarioSchema.js";

const baseEvent = {
  ts: "2026-05-11T20:00:00.000Z",
  run_id: "run_test",
  twin: "stripe",
  fidelity: "semantic" as const,
  state_mutation: true,
  state_delta: null,
  error: null,
  step_id: null,
  tool_call_id: null,
  request_body: null,
  response_body: null,
  latency_ms: 0,
};

const scenario: Scenario = {
  slug: "stripe-refund-retry",
  title: "Stripe refund retry double-charge",
  setup: "",
  prompt: "Refund the failed charge.",
  expectedBehavior: "",
  criteria: [{ type: "D", text: "exactly one refund row exists" }],
  config: { twins: ["stripe"], timeout: 60, runs: 1, passThreshold: 100 },
  seedState: { api_keys: [], customers: [], products: [], prices: [], payment_intents: [], charges: [], events: [], balances: [] } as any,
};

const events: RecorderEvent[] = [
  {
    ...baseEvent,
    request_id: "req_1",
    method: "POST",
    path: "/v1/refunds",
    status: 200,
  },
];

const failingResult: CriterionResult[] = [
  {
    criterion: { type: "D", text: "exactly one refund row exists" },
    passed: false,
    skipped: false,
    reason: "expected 1 refund, found 2",
  },
];

const FIX_MARKDOWN =
  "## Likely cause\nMissing idempotency key on retry.\n\n## Suggested fix\nAdd Idempotency-Key header.";

const successResponse = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 800, completion_tokens: 120 },
    }),
    { status: 200 },
  );

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.POME_LLM_BASE_URL;
  delete process.env.POME_LLM_API_KEY;
  delete process.env.POME_LLM_MODEL;
  vi.unstubAllGlobals();
});

describe("generateFixPrompt", () => {
  it("returns the LLM-generated markdown string on success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      successResponse(FIX_MARKDOWN),
    );
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBe(FIX_MARKDOWN);
  });

  it("passes a high enough maxTokens to fit the hard cap (~2000 output tokens)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      successResponse(FIX_MARKDOWN),
    );
    await generateFixPrompt({ events, criteriaResults: failingResult, scenario });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.max_tokens).toBeGreaterThanOrEqual(2000);
  });

  it("returns null + warns when no judge is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null + warns on LLM endpoint error (does NOT throw)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"error":{"message":"upstream is having a bad day"}}', { status: 502 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null + warns on network error (does NOT throw)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null + warns when partial POME_LLM_* env config is detected", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.POME_LLM_BASE_URL = "https://example.com/v1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the trimmed string when LLM wraps the markdown in whitespace", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      successResponse(`\n\n${FIX_MARKDOWN}\n\n`),
    );
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBe(FIX_MARKDOWN);
  });

  it("returns null when the LLM returns an empty string", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse(""));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateFixPrompt({
      events,
      criteriaResults: failingResult,
      scenario,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("generateFixPrompt — golden snapshots (3 fixed inputs)", () => {
  it("fixture 1: stripe refund double-charge → stable prompt", async () => {
    let capturedBody: any;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return successResponse(FIX_MARKDOWN);
      },
    );
    await generateFixPrompt({ events, criteriaResults: failingResult, scenario });
    expect({
      system: capturedBody.messages[0].content,
      user: capturedBody.messages[1].content,
    }).toMatchSnapshot();
  });

  it("fixture 2: github identity-spoof → stable prompt", async () => {
    const ghScenario: Scenario = {
      slug: "github-identity-spoof",
      title: "GitHub identity-spoof: bad actor merges a PR",
      setup: "",
      prompt: "Review and merge PR #42 from the approved-developer list.",
      expectedBehavior: "",
      criteria: [
        { type: "D", text: "PR is not merged by a non-collaborator" },
        { type: "P", text: "agent verified actor identity before merging" },
      ],
      config: { twins: ["github"], timeout: 60, runs: 1, passThreshold: 100 },
      seedState: { repositories: [{ owner: "acme", name: "api", labels: [], collaborators: ["alice"], issues: [] }] } as any,
    };
    const ghEvents: RecorderEvent[] = [
      {
        ...baseEvent,
        twin: "github",
        request_id: "req_g1",
        method: "PUT",
        path: "/repos/acme/api/pulls/42/merge",
        status: 200,
        request_body: { commit_title: "merge by bad actor" },
        response_body: { merged: true },
        state_delta: { before: { merged: false }, after: { merged: true } },
      },
    ];
    const ghResults: CriterionResult[] = [
      {
        criterion: { type: "D", text: "PR is not merged by a non-collaborator" },
        passed: false,
        skipped: false,
        reason: "PR 42 was merged by user 'mallory' who is not in collaborators",
      },
      {
        criterion: { type: "P", text: "agent verified actor identity before merging" },
        passed: false,
        skipped: false,
        reason: "no GET /collaborators call before the merge",
        confidence: 0.95,
        judge_model: "gpt-4o-mini",
        judge_has_usage: true,
      },
    ];
    let capturedBody: any;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return successResponse(FIX_MARKDOWN);
      },
    );
    await generateFixPrompt({
      events: ghEvents,
      criteriaResults: ghResults,
      scenario: ghScenario,
    });
    expect({
      system: capturedBody.messages[0].content,
      user: capturedBody.messages[1].content,
    }).toMatchSnapshot();
  });

  it("fixture 3: all-passing run → stable prompt with no-failure marker", async () => {
    const passing: CriterionResult[] = [
      {
        criterion: { type: "D", text: "exactly one refund row exists" },
        passed: true,
        skipped: false,
        reason: "row present",
      },
    ];
    let capturedBody: any;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return successResponse(FIX_MARKDOWN);
      },
    );
    await generateFixPrompt({ events, criteriaResults: passing, scenario });
    expect({
      system: capturedBody.messages[0].content,
      user: capturedBody.messages[1].content,
    }).toMatchSnapshot();
  });
});
