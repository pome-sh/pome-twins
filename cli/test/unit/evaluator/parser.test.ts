import { describe, expect, it } from "vitest";
import { parseJudgeResponse } from "../../../src/evaluator/probabilistic/parser.js";

describe("parseJudgeResponse", () => {
  it("parses direct JSON", () => {
    const r = parseJudgeResponse('{"status":"pass","confidence":0.9,"explanation":"label is appropriate"}');
    expect(r.status).toBe("pass");
    expect(r.confidence).toBe(0.9);
    expect(r.explanation).toBe("label is appropriate");
  });

  it("parses JSON in code block", () => {
    const r = parseJudgeResponse(
      '```json\n{"status":"fail","confidence":0.7,"explanation":"agent did not assign"}\n```',
    );
    expect(r.status).toBe("fail");
    expect(r.confidence).toBe(0.7);
  });

  it("parses partial status", () => {
    const r = parseJudgeResponse('{"status":"partial","confidence":0.5,"explanation":"some progress"}');
    expect(r.status).toBe("partial");
  });

  it("normalizes status synonyms", () => {
    expect(parseJudgeResponse('{"status":"passed","confidence":0.8,"explanation":"ok"}').status).toBe("pass");
    expect(parseJudgeResponse('{"status":"failed","confidence":0.8,"explanation":"no"}').status).toBe("fail");
    expect(parseJudgeResponse('{"status":"partially_passed","confidence":0.5,"explanation":"meh"}').status).toBe(
      "partial",
    );
  });

  it("clamps confidence to [0, 1]", () => {
    expect(parseJudgeResponse('{"status":"pass","confidence":1.5,"explanation":"x"}').confidence).toBe(1);
    expect(parseJudgeResponse('{"status":"pass","confidence":-0.2,"explanation":"x"}').confidence).toBe(0);
  });

  it("parses balanced JSON object embedded in prose", () => {
    const r = parseJudgeResponse(
      'Here is my evaluation:\n\n{"status":"pass","confidence":0.85,"explanation":"good"}\n\nLet me know if you need more.',
    );
    expect(r.status).toBe("pass");
    expect(r.confidence).toBe(0.85);
  });

  it("recovers from nested result/evaluation/judge/output keys", () => {
    const r = parseJudgeResponse(
      '{"result":{"status":"pass","confidence":0.9,"explanation":"yes"}}',
    );
    expect(r.status).toBe("pass");
  });

  it("falls back to loose key=value parsing", () => {
    const r = parseJudgeResponse(
      "status: pass\nconfidence: 0.8\nexplanation: agent labeled correctly",
    );
    expect(r.status).toBe("pass");
    expect(r.confidence).toBe(0.8);
  });

  it("falls back to freeform inference (passed)", () => {
    const r = parseJudgeResponse("The criterion is satisfied. The agent passed.");
    expect(r.status).toBe("pass");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("falls back to freeform inference (failed)", () => {
    const r = parseJudgeResponse("The agent did not act on the issue. Failed.");
    expect(r.status).toBe("fail");
  });

  it("falls back to freeform inference (partial)", () => {
    const r = parseJudgeResponse("Made some progress but did not fully complete.");
    expect(r.status).toBe("partial");
  });

  it("returns fail with low confidence when un-parseable", () => {
    const r = parseJudgeResponse("the quick brown fox");
    expect(r.status).toBe("fail");
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.explanation).toContain("un-parseable");
  });

  it("trims long explanations", () => {
    const long = "x".repeat(500);
    const r = parseJudgeResponse(`{"status":"pass","confidence":0.9,"explanation":"${long}"}`);
    expect(r.explanation.length).toBeLessThanOrEqual(400);
  });
});
