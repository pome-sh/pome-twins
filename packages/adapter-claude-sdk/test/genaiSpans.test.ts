// SPDX-License-Identifier: Apache-2.0
//
// withGenAiSpans → real OTLP/HTTP-JSON export. Stands up a local HTTP sink,
// points the adapter's exporter at it via the pome env contract, drives a
// synthetic SDK message stream, and asserts the captured ExportTraceServiceRequest
// carries gen_ai token attributes + the resource/service identity + auth header.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Captured {
  authorization?: string;
  body: unknown;
}

let server: Server;
let port: number;
let captured: Captured[];

const ENV_KEYS = [
  "POME_OTEL_EXPORTER_OTLP_ENDPOINT",
  "POME_OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  captured = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave null */
      }
      captured.push({ authorization: req.headers["authorization"] as string | undefined, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}/v1/sessions/ses_test/traces`;
  process.env.POME_OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer test-jwt";
  process.env.OTEL_SERVICE_NAME = "pr-sum-agent";
  process.env.OTEL_RESOURCE_ATTRIBUTES = "pome.session_id=ses_test,pome.run_id=run_test";

  const { _resetOtelForTest } = await import("../src/otel.js");
  _resetOtelForTest();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { _resetOtelForTest } = await import("../src/otel.js");
  _resetOtelForTest();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

// Flatten OTLP/JSON `[{ key, value: { stringValue | intValue | ... } }]` into a
// plain record. int64 values arrive as decimal strings in OTLP/JSON.
function flattenAttrs(attrs: Array<{ key: string; value: Record<string, unknown> }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
}

async function drive(messages: Array<{ type: string; [k: string]: unknown }>): Promise<void> {
  const { withGenAiSpans } = await import("../src/genai-spans.js");
  async function* src() {
    for (const m of messages) yield m;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of withGenAiSpans(src())) void _;
}

describe("withGenAiSpans → OTLP/JSON export", () => {
  it("emits a gen_ai span per assistant turn with token usage, then flushes on result", async () => {
    await drive([
      { type: "system" },
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    // Auth header from the pome env contract reaches the collector.
    expect(captured[0]!.authorization).toBe("Bearer test-jwt");

    // Collect all spans across all received export requests.
    const spans: Array<{ name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> = [];
    let resourceAttrs: Record<string, unknown> = {};
    for (const c of captured) {
      const rs = (c.body as { resourceSpans?: unknown[] }).resourceSpans ?? [];
      for (const r of rs as Array<Record<string, unknown>>) {
        resourceAttrs = {
          ...resourceAttrs,
          ...flattenAttrs((r.resource as { attributes?: never }).attributes ?? []),
        };
        for (const ss of (r.scopeSpans ?? []) as Array<{ spans?: unknown[] }>) {
          for (const s of (ss.spans ?? []) as never[]) spans.push(s);
        }
      }
    }

    expect(spans.length).toBe(2);
    const a = flattenAttrs(spans[0]!.attributes);
    expect(a["gen_ai.provider.name"]).toBe("anthropic");
    expect(a["gen_ai.operation.name"]).toBe("chat");
    expect(a["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(Number(a["gen_ai.usage.input_tokens"])).toBe(10);
    expect(Number(a["gen_ai.usage.output_tokens"])).toBe(5);
    expect(spans[0]!.name).toBe("chat claude-opus-4-8");

    // Resource identity for dashboard attribution.
    expect(resourceAttrs["service.name"]).toBe("pr-sum-agent");
    expect(resourceAttrs["pome.session_id"]).toBe("ses_test");
  });

  it("skips assistant turns that reported no usage", async () => {
    await drive([
      { type: "assistant", message: { model: "claude-opus-4-8" } },
      { type: "result", subtype: "success" },
    ]);

    const spans: unknown[] = [];
    for (const c of captured) {
      const rs = ((c.body as { resourceSpans?: unknown[] }).resourceSpans ?? []) as Array<Record<string, unknown>>;
      for (const r of rs) {
        for (const ss of (r.scopeSpans ?? []) as Array<{ spans?: unknown[] }>) {
          for (const s of ss.spans ?? []) spans.push(s);
        }
      }
    }
    expect(spans.length).toBe(0);
  });

  it("is inert when no OTLP endpoint is configured", async () => {
    delete process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT;
    const { _resetOtelForTest } = await import("../src/otel.js");
    _resetOtelForTest();

    await drive([
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(captured.length).toBe(0);
  });
});
