// SPDX-License-Identifier: Apache-2.0
//
// FDRS-653 — W3 "scenario → task" wire vocabulary behind a tolerant reader.
//
// Contract under test:
//   - Canonical schemas/types use the NEW vocabulary (task_*, code|model).
//   - Readers accept BOTH old and new keys and normalize to new.
//   - Nothing a 0.3.0-era artifact contains becomes invalid.
//   - When both keys are present, the new key wins.
import { describe, expect, it } from "vitest";
import {
  LEGACY_CRITERION_KIND_MAP,
  LEGACY_TASK_VOCAB_KEY_MAP,
  normalizeTaskVocabKeys,
} from "../src/task-vocab.js";
import {
  CRITERION_KINDS,
  criterionKindSchema,
  criterionResultSchema,
  criterionSchema,
  runSchema,
} from "../src/run.js";
import {
  createSessionRequestSchema,
  persistedScenarioSchema,
  persistedTaskSchema,
  scenarioConfigSchema,
  scenarioSchema,
  submitResultRequestSchema,
  taskConfigSchema,
  taskSchema,
} from "../src/index.js";
import { eventSchema, recorderEventSchema } from "../src/recorder-events.js";

// ─── normalizeTaskVocabKeys (the raw key mapper) ─────────────────────────────

describe("normalizeTaskVocabKeys", () => {
  it("renames every legacy key in the map", () => {
    const input = Object.fromEntries(
      Object.keys(LEGACY_TASK_VOCAB_KEY_MAP).map((k, i) => [k, `v${i}`]),
    );
    const out = normalizeTaskVocabKeys(input) as Record<string, unknown>;
    for (const [legacy, canonical] of Object.entries(LEGACY_TASK_VOCAB_KEY_MAP)) {
      expect(out).not.toHaveProperty(legacy);
      expect(out[canonical]).toBe(input[legacy]);
    }
  });

  it("leaves objects without legacy keys untouched (same reference)", () => {
    const input = { task_name: "t", other: 1 };
    expect(normalizeTaskVocabKeys(input)).toBe(input);
  });

  it("new key wins when both are present; legacy key is dropped", () => {
    const out = normalizeTaskVocabKeys({
      scenario_name: "old",
      task_name: "new",
    }) as Record<string, unknown>;
    expect(out.task_name).toBe("new");
    expect(out).not.toHaveProperty("scenario_name");
  });

  it("passes non-objects through for the schema to report the real error", () => {
    expect(normalizeTaskVocabKeys(null)).toBeNull();
    expect(normalizeTaskVocabKeys("x")).toBe("x");
    expect(normalizeTaskVocabKeys([1])).toEqual([1]);
  });

  it("does not mutate its input", () => {
    const input = { scenario_name: "old" };
    normalizeTaskVocabKeys(input);
    expect(input).toEqual({ scenario_name: "old" });
  });

  it("leaves scenario_step_id intact — event rows have PRESERVE semantics, not rename-and-delete", () => {
    // Regression pin (FDRS-653 review): scenario_step_id must NOT be in
    // LEGACY_TASK_VOCAB_KEY_MAP. If it were, applying this helper to an
    // events.jsonl row (e.g. from the FDRS-654 cloud consumer work) would
    // silently strip the frozen-v1 step linkage. Event-row normalization is
    // recorderEventSchema/eventSchema's job (preserve + populate task_step_id).
    expect(LEGACY_TASK_VOCAB_KEY_MAP).not.toHaveProperty("scenario_step_id");
    const eventLikeRow = {
      scenario_step_id: "step-2",
      scenario_name: "still-renamed", // run/session keys still normalize
      request_id: "req_1",
    };
    const out = normalizeTaskVocabKeys(eventLikeRow) as Record<string, unknown>;
    expect(out.scenario_step_id).toBe("step-2");
    expect(out).not.toHaveProperty("task_step_id");
    expect(out.task_name).toBe("still-renamed");
  });
});

// ─── criterion kind: D|P → code|model ────────────────────────────────────────

