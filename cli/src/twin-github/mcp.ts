// SPDX-License-Identifier: Apache-2.0
//
// Real MCP JSON-RPC endpoint (Streamable HTTP, stateless tools-only).
//
// Wire contract: POST /s/:sid/mcp with JSON-RPC 2.0 body. We implement
// the minimum subset required by `@modelcontextprotocol/sdk`'s
// `Client` + `StreamableHTTPClientTransport`:
//   - initialize           (request)  → server info + capabilities
//   - notifications/*      (notif)    → HTTP 202, empty body
//   - ping                 (request)  → result: {}
//   - tools/list           (request)  → { tools: [...] } with camelCase inputSchema
//   - tools/call           (request)  → { content: [{type:"text",text:JSON}], isError? }
//
// Recorder parity: every successful `tools/call` produces one RecorderEvent
// whose request_body is `{ tool, arguments }` and whose response_body is the
// raw domain return value — byte-identical to what the legacy
// POST /s/:sid/mcp/call route records. Transport framing (JSON-RPC envelope)
// is intentionally NOT recorded; downstream analytics/replay dispatch on
// "tool X called with args Y" regardless of whether the request came in
// over MCP, the legacy custom route, or a REST shim.
//
// Stateless: each POST is independent. No Mcp-Session-Id, no SSE, no
// server→client notifications. GET/DELETE return 405.

import type { Context } from "hono";
import { z } from "zod";
import type { StateDelta } from "../types/shared.js";
import type { GitHubDomain } from "./domain.js";
import { TwinError } from "./errors.js";
import { executeTool, isMutatingTool, listToolsForMcp, toolDefinitions } from "./tools.js";
import type { Recorder } from "./types.js";
import { requestId } from "./util.js";
import { twinBuildInfo } from "./build-info.js";

// JSON-RPC 2.0 error codes (https://www.jsonrpc.org/specification)
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// Latest MCP protocol version this server speaks. The MCP handshake says the
// server MAY echo the client's requested version if it supports it, otherwise
// reply with a version the server supports. We echo when the client requests
// a known-shaped string; otherwise fall back to this.
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18"
]);

type JsonRpcId = string | number;

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export type McpDeps = {
  domain: GitHubDomain;
  recorder?: Recorder;
  runId: string;
};

// Hono GET/DELETE handler — Streamable HTTP requires both to exist; in
// stateless mode the only sensible answer is 405.
export function mcpMethodNotAllowed(c: Context) {
  return c.json(
    { jsonrpc: "2.0", id: null, error: { code: METHOD_NOT_FOUND, message: "Method not allowed in stateless mode" } },
    405,
    { Allow: "POST" }
  );
}

export async function handleMcpRequest(c: Context, deps: McpDeps): Promise<Response> {
  // Body must be JSON. Failure → parse error per JSON-RPC.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonRpcErrorResponse(null, PARSE_ERROR, "Problems parsing JSON");
  }

  // Batch: process each, return array of responses (omitting notifications).
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonRpcErrorResponse(null, INVALID_REQUEST, "Invalid Request");
    }
    const out: JsonRpcResponse[] = [];
    for (const message of body) {
      const response = await dispatch(message, deps, c);
      if (response) out.push(response);
    }
    // If every message was a notification → 202 with empty body.
    if (out.length === 0) return new Response(null, { status: 202 });
    return Response.json(out, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  // Single message.
  const response = await dispatch(body, deps, c);
  if (!response) return new Response(null, { status: 202 });
  // Pick HTTP status from the JSON-RPC payload kind: error → still 200 per spec
  // (errors travel inside the envelope), except for parse/invalid-request which
  // are signaled by the dispatch path itself.
  return Response.json(response, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

// Returns null for notifications (no response). Returns a JSON-RPC response
// envelope otherwise.
async function dispatch(
  message: unknown,
  deps: McpDeps,
  c: Context
): Promise<JsonRpcResponse | null> {
  if (!isObject(message)) {
    return errorEnvelope(null, INVALID_REQUEST, "Invalid Request");
  }
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorEnvelope(idOf(message), INVALID_REQUEST, "Invalid Request");
  }

  const method = message.method;
  const params = isObject(message.params) ? (message.params as Record<string, unknown>) : {};

  // Notification: no `id` → MUST NOT respond. Caller turns this into HTTP 202.
  // Per MCP, `notifications/initialized` and `notifications/cancelled` are the
  // most common; the right behavior is to swallow silently. Any unknown
  // notification is also swallowed (notifications cannot return errors).
  const rawId = message.id;
  if (rawId === undefined || rawId === null) {
    return null;
  }
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    return errorEnvelope(null, INVALID_REQUEST, "Invalid Request: id must be string or number");
  }
  const id: JsonRpcId = rawId;

  try {
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: buildInitializeResult(params) };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listToolsForMcp() } };
      case "tools/call":
        return await handleToolsCall(id, params, deps, c);
      default:
        return errorEnvelope(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    return errorEnvelope(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
}

function buildInitializeResult(params: Record<string, unknown>) {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false }
    },
    serverInfo: {
      name: "twin-github",
      version: twinBuildInfo().version
    }
  };
}

