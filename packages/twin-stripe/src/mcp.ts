// SPDX-License-Identifier: Apache-2.0
//
// JSON-RPC 2.0 / streamable-HTTP MCP endpoint for twin-stripe (FDRS-528).
//
// The stripe twin historically exposed only the legacy `/mcp/tools` +
// `/mcp/call` REST dispatch, which the AI-SDK MCP client (used by the eval
// fleet's mcp-loop scaffold) cannot speak. This mirrors twin-slack/twin-github's
// stateless JSON-RPC `/mcp` (initialize / ping / tools/list / tools/call) so an
// mcp-loop agent can drive the stripe twin end-to-end.
//
// Every tools/call is recorded as a twin HTTP event carrying `{tool, arguments}`
// — including REJECTED calls (e.g. a second refund on an already-fully-refunded
// charge, which the domain refuses). That event is what an action-`[D]` reads to
// detect the *attempt*, not just the persisted state.
import type { Context } from "hono";
import { z } from "zod";
import { twinBuildInfo } from "./build-info.js";
import type { StripeDomain } from "./domain/index.js";
import { TwinError } from "./errors.js";
import { executeTool, isMutatingTool, listTools } from "./tools.js";
import type { Recorder, ResolvedSession } from "./types.js";
import { requestId } from "./util.js";

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

export type McpDeps = {
  domain: StripeDomain;
  recorder?: Recorder;
  runId: string;
};

export function mcpMethodNotAllowed(c: Context) {
  return c.json(
    { jsonrpc: "2.0", id: null, error: { code: METHOD_NOT_FOUND, message: "Method not allowed in stateless mode" } },
    405,
    { Allow: "POST" },
  );
}

export async function handleMcpRequest(c: Context, deps: McpDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonRpcErrorResponse(null, PARSE_ERROR, "Problems parsing JSON");
  }

  if (Array.isArray(body)) {
    if (body.length === 0) return jsonRpcErrorResponse(null, INVALID_REQUEST, "Invalid Request");
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

async function dispatch(message: unknown, deps: McpDeps, c: Context): Promise<JsonRpcResponse | null> {
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
        return { jsonrpc: "2.0", id, result: buildInitializeResult(params) };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: toolsForMcp() } };
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
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "twin-stripe", version: twinBuildInfo().version },
  };
}

// twin-stripe `listTools()` returns `{name, description, input_schema}`; MCP
// tools/list expects `inputSchema`.
function toolsForMcp() {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema ?? { type: "object" },
  }));
}

async function handleToolsCall(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpDeps,
  c: Context,
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

  const session = c.get("session") as ResolvedSession | undefined;
  const accountId = session?.account_id ?? "acct_default";

  const started = Date.now();
  const recordedRequestBody = { tool: name, arguments: args };
  let status = 200;
  let responseBody: unknown = null;
  let toolError: string | null = null;
  let mcpResult: { content: { type: "text"; text: string }[]; isError?: boolean };

  try {
    const value = executeTool(deps.domain, accountId, name, args);
    responseBody = value;
    mcpResult = { content: [{ type: "text", text: jsonText(value) }] };
  } catch (err) {
    if (err instanceof TwinError) {
      status = err.status;
      const errBody = { error: { type: err.type, code: err.code, message: err.message } };
      responseBody = errBody;
      toolError = err.code;
      mcpResult = { content: [{ type: "text", text: jsonText(errBody) }], isError: true };
    } else if (err instanceof z.ZodError) {
      status = 400;
      const errBody = {
        error: {
          type: "invalid_request_error",
          message: err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        },
      };
      responseBody = errBody;
      toolError = "invalid_request_error";
      mcpResult = { content: [{ type: "text", text: jsonText(errBody) }], isError: true };
    } else {
      status = 500;
      const message = err instanceof Error ? err.message : "Internal Server Error";
      responseBody = { error: { type: "api_error", message } };
      toolError = message;
      mcpResult = { content: [{ type: "text", text: jsonText(responseBody) }], isError: true };
    }
  }

  recordToolCall(c, deps, {
    started,
    status,
    requestBody: recordedRequestBody,
    responseBody,
    mutation: status < 400 && isMutatingTool(name),
    error: toolError,
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
    error: string | null;
  },
) {
  if (!deps.recorder) return;
  const reqId = requestId();
  deps.recorder.record({
    ts: new Date().toISOString(),
    run_id: deps.runId,
    twin: "stripe",
    request_id: reqId,
    correlation_id: reqId,
    scenario_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
    step_id: null,
    tool_call_id: null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: fields.requestBody,
    status: fields.status,
    response_body: fields.responseBody,
    latency_ms: Date.now() - fields.started,
    fidelity: "semantic",
    state_mutation: fields.mutation,
    state_delta: null,
    error: fields.error,
  });
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

function jsonText(value: unknown) {
  return JSON.stringify(value);
}