describe("criterion kind vocabulary", () => {
  it("canonical enum is code|model", () => {
    expect(CRITERION_KINDS).toEqual(["code", "model"]);
    expect(criterionKindSchema.parse("code")).toBe("code");
    expect(criterionKindSchema.parse("model")).toBe("model");
    expect(criterionKindSchema.safeParse("D").success).toBe(false);
  });

  it("legacy kind map matches the W3 decision", () => {
    expect(LEGACY_CRITERION_KIND_MAP).toEqual({ D: "code", P: "model" });
  });

  it("criterionSchema normalizes D→code and P→model", () => {
    expect(criterionSchema.parse({ type: "D", text: "row exists" }).type).toBe("code");
    expect(criterionSchema.parse({ type: "P", text: "is polite" }).type).toBe("model");
  });

  it("criterionSchema round-trips code|model", () => {
    expect(criterionSchema.parse({ type: "code", text: "x" }).type).toBe("code");
    expect(criterionSchema.parse({ type: "model", text: "x" }).type).toBe("model");
  });

  it("criterionSchema rejects unknown kinds", () => {
    expect(criterionSchema.safeParse({ type: "llm", text: "x" }).success).toBe(false);
  });

  it("criterionResultSchema keeps [model]-only fields through the union after normalization", () => {
    const parsed = criterionResultSchema.parse({
      criterion: { type: "P", text: "is polite" },
      passed: true,
      skipped: false,
      reason: "tone ok",
      confidence: 0.9,
      judge_model: "claude-haiku-4-5",
    });
    expect(parsed.criterion.type).toBe("model");
    expect("confidence" in parsed && parsed.confidence).toBe(0.9);
  });

  it("criterionResultSchema routes a legacy D-kind result to the deterministic arm", () => {
    const parsed = criterionResultSchema.parse({
      criterion: { type: "D", text: "label added" },
      passed: false,
      skipped: false,
      reason: "label missing",
    });
    expect(parsed.criterion.type).toBe("code");
    expect("confidence" in parsed).toBe(false);
  });
});

// ─── runSchema ───────────────────────────────────────────────────────────────

