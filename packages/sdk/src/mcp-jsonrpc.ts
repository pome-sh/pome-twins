// SPDX-License-Identifier: Apache-2.0
//
// Streamable-HTTP JSON-RPC 2.0 MCP endpoint (`POST /s/:sid/mcp`), stateless
// mode: GET/DELETE answer 405. Generic over the twin's ToolSpec registry —
// the per-twin mcp.ts modules this replaces differed only in their tool
// tables and error envelopes, both of which now come from the manifest.

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import type { RecorderHandle, ToolSpec, TwinDefinition } from "./index.js";
import { UnknownToolError, envelopeFor } from "./errors.js";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

type JsonRpcId = string | number;

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export interface McpJsonRpcDeps<TDb, TSeed, TDomain> {
  definition: TwinDefinition<TDb, TSeed, TDomain>;
  domain: TDomain;
  recorder: RecorderHandle;
  runId: string;
}

export function mcpMethodNotAllowed(c: Context): Response {
  return c.json(
    { jsonrpc: "2.0", id: null, error: { code: METHOD_NOT_FOUND, message: "Method not allowed in stateless mode" } },
    405,
    { Allow: "POST" }
  );
}

export async function handleMcpJsonRpc<TDb, TSeed, TDomain>(
  c: Context,
  deps: McpJsonRpcDeps<TDb, TSeed, TDomain>
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonRpcErrorResponse(null, PARSE_ERROR, "Problems parsing JSON");
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonRpcErrorResponse(null, INVALID_REQUEST, "Invalid Request");
    }
    const out: JsonRpcResponse[] = [];
    for (const message of body) {
      const response = await dispatch(message, deps, c);
      if (response) out.push(response);
    }
    if (out.length === 0) return new Response(null, { status: 202 });
    return Response.json(out, { status: 200, headers: { "content-type": "application/json" } });
  }

  const response = await dispatch(body, deps, c);
  if (!response) return new Response(null, { status: 202 });
  return Response.json(response, { status: 200, headers: { "content-type": "application/json" } });
}

async function dispatch<TDb, TSeed, TDomain>(
  message: unknown,
  deps: McpJsonRpcDeps<TDb, TSeed, TDomain>,
  c: Context
): Promise<JsonRpcResponse | null> {
  if (!isObject(message)) return errorEnvelope(null, INVALID_REQUEST, "Invalid Request");
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorEnvelope(idOf(message), INVALID_REQUEST, "Invalid Request");
  }

  const method = message.method;
  const params = isObject(message.params) ? (message.params as Record<string, unknown>) : {};

  const rawId = message.id;
  if (rawId === undefined || rawId === null) return null; // notification
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    return errorEnvelope(null, INVALID_REQUEST, "Invalid Request: id must be string or number");
  }
  const id: JsonRpcId = rawId;

  try {
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: buildInitializeResult(params, deps.definition) };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: deps.definition.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: z.toJSONSchema(tool.schema),
            })),
          },
        };
      case "tools/call":
        return await handleToolsCall(id, params, deps, c);
      default:
        return errorEnvelope(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    return errorEnvelope(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
}

function buildInitializeResult<TDb, TSeed, TDomain>(
  params: Record<string, unknown>,
  definition: TwinDefinition<TDb, TSeed, TDomain>
) {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: `twin-${definition.id}`, version: definition.version },
  };
}

async function handleToolsCall<TDb, TSeed, TDomain>(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpJsonRpcDeps<TDb, TSeed, TDomain>,
  c: Context
): Promise<JsonRpcResponse> {
  const name = params.name;
  const args =
    params.arguments === undefined || params.arguments === null
      ? {}
      : isObject(params.arguments)
        ? params.arguments
        : undefined;
  if (typeof name !== "string" || name.length === 0 || args === undefined) {
    return errorEnvelope(id, INVALID_PARAMS, "Invalid params: expected { name: string, arguments?: object }");
  }

  const projectError = deps.definition.errorEnvelope ?? envelopeFor;
  const tool = deps.definition.tools.find((t): t is ToolSpec<TDomain> => t.name === name);

  const started = Date.now();
  let status: number;
  let responseBody: unknown;
  let toolError: string | null = null;
  let mutation = false;
  let mcpResult: { content: { type: "text"; text: string }[]; isError?: boolean };

  if (!tool) {
    const envelope = projectError(new UnknownToolError(name));
    status = envelope.status;
    responseBody = envelope.body;
    toolError = `Unknown tool: ${name}`;
    mcpResult = { content: [{ type: "text", text: JSON.stringify(envelope.body) }], isError: true };
  } else {
    try {
      const parsed = tool.schema.parse(args);
      const value = await tool.handler(deps.domain, parsed);
      status = 200;
      responseBody = value;
      mutation = tool.mutation;
      mcpResult = { content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (err) {
      const envelope = projectError(err);
      status = envelope.status;
      responseBody = envelope.body;
      toolError = err instanceof Error ? err.message : "tool call failed";
      mcpResult = { content: [{ type: "text", text: JSON.stringify(envelope.body) }], isError: true };
    }
  }

  deps.recorder.record(
    buildEventCore(c, deps, {
      started,
      status,
      requestBody: { tool: name, arguments: args },
      responseBody,
      mutation: status < 400 && mutation,
      error: toolError,
    })
  );

  return { jsonrpc: "2.0", id, result: mcpResult };
}

function buildEventCore<TDb, TSeed, TDomain>(
  c: Context,
  deps: McpJsonRpcDeps<TDb, TSeed, TDomain>,
  fields: {
    started: number;
    status: number;
    requestBody: unknown;
    responseBody: unknown;
    mutation: boolean;
    error: string | null;
  }
) {
  return {
    ts: new Date().toISOString(),
    run_id: deps.runId,
    twin: deps.definition.id,
    request_id: `req_${randomUUID()}`,
    step_id: null,
    tool_call_id: null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: fields.requestBody,
    status: fields.status,
    response_body: fields.responseBody,
    latency_ms: Date.now() - fields.started,
    fidelity: "semantic" as const,
    state_mutation: fields.mutation,
    state_delta: null,
    error: fields.error,
  };
}

function errorEnvelope(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcErrorResponse(id: JsonRpcId | null, code: number, message: string): Response {
  return Response.json(errorEnvelope(id, code, message), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function idOf(message: Record<string, unknown>): JsonRpcId | null {
  const id = message.id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
