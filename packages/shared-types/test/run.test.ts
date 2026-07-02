// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  criterionSchema,
  judgeModelSchema,
  laneSchema,
  runSchema,
  stepSchema,
} from "../src/run.js";
import { submitResultRequestSchema } from "../src/index.js";

describe("stepSchema", () => {
  it("parses a Step with lane_ids and a populated label", () => {
    const r = stepSchema.parse({
      id: "stp_1",
      started_at: "2026-05-11T12:00:00.000Z",
      ended_at: "2026-05-11T12:00:05.000Z",
      label: "tried to refund charge ch_123",
      lane_ids: ["ln_1", "ln_2"],
    });
    expect(r.lane_ids).toEqual(["ln_1", "ln_2"]);
    expect(r.label).toBe("tried to refund charge ch_123");
  });

  it("accepts null label (heuristic-correlator output without assistant message)", () => {
    const r = stepSchema.parse({
      id: "stp_1",
      started_at: "2026-05-11T12:00:00.000Z",
      ended_at: "2026-05-11T12:00:05.000Z",
      label: null,
      lane_ids: [],
    });
    expect(r.label).toBeNull();
  });

  it("rejects non-datetime started_at", () => {
    expect(() =>
      stepSchema.parse({
        id: "stp_1",
        started_at: "not-a-date",
        ended_at: "2026-05-11T12:00:05.000Z",
        label: null,
        lane_ids: [],
      })
    ).toThrow();
  });
});

describe("laneSchema", () => {
  it("parses a Lane with twin + request_ids + populated label", () => {
    const r = laneSchema.parse({
      id: "ln_1",
      step_id: "stp_1",
      twin: "stripe",
      label: "POST /v1/refunds (3 calls)",
      request_ids: ["req_1", "req_2", "req_3"],
    });
    expect(r.request_ids).toEqual(["req_1", "req_2", "req_3"]);
    expect(r.label).toBe("POST /v1/refunds (3 calls)");
    expect(r.twin).toBe("stripe");
  });

  it("accepts null label", () => {
    const r = laneSchema.parse({
      id: "ln_1",
      step_id: "stp_1",
      twin: "github",
      label: null,
      request_ids: ["req_1"],
    });
    expect(r.label).toBeNull();
  });

  it("twin is open string (SDK community-twin compatible)", () => {
    const r = laneSchema.parse({
      id: "ln_1",
      step_id: "stp_1",
      twin: "linear",
      label: null,
      request_ids: [],
    });
    expect(r.twin).toBe("linear");
  });
});

