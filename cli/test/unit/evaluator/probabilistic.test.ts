import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateProbabilistic } from "../../../src/evaluator/probabilistic/index.js";

const pCrit = { type: "P" as const, text: "Label is contextually appropriate" };
const ctx = {
  toolCallCount: 2,
  stateBefore: {},
  stateAfter: {},
  events: [],
};

const successResponse = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.unstubAllGlobals();
});

describe("evaluateProbabilistic", () => {
  it("maps pass to passed=true and records confidence + judge_model", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      successResponse('{"status":"pass","confidence":0.9,"explanation":"label fits issue"}'),
    );
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.confidence).toBe(0.9);
    expect(r.judge_model).toBe("gpt-4o-mini");
    expect(r.judge_tokens_in).toBe(100);
    expect(r.judge_tokens_out).toBe(20);
    expect(r.judge_has_usage).toBe(true);
    expect(r.reason).toBe("label fits issue");
  });

  it("maps fail to passed=false", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      successResponse('{"status":"fail","confidence":0.85,"explanation":"agent did not assign"}'),
    );
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe("agent did not assign");
  });

  it("maps partial to passed=false with PARTIAL: reason prefix", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      successResponse('{"status":"partial","confidence":0.6,"explanation":"only labeled, not assigned"}'),
    );
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe("PARTIAL: only labeled, not assigned");
  });

  it("returns skipped=true with helpful reason on 401", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }),
    );
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/auth/i);
    expect(r.judge_model).toBe("gpt-4o-mini");
    expect(r.judge_has_usage).toBe(false);
  });

  it("returns skipped=true on context-too-large", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"error":{"message":"context length exceeded maximum tokens"}}', { status: 400 }),
    );
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/\[D\]/);
  });

  it("returns skipped=true with friendly reason when no env config", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/judge configured/i);
    expect(r.judge_model).toBeUndefined();
  });

  it("returns skipped=true on partial-config error", async () => {
    process.env.POME_LLM_BASE_URL = "https://example.com/v1";
    delete process.env.OPENAI_API_KEY;
    const r = await evaluateProbabilistic(pCrit, ctx);
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/POME_LLM_API_KEY/);
    delete process.env.POME_LLM_BASE_URL;
  });
});
