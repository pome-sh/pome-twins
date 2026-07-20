/**
 * OTLP trace wiring for observed LangGraph trials.
 *
 * Same pome contract as `examples/minimal-viktor/src/telemetry.ts`: `pome run`
 * (hosted) injects POME_OTEL_EXPORTER_OTLP_ENDPOINT — a FULL traces URL
 * (`<base>/v1/sessions/<id>/traces`) — plus POME_OTEL_EXPORTER_OTLP_HEADERS as
 * "k=v,k=v" (the team x-api-key). When present we stand up an OTLP/JSON exporter
 * and land spans on the run's Agent-telemetry panel. Without the endpoint this
 * module is an inert no-op so the agent also runs standalone.
 *
 * The difference from the Vercel-AI-SDK example: LangGraph does not emit OTel
 * spans on its own. We instrument it with OpenInference — the standard OTel
 * instrumentation for LangChain.js / LangGraph — which patches the LangChain
 * callback manager and emits a span per graph node, LLM call, and tool call.
 *
 * OpenInference emits its own `llm.*` / `tool.name` / `openinference.span.kind`
 * attribute surface rather than `gen_ai.*`. pome's span projector accepts those
 * as fallback aliases (@pome-sh/shared-types >= 0.10.1), so the model, provider,
 * token usage, and tool name still land on the agent-telemetry rollup and the
 * span waterfall — no per-agent glue required.
 */
import { LangChainInstrumentation } from "@arizeai/openinference-instrumentation-langchain";
import * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface Telemetry {
  /** True when spans are being exported to a pome endpoint. */
  enabled: boolean;
  shutdown(): Promise<void>;
}

export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

/**
 * Stand up the OTLP exporter and instrument LangChain. Call this ONCE, before
 * the graph is built or invoked, so OpenInference's callback-manager patch is in
 * place for every node/LLM/tool run.
 */
export function initTelemetry(): Telemetry {
  const endpoint = process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return { enabled: false, shutdown: async () => {} };

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "minimal-viktor-langgraph",
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: endpoint,
          headers: parseOtlpHeaders(process.env.POME_OTEL_EXPORTER_OTLP_HEADERS),
        }),
      ),
    ],
  });
  provider.register();

  const instrumentation = new LangChainInstrumentation({ tracerProvider: provider });
  // Patch the LangChain callback manager module so every chain/LLM/tool run
  // opens an OpenInference span under the active trace context.
  instrumentation.manuallyInstrument(CallbackManagerModule);

  return {
    enabled: true,
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}