describe("criterionSchema + judgeModelSchema (moved from old scenarios section into run.ts)", () => {
  it("criterionSchema parses {type: 'D', text}", () => {
    const r = criterionSchema.parse({ type: "D", text: "label was added" });
    expect(r.type).toBe("D");
  });

  it("criterionSchema parses {type: 'P', text}", () => {
    const r = criterionSchema.parse({ type: "P", text: "response is polite" });
    expect(r.type).toBe("P");
  });

  it("judgeModelSchema accepts any non-empty string", () => {
    expect(judgeModelSchema.parse("claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(judgeModelSchema.parse("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("judgeModelSchema rejects empty string", () => {
    expect(() => judgeModelSchema.parse("")).toThrow();
  });
});

const baseRun = {
  id: "run_abc",
  session_id: "ses_123",
  team_id: "tm_1",
  scenario_name: "stripe-refund-retry",
  scenario_hash: "abc",
  satisfaction_score: 100,
  criteria_results: [],
  trace_s3_key: null,
  state_s3_key: null,
  meta_s3_key: null,
  duration_ms: 5000,
  agent_model: "claude-sonnet-4-6",
  judge_model: "claude-haiku-4-5",
  judge_tokens_in: 100,
  judge_tokens_out: 200,
  created_at: "2026-05-11T12:00:00.000Z",
  finished_at: "2026-05-11T12:00:05.000Z",
};

describe("runSchema (new fields)", () => {
  it("parses Run with lanes/steps/fix_prompt/events_jsonl_url populated", () => {
    const r = runSchema.parse({
      ...baseRun,
      lanes: [
        {
          id: "ln_1",
          step_id: "stp_1",
          twin: "stripe",
          label: null,
          request_ids: ["req_1"],
        },
      ],
      steps: [
        {
          id: "stp_1",
          started_at: "2026-05-11T12:00:00.000Z",
          ended_at: "2026-05-11T12:00:05.000Z",
          label: null,
          lane_ids: ["ln_1"],
        },
      ],
      fix_prompt: "## Suggested fix\nadd idempotency key",
      events_jsonl_url: "https://s3.example.com/run_abc/events.jsonl",
    });
    expect(r.lanes).toHaveLength(1);
    expect(r.steps).toHaveLength(1);
    expect(r.fix_prompt).toContain("Suggested fix");
    expect(r.events_jsonl_url).toContain("events.jsonl");
  });

  it("legacy run: missing lanes/steps/fix_prompt/events_jsonl_url all default to empty/null", () => {
    const r = runSchema.parse(baseRun);
    expect(r.lanes).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.fix_prompt).toBeNull();
    expect(r.events_jsonl_url).toBeNull();
  });

  it("fix_prompt accepts null (--no-fix-prompt opt-out or LLM endpoint failure)", () => {
    const r = runSchema.parse({ ...baseRun, fix_prompt: null });
    expect(r.fix_prompt).toBeNull();
  });

  it("events_jsonl_url accepts null (self-host mode or --no-upload)", () => {
    const r = runSchema.parse({ ...baseRun, events_jsonl_url: null });
    expect(r.events_jsonl_url).toBeNull();
  });

  it("accepts a storage-key events_jsonl_url (FDRS-613: relaxed from .url() to match pome-cloud)", () => {
    const r = runSchema.parse({
      ...baseRun,
      events_jsonl_url: "team-tm_1/session-ses_123/events.jsonl",
    });
    expect(r.events_jsonl_url).toBe("team-tm_1/session-ses_123/events.jsonl");
  });

  it("defaults FDRS-613 reconciled fields (correlator_kind/environment/agent telemetry/summary)", () => {
    const r = runSchema.parse(baseRun);
    expect(r.correlator_kind).toBe("heuristic");
    expect(r.environment).toBe("simulation");
    expect(r.promoted_scenario_id).toBeNull();
    expect(r.replay_run_id).toBeNull();
    expect(r.state_archive_s3_key).toBeNull();
    expect(r.agent_tokens_in).toBeNull();
    expect(r.summary).toBeNull();
  });
});

const baseSubmit = {
  scenario_name: "stripe-refund-retry",
  scenario_hash: "abc",
  duration_ms: 5000,
  agent_model: "claude-sonnet-4-6",
  satisfaction_score: 100,
  criteria_results: [],
  judge_model: "claude-haiku-4-5",
  judge_tokens_in: 0,
  judge_tokens_out: 0,
  trace_jsonl_b64: "",
  state_initial_json_b64: "",
  state_final_json_b64: "",
};

describe("submitResultRequestSchema (new fields)", () => {
  it("accepts lanes / steps / fix_prompt from a post-M3i CLI", () => {
    const r = submitResultRequestSchema.parse({
      ...baseSubmit,
      lanes: [],
      steps: [],
      fix_prompt: "## Suggested fix\n...",
    });
    expect(r.lanes).toEqual([]);
    expect(r.fix_prompt).toBe("## Suggested fix\n...");
  });

  it("defaults lanes=[]/steps=[]/fix_prompt=null when older pre-M3i CLI omits them", () => {
    const r = submitResultRequestSchema.parse(baseSubmit);
    expect(r.lanes).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.fix_prompt).toBeNull();
  });

  it("fix_prompt accepts null (--no-fix-prompt opt-out)", () => {
    const r = submitResultRequestSchema.parse({
      ...baseSubmit,
      lanes: [],
      steps: [],
      fix_prompt: null,
    });
    expect(r.fix_prompt).toBeNull();
  });
});
