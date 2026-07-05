// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — client for the anonymous demo model-call gateway (FDRS-637):
// POST {POME_API_BASE}/v1/demo/sessions/:id/llm, Authorization: Bearer
// <demo_token>.
//
// The wire shape is a STRICT ModelMessage subset (pome-cloud
// routes/demo-llm.ts): user text, assistant text/tool-call parts, tool
// results — NO `system` role (server-owned prompt), NO `model` field
// (server-pinned). Unknown fields are a 422 BY DESIGN; that strictness IS the
// scenario lock, so this client never spreads extra keys into messages.
// Requests travel through the runner-injected capture proxy
// (proxyRequest.ts) so each gateway call lands in events.jsonl as a genuine
// LlmCallEvent and stays inside the egress floor.

import { z } from "zod";
import { DemoCapacityError, capacityKindFrom, capacityLabel } from "./capacity.js";
import { postJsonMaybeViaProxy } from "./proxyRequest.js";

// ─── Wire types (strict subset — mirror of demo-llm.ts's Zod schema) ────────

export type DemoTextPart = { type: "text"; text: string };
export type DemoToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};
export type DemoToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
};

export type DemoMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | Array<DemoTextPart | DemoToolCallPart> }
  | { role: "tool"; content: DemoToolResultPart[] };

export interface DemoToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

const gatewayResponseSchema = z.object({
  text: z.string(),
  tool_calls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    }),
  ),
  finish_reason: z.string(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .optional(),
});
export type GatewayResponse = z.infer<typeof gatewayResponseSchema>;

export interface CallDemoGatewayOptions {
  /** Full gateway URL: {apiBase}/v1/demo/sessions/{sid}/llm. */
  gatewayUrl: string;
  demoToken: string;
  taskName: string;
  messages: DemoMessage[];
  tools?: DemoToolDef[];
  /** Proxy coordinates (HTTPS_PROXY / NO_PROXY from the runner). */
  proxyUrl?: string;
  noProxy?: string;
  timeoutMs?: number;
  /** Test seam — force the CONNECT path for loopback targets. */
  forceProxyForTest?: boolean;
}

export class DemoGatewayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DemoGatewayError";
  }
}

export async function callDemoGateway(
  options: CallDemoGatewayOptions,
): Promise<GatewayResponse> {
  const { status, bodyText } = await postJsonMaybeViaProxy({
    url: options.gatewayUrl,
    headers: { authorization: `Bearer ${options.demoToken}` },
    body: {
      task_name: options.taskName,
      messages: options.messages,
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools }
        : {}),
    },
    proxyUrl: options.proxyUrl,
    noProxy: options.noProxy,
    timeoutMs: options.timeoutMs ?? 120_000,
    forceProxy: options.forceProxyForTest,
  });

  let json: unknown = {};
  try {
    json = bodyText.length ? JSON.parse(bodyText) : {};
  } catch {
    throw new DemoGatewayError(
      `demo gateway returned non-JSON (status ${status})`,
      status,
    );
  }

  if (status < 200 || status >= 300) {
    const envelope = (
      json as {
        error?: { message?: string; details?: Record<string, unknown> };
      }
    ).error;
    const kind = capacityKindFrom(status, envelope?.details?.kind);
    if (kind) {
      throw new DemoCapacityError(kind, envelope?.message ?? capacityLabel(kind));
    }
    throw new DemoGatewayError(
      envelope?.message ?? `demo gateway → HTTP ${status}`,
      status,
    );
  }

  const parsed = gatewayResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new DemoGatewayError(
      `demo gateway returned an unexpected shape: ${parsed.error.message}`,
      status,
    );
  }
  return parsed.data;
}
