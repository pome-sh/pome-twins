import { describe, expect, it } from "vitest";
import { classifyJudgeError, formatErrorReason } from "../../../src/evaluator/probabilistic/errors.js";

describe("classifyJudgeError", () => {
  it("classifies 401 as auth_error", () => {
    expect(classifyJudgeError({ status: 401, message: "Unauthorized" })).toBe("auth_error");
  });
  it("classifies 403 as auth_error", () => {
    expect(classifyJudgeError({ status: 403, message: "Forbidden" })).toBe("auth_error");
  });
  it("classifies 429 as rate_limited", () => {
    expect(classifyJudgeError({ status: 429, message: "Too many requests" })).toBe("rate_limited");
  });
  it("classifies 5xx as upstream_5xx", () => {
    expect(classifyJudgeError({ status: 503, message: "Service unavailable" })).toBe("upstream_5xx");
  });
  it("classifies 5xx with embedded 429 as rate_limited", () => {
    expect(classifyJudgeError({ status: 500, message: "Resource exhausted (429)" })).toBe("rate_limited");
  });
  it("classifies 400 with context-window message as context_too_large", () => {
    expect(classifyJudgeError({ status: 400, message: "context length exceeded maximum 8192 tokens" })).toBe(
      "context_too_large",
    );
    expect(classifyJudgeError({ status: 400, message: "request too long" })).toBe("context_too_large");
    expect(classifyJudgeError({ status: 400, message: "context window exhausted" })).toBe("context_too_large");
  });
  it("classifies generic 400 as provider_error", () => {
    expect(classifyJudgeError({ status: 400, message: "bad request" })).toBe("provider_error");
  });
  it("classifies network failure (no status) as provider_error", () => {
    expect(classifyJudgeError({ status: 0, message: "fetch failed" })).toBe("provider_error");
  });
});

describe("formatErrorReason", () => {
  it("formats auth_error with hint", () => {
    expect(formatErrorReason("auth_error", "401 Unauthorized")).toContain("auth");
    expect(formatErrorReason("auth_error", "401 Unauthorized")).toContain("API key");
  });
  it("formats context_too_large with [D]-fallback hint", () => {
    expect(formatErrorReason("context_too_large", "context window")).toContain("[D]");
  });
});
