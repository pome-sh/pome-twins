// SPDX-License-Identifier: Apache-2.0
//
// M3 multi-twin wire contract — additive, zero-breaking schema changes across
// rest.ts / run.ts / seed-envelope.ts. Every field added here is optional, so
// the assertions below double as back-compat proof: the same payloads parse
// with and without the new keys.

import { describe, expect, it } from "vitest";
import { criterionSchema } from "../src/run.js";
import {
  agentResponseSchema,
  createAgentRequestSchema,
  createSessionResponseSchema,
  criterionDefSchema,
  finalizeRequestSchema,
  isMultiTwinSeedEnvelope,
  perTwinStateKeysSchema,
  seedEnvelopeSchema,
  stateUploadUrlResponseSchema,
} from "../src/index.js";

describe("criterionSchema.twin (run.ts) — rides the D/P→code/model transform", () => {
  it("parses code/model criteria with an explicit twin", () => {
    expect(criterionSchema.parse({ type: "code", text: "refund exists", twin: "stripe" }))
      .toEqual({ type: "code", text: "refund exists", twin: "stripe" });
    expect(criterionSchema.parse({ type: "model", text: "polite reply", twin: "slack" }))
      .toEqual({ type: "model", text: "polite reply", twin: "slack" });
  });

  it("normalizes 0.3.0 D/P spellings while carrying twin through untouched", () => {
    expect(criterionSchema.parse({ type: "D", text: "PR merged", twin: "github" }))
      .toEqual({ type: "code", text: "PR merged", twin: "github" });
    expect(criterionSchema.parse({ type: "P", text: "summary reads well", twin: "github" }))
      .toEqual({ type: "model", text: "summary reads well", twin: "github" });
  });

  it("still parses without twin (single-twin default = primary twin)", () => {
    expect(criterionSchema.parse({ type: "D", text: "x" }))
      .toEqual({ type: "code", text: "x" });
  });
});

describe("criterionDefSchema.twin (rest.ts)", () => {
  it("accepts an optional twin on a scenario criterion def", () => {
    expect(criterionDefSchema.parse({ id: "c1", text: "t", kind: "D", twin: "stripe" }))
      .toEqual({ id: "c1", text: "t", kind: "D", twin: "stripe" });
  });

  it("parses without twin unchanged", () => {
    expect(criterionDefSchema.parse({ id: "c1", text: "t", kind: "P" }))
      .toEqual({ id: "c1", text: "t", kind: "P" });
  });
});

describe("perTwinStateKeysSchema", () => {
  it("parses a per-twin map of optional initial/final storage keys", () => {
    const value = {
      github: { state_initial_key: "k/gh/init", state_final_key: "k/gh/final" },
      stripe: { state_final_key: "k/st/final" },
    };
    expect(perTwinStateKeysSchema.parse(value)).toEqual(value);
  });

  it("accepts an empty map", () => {
    expect(perTwinStateKeysSchema.parse({})).toEqual({});
  });
});

