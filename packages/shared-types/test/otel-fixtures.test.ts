// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { mapOtelSpanToEvent } from "../src/otel/map-span.js";
import { otelSpanEventSchema } from "../src/otel/span-event.js";
import {
  getAllSpanInputs,
  getEmitterFixtures,
  getExternalApiFixtures,
  getLegacyFixtureByName,
  getLegacyFixtures,
  getTraceFixtures,
} from "../src/otel/fixtures/index.js";
import { EMITTER_FIXTURES, LEGACY_FIXTURES, TRACE_FIXTURES } from "../src/otel/fixtures/data.js";

// Meta-test: the corpus is the single source of truth for M1.2 + M2–M6, so it
// must stay conformant to the M1.1 schema and structurally sound.

describe("corpus coverage (acceptance criteria)", () => {
  it("has legacy ×3, real emitter ×3, ≥2 multi-span traces, ≥1 external-API span", () => {
    expect(getLegacyFixtures()).toHaveLength(3);
    expect(getEmitterFixtures()).toHaveLength(3);
    expect(getTraceFixtures().length).toBeGreaterThanOrEqual(2);
    expect(getExternalApiFixtures().length).toBeGreaterThanOrEqual(1);
  });

  it("covers all three real emitters with honest provenance metadata", () => {
    const emitters = getEmitterFixtures().map((fixture) => fixture.emitter);
    expect(new Set(emitters)).toEqual(new Set(["traceloop", "vercel-ai-sdk", "pydantic-logfire"]));
    for (const fixture of getEmitterFixtures()) {
      expect(fixture.provenance).toMatch(/^https?:\/\//);
      expect(fixture.sourceVersion.length).toBeGreaterThan(0);
      // The emitter fixtures are documented shapes, NOT live captures — say so.
      expect(fixture.derivedFrom).toBe("documentation-derived");
    }
  });

  it("has ≥2 spans in every multi-span trace fixture", () => {
    for (const trace of getTraceFixtures()) {
      expect(trace.spans.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("the exported corpus is deep-frozen (immutable shared state)", () => {
  it("freezes every fixture family and nested object", () => {
    expect(Object.isFrozen(LEGACY_FIXTURES)).toBe(true);
    expect(Object.isFrozen(EMITTER_FIXTURES)).toBe(true);
    expect(Object.isFrozen(TRACE_FIXTURES)).toBe(true);
    expect(Object.isFrozen(EMITTER_FIXTURES[0]!.span.attributes)).toBe(true);
    expect(Object.isFrozen(LEGACY_FIXTURES[0]!.expected)).toBe(true);
  });

  it("rejects mutation attempts (frozen, in module scope)", () => {
    // Object.freeze makes the write throw in ESM strict mode (runtime guarantee,
    // independent of the static `readonly` typing).
    const attrs = EMITTER_FIXTURES[0]!.span.attributes as Record<string, unknown>;
    expect(() => {
      attrs.x = "y";
    }).toThrow();
  });
});

describe("every normalized span maps + parses under M1.1", () => {
  const spans = getAllSpanInputs();

  it("collects spans from all span-bearing families", () => {
    // 3 emitter + (5 + 2) trace + 1 external-API = 11
    expect(spans).toHaveLength(11);
  });

  for (const span of getAllSpanInputs()) {
    it(`maps span ${span.span_id} to a valid OtelSpanEvent`, () => {
      const event = mapOtelSpanToEvent(span);
      expect(otelSpanEventSchema.safeParse(event).success).toBe(true);
      expect(event.span_id).toBe(span.span_id);
    });
  }
});

describe("emitter token + provider attributes project onto canonical fields", () => {
  it("Traceloop pre-1.27 prompt/completion tokens + gen_ai.system alias normalize", () => {
    const traceloop = getEmitterFixtures().find((f) => f.emitter === "traceloop")!;
    const event = mapOtelSpanToEvent(traceloop.span);
    expect(event.gen_ai_usage_input_tokens).toBe(100);
    expect(event.gen_ai_usage_output_tokens).toBe(180);
    expect(event.gen_ai_request_model).toBe("gpt-4");
    expect(event.gen_ai_provider_name).toBe("openai"); // via deprecated alias
  });

  it("Pydantic Logfire canonical gen_ai.provider.name + input/output tokens project", () => {
    const logfire = getEmitterFixtures().find((f) => f.emitter === "pydantic-logfire")!;
    const event = mapOtelSpanToEvent(logfire.span);
    expect(event.gen_ai_provider_name).toBe("openai");
    expect(event.gen_ai_usage_input_tokens).toBe(150);
    expect(event.gen_ai_operation_name).toBe("chat");
  });

  it("the external-API span projects HTTP error fields", () => {
    const ext = getExternalApiFixtures()[0]!;
    const event = mapOtelSpanToEvent(ext.span);
    expect(event.status_code).toBe("ERROR");
    expect(event.http_response_status_code).toBe(404);
    expect(event.url_path).toBe("/repos/acme/app/issues/999");
    expect(event.server_port).toBe(443);
    expect(event.error_type).toBe("404");
  });
});

describe("multi-span sub-agent trace structure", () => {
  it("has exactly one root, unique span ids, same-trace acyclic parentage", () => {
    for (const trace of getTraceFixtures()) {
      const ids = trace.spans.map((s) => s.span_id);
      // unique span ids
      expect(new Set(ids).size).toBe(ids.length);
      // exactly one root
      const roots = trace.spans.filter((s) => s.parent_span_id == null);
      expect(roots).toHaveLength(1);
      // every parent is in the same trace
      for (const span of trace.spans) {
        if (span.parent_span_id != null) {
          expect(ids).toContain(span.parent_span_id);
        }
      }
      // acyclic: walking parents from any node terminates at the root
      const byId = new Map(trace.spans.map((s) => [s.span_id, s]));
      for (const span of trace.spans) {
        const seen = new Set<string>();
        let cursor = span.parent_span_id ?? null;
        while (cursor != null) {
          expect(seen.has(cursor)).toBe(false);
          seen.add(cursor);
          cursor = byId.get(cursor)?.parent_span_id ?? null;
        }
      }
    }
  });
});

describe("frozen legacy expected spans are valid M1.1 spans", () => {
  for (const fixture of getLegacyFixtures()) {
    it(`expected span for ${fixture.name} parses + preserves the record losslessly`, () => {
      expect(otelSpanEventSchema.safeParse(fixture.expected).success).toBe(true);
      const recordJson = fixture.expected.attributes["pome.legacy.record_json"];
      expect(typeof recordJson).toBe("string");
      expect(JSON.parse(recordJson as string)).toEqual(fixture.legacy);
    });
  }
});

describe("getLegacyFixtureByName", () => {
  it("returns a fixture by its stable name", () => {
    expect(getLegacyFixtureByName("twin-http/github-create-issue").name).toBe(
      "twin-http/github-create-issue",
    );
  });

  it("throws on an unknown name", () => {
    expect(() => getLegacyFixtureByName("nope")).toThrow(/unknown legacy fixture/);
  });
});
