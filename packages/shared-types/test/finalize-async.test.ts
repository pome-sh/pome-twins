import { describe, expect, it } from "vitest";
import {
  finalizeAcceptedResponseSchema,
  finalizeInitialResponseSchema,
  finalizeResponseSchema,
  finalizeStatusResponseSchema,
} from "../src/index.js";

const legacyResult = {
  run_id: "run_123",
  score: 87,
  judge_model: "google/gemini-2.5-flash",
  dashboard_url: "https://app.pome.sh/runs/run_123",
};

describe("asynchronous finalize schemas", () => {
  it("accepts relative and absolute status_url on the accepted response", () => {
    const relative = {
      evaluation_id: "ev_123",
      run_id: "run_123",
      status: "queued" as const,
      status_url: "/v1/sessions/ses_123/evaluation",
    };
    const absolute = {
      ...relative,
      status_url: "https://api.pome.sh/v1/sessions/ses_123/evaluation",
    };

    expect(finalizeAcceptedResponseSchema.parse(relative)).toEqual(relative);
    expect(finalizeAcceptedResponseSchema.parse(absolute)).toEqual(absolute);
    expect(finalizeInitialResponseSchema.parse(relative)).toEqual(relative);
    expect(finalizeInitialResponseSchema.parse(legacyResult)).toEqual(legacyResult);
  });

  it("strips additive M7 keys on scored finalize responses instead of rejecting", () => {
    const withAdditive = {
      ...legacyResult,
      evaluator_version: "m7",
      criteria_breakdown: [],
      all_skipped: false,
      provenance: "upload",
    };
    expect(finalizeResponseSchema.parse(withAdditive)).toEqual(legacyResult);
  });

  it.each([
    { evaluation_id: "ev_123", run_id: "run_123", status: "queued" },
    { evaluation_id: "ev_123", run_id: "run_123", status: "running" },
    {
      evaluation_id: "ev_123",
      run_id: "run_123",
      status: "failed",
      error: {
        type: "evaluation_failed",
        message: "bad trace",
        details: { reason: "invalid_otel" },
      },
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
        status_url: "/v1/sessions/ses_123/evaluation",
        extra: true,
      }),
    ).toThrow();

    expect(() =>
      finalizeAcceptedResponseSchema.parse({
        evaluation_id: "ev_123",
        run_id: "run_123",
        status: "queued",
        status_url: "//evil.example/evaluation",
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
        status: "failed",
        error: { code: "legacy", message: "wrong shape", retryable: true },
      }),
    ).toThrow();

    expect(() =>
      finalizeStatusResponseSchema.parse({
        evaluation_id: "ev_123",
        run_id: "run_123",
        status: "completed",
        result: legacyResult,
        error: { type: "impossible", message: "wrong branch" },
      }),
    ).toThrow();
  });
});
