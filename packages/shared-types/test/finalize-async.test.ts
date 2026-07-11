import { describe, expect, it } from "vitest";
import {
  finalizeAcceptedResponseSchema,
  finalizeInitialResponseSchema,
  finalizeStatusResponseSchema,
} from "../src/index.js";

const legacyResult = {
  run_id: "run_123",
  score: 87,
  judge_model: "google/gemini-2.5-flash",
  dashboard_url: "https://app.pome.sh/runs/run_123",
};

describe("asynchronous finalize schemas", () => {
  it("accepts the frozen accepted response and legacy scored fallback", () => {
    const accepted = {
      evaluation_id: "ev_123",
      run_id: "run_123",
      status: "queued",
      status_url: "https://api.pome.sh/v1/sessions/ses_123/evaluation",
    };

    expect(finalizeAcceptedResponseSchema.parse(accepted)).toEqual(accepted);
    expect(finalizeInitialResponseSchema.parse(accepted)).toEqual(accepted);
    expect(finalizeInitialResponseSchema.parse(legacyResult)).toEqual(legacyResult);
  });

  it.each([
    { evaluation_id: "ev_123", run_id: "run_123", status: "queued" },
    { evaluation_id: "ev_123", run_id: "run_123", status: "running" },
    {
      evaluation_id: "ev_123",
      run_id: "run_123",
      status: "failed",
      error: { code: "judge_unavailable", message: "try again", retryable: true },
    },
    {
      evaluation_id: "ev_123",
      run_id: "run_123",
      status: "completed",
      result: legacyResult,
    },
  ])("accepts status payload $status", (payload) => {
    expect(finalizeStatusResponseSchema.parse(payload)).toEqual(payload);
  });

  it("rejects unknown properties and malformed discriminated branches", () => {
    expect(() =>
      finalizeAcceptedResponseSchema.parse({
        evaluation_id: "ev_123",
        run_id: "run_123",
        status: "queued",
        status_url: "https://api.pome.sh/v1/sessions/ses_123/evaluation",
        extra: true,
      }),
    ).toThrow();

    expect(() =>
      finalizeStatusResponseSchema.parse({
        evaluation_id: "ev_123",
        run_id: "run_123",
        status: "failed",
      }),
    ).toThrow();

    expect(() =>
      finalizeStatusResponseSchema.parse({
        evaluation_id: "ev_123",
        run_id: "run_123",
        status: "completed",
        result: legacyResult,
        error: { code: "impossible", message: "wrong branch", retryable: false },
      }),
    ).toThrow();
  });
});