const baseRunNewVocab = {
  id: "run_abc",
  session_id: "ses_123",
  team_id: "tm_1",
  task_name: "stripe-refund-retry",
  task_hash: "abc",
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

describe("runSchema task vocabulary", () => {
  it("accepts a 0.3.0-era row (scenario_*) and normalizes to task_*", () => {
    const { task_name, task_hash, ...rest } = baseRunNewVocab;
    const r = runSchema.parse({
      ...rest,
      scenario_name: task_name,
      scenario_hash: task_hash,
      promoted_scenario_id: "scn_p1",
    });
    expect(r.task_name).toBe("stripe-refund-retry");
    expect(r.task_hash).toBe("abc");
    expect(r.promoted_task_id).toBe("scn_p1");
    expect(r).not.toHaveProperty("scenario_name");
    expect(r).not.toHaveProperty("scenario_hash");
    expect(r).not.toHaveProperty("promoted_scenario_id");
  });

  it("accepts a new-vocab row unchanged", () => {
    const r = runSchema.parse(baseRunNewVocab);
    expect(r.task_name).toBe("stripe-refund-retry");
    expect(r.promoted_task_id).toBeNull();
  });

  it("new key wins when a row carries both vocabularies", () => {
    const r = runSchema.parse({
      ...baseRunNewVocab,
      scenario_name: "stale-old-name",
    });
    expect(r.task_name).toBe("stripe-refund-retry");
  });

  it("rejects a row with neither task_name nor scenario_name", () => {
    const { task_name: _omit, ...rest } = baseRunNewVocab;
    expect(runSchema.safeParse(rest).success).toBe(false);
  });
});

// ─── submitResultRequestSchema ───────────────────────────────────────────────

const baseSubmitNewVocab = {
  task_name: "stripe-refund-retry",
  task_hash: "abc",
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

describe("submitResultRequestSchema task vocabulary", () => {
  it("accepts a 0.3.0 CLI submit (scenario_* + D/P criteria) and normalizes", () => {
    const { task_name, task_hash, ...rest } = baseSubmitNewVocab;
    const r = submitResultRequestSchema.parse({
      ...rest,
      scenario_name: task_name,
      scenario_hash: task_hash,
      criteria_results: [
        {
          criterion: { type: "D", text: "label added" },
          passed: true,
          skipped: false,
          reason: "ok",
        },
      ],
    });
    expect(r.task_name).toBe("stripe-refund-retry");
    expect(r.task_hash).toBe("abc");
    expect(r.criteria_results[0]!.criterion.type).toBe("code");
    expect(r).not.toHaveProperty("scenario_name");
  });

  it("accepts a new-vocab submit unchanged", () => {
    const r = submitResultRequestSchema.parse(baseSubmitNewVocab);
    expect(r.task_name).toBe("stripe-refund-retry");
  });
});

// ─── createSessionRequestSchema ──────────────────────────────────────────────

describe("createSessionRequestSchema task vocabulary", () => {
  it("accepts 0.3.0 scenario_source and normalizes to task_source", () => {
    const r = createSessionRequestSchema.parse({
      twins: ["github"],
      scenario_source: "Zg==",
    });
    expect(r.task_source).toBe("Zg==");
    expect(r).not.toHaveProperty("scenario_source");
  });

  it("accepts 0.3.0 scenario_id and normalizes to task_id", () => {
    const r = createSessionRequestSchema.parse({ scenario_id: "scn_1" });
    expect(r.task_id).toBe("scn_1");
    expect(r.twins).toEqual(["github"]);
  });

  it("accepts new-vocab task_source / task_id", () => {
    expect(createSessionRequestSchema.parse({ task_source: "Zg==" }).task_source).toBe("Zg==");
    expect(createSessionRequestSchema.parse({ task_id: "scn_1" }).task_id).toBe("scn_1");
  });

  it("still enforces exactly-one across BOTH vocabularies", () => {
    // old source + new id → two sources of task → reject
    expect(
      createSessionRequestSchema.safeParse({
        scenario_source: "Zg==",
        task_id: "scn_1",
      }).success,
    ).toBe(false);
    // neither → reject
    expect(createSessionRequestSchema.safeParse({ twins: ["github"] }).success).toBe(false);
    // legacy pair (source + id, old keys) → reject, same as 0.3.0 behavior
    expect(
      createSessionRequestSchema.safeParse({
        scenario_source: "Zg==",
        scenario_id: "scn_1",
      }).success,
    ).toBe(false);
  });
});

// ─── recorder events: task_step_id ───────────────────────────────────────────

const legacyRecorderRow = {
  ts: "2026-05-26T12:00:00.000Z",
  run_id: "run_abc",
  twin: "github",
  request_id: "req_123",
  scenario_step_id: "step-2",
  step_id: null,
  tool_call_id: null,
  method: "POST",
  path: "/repos/o/r/issues",
  request_body: {},
  status: 201,
  response_body: { id: 1 },
  latency_ms: 42,
  fidelity: "semantic",
  state_mutation: true,
  state_delta: { before: null, after: { id: 1 } },
  error: null,
};

describe("recorder events task_step_id vocabulary", () => {
  it("recorderEventSchema: 0.3.0 scenario_step_id populates task_step_id (old key preserved as-sent)", () => {
    const r = recorderEventSchema.parse(legacyRecorderRow);
    expect(r.task_step_id).toBe("step-2");
    expect(r.scenario_step_id).toBe("step-2");
  });

  it("recorderEventSchema: new-vocab task_step_id round-trips", () => {
    const { scenario_step_id: _omit, ...rest } = legacyRecorderRow;
    const r = recorderEventSchema.parse({ ...rest, task_step_id: "step-3" });
    expect(r.task_step_id).toBe("step-3");
    expect(r.scenario_step_id).toBeUndefined();
  });

  it("recorderEventSchema: new key wins when both are present", () => {
    const r = recorderEventSchema.parse({
      ...legacyRecorderRow,
      task_step_id: "step-9",
    });
    expect(r.task_step_id).toBe("step-9");
  });

  it("recorderEventSchema: rows with neither key still parse (both optional)", () => {
    const { scenario_step_id: _omit, ...rest } = legacyRecorderRow;
    const r = recorderEventSchema.parse(rest);
    expect(r.task_step_id).toBeUndefined();
  });

  it("eventSchema: TwinHttpEvent rows normalize through the unified union", () => {
    const r = eventSchema.parse({
      ...legacyRecorderRow,
      kind: "TwinHttpEvent",
      event_id: "evt_1",
      parent_id: null,
    });
    expect(r.kind).toBe("TwinHttpEvent");
    if (r.kind === "TwinHttpEvent") {
      expect(r.task_step_id).toBe("step-2");
    }
  });
});

// ─── task* canonical exports + deprecated scenario* aliases ──────────────────

describe("task*/scenario* export aliases", () => {
  it("scenario* exports are referentially identical to the canonical task* exports", () => {
    expect(scenarioSchema).toBe(taskSchema);
    expect(scenarioConfigSchema).toBe(taskConfigSchema);
    expect(persistedScenarioSchema).toBe(persistedTaskSchema);
  });

  it("taskSchema parses a task with legacy D/P criteria and normalizes them", () => {
    const parsed = taskSchema.parse({
      slug: "github-issue-triage",
      title: "Triage the bug",
      prompt: "Triage issue #7",
      criteria: [
        { type: "D", text: "label added" },
        { type: "model", text: "comment is helpful" },
      ],
      config: {},
      seedState: {
        repositories: [{ owner: "acme", name: "server" }],
      },
    });
    expect(parsed.criteria.map((c) => c.type)).toEqual(["code", "model"]);
    expect(parsed.config.judge).toBe("claude-haiku-4-5");
  });
});