describe("seedEnvelopeSchema + isMultiTwinSeedEnvelope — THE RULE", () => {
  it("parses a per-twin envelope of flat, shape-blind seeds", () => {
    const envelope = {
      github: { repositories: [{ owner: "acme", name: "server" }] },
      stripe: { customers: [{ id: "cus_1" }], unknown_future: { a: 1 } },
    };
    expect(seedEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects a non-object per-twin value", () => {
    expect(seedEnvelopeSchema.safeParse({ github: [1, 2, 3] }).success).toBe(false);
  });

  it("decides envelope-vs-flat from twins.length alone (no shape-sniffing)", () => {
    expect(isMultiTwinSeedEnvelope(["github"])).toBe(false);
    expect(isMultiTwinSeedEnvelope(["github", "stripe"])).toBe(true);
    expect(isMultiTwinSeedEnvelope(["github", "stripe", "slack"])).toBe(true);
  });
});

describe("createAgentRequestSchema", () => {
  it("accepts a name plus an optional twins allowlist", () => {
    expect(createAgentRequestSchema.parse({ name: "viktor", twins: ["github", "stripe"] }))
      .toEqual({ name: "viktor", twins: ["github", "stripe"] });
  });

  it("parses a name-only request unchanged (older clients)", () => {
    expect(createAgentRequestSchema.parse({ name: "viktor" })).toEqual({ name: "viktor" });
  });

  it("rejects an empty twins allowlist (min(1))", () => {
    expect(createAgentRequestSchema.safeParse({ name: "viktor", twins: [] }).success).toBe(false);
  });
});

describe("agentResponseSchema", () => {
  it("carries an optional enabled_services list and strips unknown keys", () => {
    const parsed = agentResponseSchema.parse({
      id: "agt_1",
      slug: "viktor",
      display_name: "Viktor",
      judge_model: "google/gemini-2.5-flash",
      enabled_services: ["github", "stripe"],
      unknown_future: true,
    });
    expect(parsed).toEqual({
      id: "agt_1",
      slug: "viktor",
      display_name: "Viktor",
      judge_model: "google/gemini-2.5-flash",
      enabled_services: ["github", "stripe"],
    });
  });

  it("parses without enabled_services (older cloud)", () => {
    const parsed = agentResponseSchema.parse({
      id: "agt_1",
      slug: "viktor",
      display_name: "Viktor",
      judge_model: "m",
    });
    expect(parsed.enabled_services).toBeUndefined();
  });
});

describe("stateUploadUrlResponseSchema", () => {
  const pair = {
    state_initial: { url: "https://s3.example.com/put/init", key: "k/init" },
    state_final: { url: "https://s3.example.com/put/final", key: "k/final" },
  };

  it("parses the flat single-twin pair (legacy / older cloud)", () => {
    expect(stateUploadUrlResponseSchema.parse(pair)).toEqual(pair);
  });

  it("parses an additive per_twin map of pairs", () => {
    const value = { ...pair, per_twin: { github: pair, stripe: pair } };
    expect(stateUploadUrlResponseSchema.parse(value)).toEqual(value);
  });
});

describe("finalizeRequestSchema.per_twin_state_keys (finalize-shapes.ts) — LIVE scoring wire", () => {
  const base = {
    stop_reason: "completed",
    exit_code: 0,
    duration_ms: 1200,
    agent_model: "sonnet",
    agent_sdk: null,
    criteria: [{ id: "c1", text: "PR merged", kind: "D" as const, twin: "github" }],
    scenario_name: "viktor/mvp",
    scenario_hash: "abc123",
    scenario_prompt: "ship the MVP",
    expected_behavior: "opens and merges a PR",
  };

  it("parses without per_twin_state_keys (single-twin / older CLI)", () => {
    const parsed = finalizeRequestSchema.parse(base);
    expect(parsed.per_twin_state_keys).toBeUndefined();
  });

  it("parses with an additive per_twin_state_keys map (multi-twin / new CLI)", () => {
    const parsed = finalizeRequestSchema.parse({
      ...base,
      state_initial_storage_key: "k/init",
      state_final_storage_key: "k/final",
      per_twin_state_keys: {
        github: { state_initial_key: "k/gh/init", state_final_key: "k/gh/final" },
        stripe: { state_final_key: "k/st/final" },
      },
    });
    expect(parsed.scenario_name).toBe("viktor/mvp");
    expect(parsed.per_twin_state_keys).toEqual({
      github: { state_initial_key: "k/gh/init", state_final_key: "k/gh/final" },
      stripe: { state_final_key: "k/st/final" },
    });
  });
});

describe("createSessionResponseSchema — legacy (no per_twin) still normalizes", () => {
  it("synthesizes per_twin + session_token from single-twin fields", () => {
    const parsed = createSessionResponseSchema.parse({
      session_id: "ses_1",
      twin_url: "https://api.pome.sh/github/ses_1",
      openapi_url: "https://api.pome.sh/github/ses_1/openapi.json",
      agent_token: "edt_tok",
      expires_at: "2026-07-13T12:00:00.000Z",
    });
    expect(parsed.session_token).toBe("ses_1");
    expect(parsed.per_twin.github).toEqual({
      api_url: "https://api.pome.sh/github/ses_1",
      mcp_url: "https://mcp.pome.sh/github/ses_1",
      openapi_url: "https://api.pome.sh/github/ses_1/openapi.json",
    });
    expect(parsed.provider_credentials).toEqual({});
  });
});