async function handleToolsCall(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpDeps,
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
  if (!toolDefinitions.some((t) => t.name === name)) {
    // Per MCP convention, an unknown tool surfaces as a tool-call error
    // (isError: true) rather than a JSON-RPC error, so the client sees it
    // alongside other tool errors.
    return {
      jsonrpc: "2.0",
      id,
      result: makeToolErrorResult(`Unknown tool: ${name}`)
    };
  }

  const started = Date.now();
  const recordedRequestBody = { tool: name, arguments: args };
  let delta: StateDelta = null;
  let status = 200;
  let responseBody: unknown = null;
  let toolError: string | null = null;
  let mcpResult: { content: { type: "text"; text: string }[]; isError?: boolean };

  try {
    const value = executeTool(deps.domain, name, args, (d) => {
      delta = d;
    });
    responseBody = value;
    mcpResult = { content: [{ type: "text", text: jsonText(value) }] };
  } catch (err) {
    if (err instanceof TwinError) {
      status = err.status;
      const ghError = {
        message: err.message,
        documentation_url: "https://docs.github.com/rest",
        status: err.status,
        ...(err.errors ? { errors: err.errors } : {})
      };
      responseBody = ghError;
      toolError = err.message;
      mcpResult = { content: [{ type: "text", text: jsonText(ghError) }], isError: true };
    } else if (err instanceof z.ZodError) {
      status = 422;
      const ghError = {
        message: "Validation Failed",
        documentation_url: "https://docs.github.com/rest",
        status: 422,
        errors: err.issues.map((issue) => ({
          resource: "Request",
          field: issue.path.join("."),
          code: issue.code
        }))
      };
      responseBody = ghError;
      toolError = "Validation Failed";
      mcpResult = { content: [{ type: "text", text: jsonText(ghError) }], isError: true };
    } else {
      status = 500;
      const message = err instanceof Error ? err.message : "Internal Server Error";
      const ghError = { message, documentation_url: "https://docs.github.com/rest", status: 500 };
      responseBody = ghError;
      toolError = message;
      mcpResult = { content: [{ type: "text", text: jsonText(ghError) }], isError: true };
    }
  }

  recordToolCall(c, deps, {
    started,
    status,
    requestBody: recordedRequestBody,
    responseBody,
    mutation: status < 400 && isMutatingTool(name),
    stateDelta: status < 400 ? delta : null,
    error: toolError
  });

  return { jsonrpc: "2.0", id, result: mcpResult };
}

function recordToolCall(
  c: Context,
  deps: McpDeps,
  fields: {
    started: number;
    status: number;
    requestBody: unknown;
    responseBody: unknown;
    mutation: boolean;
    stateDelta: StateDelta;
    error: string | null;
  }
) {
  if (!deps.recorder) return;
  const reqId = requestId();
  const correlationHeader = c.req.header("x-pome-correlation-id") ?? null;
  deps.recorder.record({
    ts: new Date().toISOString(),
    run_id: deps.runId,
    twin: "github",
    request_id: reqId,
    // FDRS-402: see app.ts respond() for the rationale.
    correlation_id: correlationHeader ?? reqId,
    scenario_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
    step_id: null,
    tool_call_id: correlationHeader,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: fields.requestBody,
    status: fields.status,
    response_body: fields.responseBody,
    latency_ms: Date.now() - fields.started,
    fidelity: "semantic",
    state_mutation: fields.mutation,
    state_delta: fields.stateDelta,
    error: fields.error
  });
}

function makeToolErrorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: jsonText({ message }) }],
    isError: true
  };
}

function errorEnvelope(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcErrorResponse(id: JsonRpcId | null, code: number, message: string): Response {
  return Response.json(errorEnvelope(id, code, message), {
    status: 200,
    headers: { "content-type": "application/json" }
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

function jsonText(value: unknown) {
  return JSON.stringify(value);
}
