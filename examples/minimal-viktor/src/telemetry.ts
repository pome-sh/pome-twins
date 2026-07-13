/**
 * OTLP trace wiring for observed trials.
 *
 * `pome run` (hosted) injects POME_OTEL_EXPORTER_OTLP_ENDPOINT — a FULL traces
 * URL (`<base>/v1/sessions/<id>/traces`) — plus POME_OTEL_EXPORTER_OTLP_HEADERS
 * as "k=v,k=v" (carries the team x-api-key). When present, the Vercel AI SDK's
 * experimental_telemetry emits gen_ai.* spans through this tracer and they land
 * on the run's Agent-telemetry panel. Without the endpoint this module is an
 * inert no-op so the agent also runs standalone.
 */
import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface Telemetry {
  tracer?: Tracer;
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

export function initTelemetry(): Telemetry {
  const endpoint = process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return { shutdown: async () => {} };

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "minimal-viktor",
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

  return {
    tracer: provider.getTracer("minimal-viktor"),
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}
