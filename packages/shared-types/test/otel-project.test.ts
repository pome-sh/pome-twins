// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  OTEL_PROJECTION_KEYS,
  otelAttributeValueSchema,
  projectAttributes,
} from "../src/otel/project.js";

describe("projectAttributes", () => {
  it("projects canonical GenAI + HTTP attributes onto flat fields", () => {
    const p = projectAttributes({
      "gen_ai.provider.name": "openai",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-4",
      "gen_ai.agent.name": "writer",
      "gen_ai.agent.id": "agent_1",
      "gen_ai.tool.name": "create_issue",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 8,
      "http.request.method": "POST",
      "http.response.status_code": 201,
      "url.full": "https://x/y?z=1",
      "url.path": "/y",
      "server.address": "x",
      "server.port": 8443,
      "error.type": "timeout",
    });
    expect(p.gen_ai_provider_name).toBe("openai");
    expect(p.gen_ai_request_model).toBe("gpt-4");
    expect(p.gen_ai_agent_name).toBe("writer");
    expect(p.gen_ai_agent_id).toBe("agent_1");
    expect(p.gen_ai_tool_name).toBe("create_issue");
    expect(p.gen_ai_usage_input_tokens).toBe(12);
    expect(p.gen_ai_usage_output_tokens).toBe(8);
    expect(p.http_request_method).toBe("POST");
    expect(p.http_response_status_code).toBe(201);
    expect(p.url_full).toBe("https://x/y?z=1");
    expect(p.url_path).toBe("/y");
    expect(p.server_address).toBe("x");
    expect(p.server_port).toBe(8443);
    expect(p.error_type).toBe("timeout");
  });

  it("falls back to deprecated/pre-1.27 aliases (system, prompt/completion tokens)", () => {
    const p = projectAttributes({
      "gen_ai.system": "anthropic",
      "gen_ai.usage.prompt_tokens": 5,
      "gen_ai.usage.completion_tokens": 6,
    });
    expect(p.gen_ai_provider_name).toBe("anthropic");
    expect(p.gen_ai_usage_input_tokens).toBe(5);
    expect(p.gen_ai_usage_output_tokens).toBe(6);
  });

  it("falls back to the OpenInference vocabulary (LangChain / LangGraph)", () => {
    // What @arizeai/openinference-instrumentation-langchain emits on an LLM span.
    const p = projectAttributes({
      "openinference.span.kind": "LLM",
      "llm.model_name": "claude-sonnet-4-5",
      "llm.provider": "anthropic",
      "llm.token_count.prompt": 42,
      "llm.token_count.completion": 8,
    });
    expect(p.gen_ai_request_model).toBe("claude-sonnet-4-5");
    expect(p.gen_ai_provider_name).toBe("anthropic");
    expect(p.gen_ai_usage_input_tokens).toBe(42);
    expect(p.gen_ai_usage_output_tokens).toBe(8);
  });

  it("projects the OpenInference bare tool.name onto gen_ai_tool_name", () => {
    const p = projectAttributes({
      "openinference.span.kind": "TOOL",
      "tool.name": "merge_pull_request",
    });
    expect(p.gen_ai_tool_name).toBe("merge_pull_request");
  });

  it("falls back to llm.system when llm.provider is absent", () => {
    const p = projectAttributes({ "llm.system": "openai" });
    expect(p.gen_ai_provider_name).toBe("openai");
  });

  it("prefers canonical gen_ai.* over the OpenInference aliases", () => {
    const p = projectAttributes({
      "gen_ai.request.model": "gpt-4",
      "llm.model_name": "claude-sonnet-4-5",
      "gen_ai.provider.name": "openai",
      "llm.provider": "anthropic",
      "gen_ai.usage.input_tokens": 1,
      "llm.token_count.prompt": 99,
    });
    expect(p.gen_ai_request_model).toBe("gpt-4");
    expect(p.gen_ai_provider_name).toBe("openai");
    expect(p.gen_ai_usage_input_tokens).toBe(1);
  });

  it("prefers canonical names over aliases", () => {
    const p = projectAttributes({
      "gen_ai.provider.name": "azure",
      "gen_ai.system": "openai",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.prompt_tokens": 999,
    });
    expect(p.gen_ai_provider_name).toBe("azure");
    expect(p.gen_ai_usage_input_tokens).toBe(1);
  });

  it("projects everything to null for an empty bag", () => {
    const p = projectAttributes({});
    for (const key of OTEL_PROJECTION_KEYS) {
      expect(p[key]).toBeNull();
    }
  });

  it("rejects wrong-typed / out-of-domain values (string token, negative port, float status)", () => {
    const p = projectAttributes({
      "gen_ai.provider.name": 7 as never, // wrong type → null
      "gen_ai.usage.input_tokens": -1, // negative → null
      "server.port": -8, // negative → null
      "http.response.status_code": 200.5, // non-integer → null
    });
    expect(p.gen_ai_provider_name).toBeNull();
    expect(p.gen_ai_usage_input_tokens).toBeNull();
    expect(p.server_port).toBeNull();
    expect(p.http_response_status_code).toBeNull();
  });
});

describe("otelAttributeValueSchema", () => {
  it("accepts finite primitives and homogeneous primitive arrays", () => {
    expect(otelAttributeValueSchema.safeParse("s").success).toBe(true);
    expect(otelAttributeValueSchema.safeParse(1.5).success).toBe(true);
    expect(otelAttributeValueSchema.safeParse(false).success).toBe(true);
    expect(otelAttributeValueSchema.safeParse([1, "a", true]).success).toBe(true);
  });

  it("rejects non-finite numbers and nested objects", () => {
    expect(otelAttributeValueSchema.safeParse(Infinity).success).toBe(false);
    expect(otelAttributeValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(otelAttributeValueSchema.safeParse({ k: 1 }).success).toBe(false);
    expect(otelAttributeValueSchema.safeParse([Infinity]).success).toBe(false);
  });
});

describe("OTEL_PROJECTION_KEYS", () => {
  it("matches the projectAttributes output keys exactly", () => {
    expect(new Set(Object.keys(projectAttributes({})))).toEqual(new Set(OTEL_PROJECTION_KEYS));
  });
});
