// SPDX-License-Identifier: Apache-2.0
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type {
  AnyZodRawShape,
  InferShape,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { wrapHandler } from "./wrapHandler.js";

// The handler's resolved result (`CallToolResult`) and the trailing `extras`
// bag aren't exported by name from the SDK, so derive them from `tool`'s own
// parameter types instead of restating the shapes.
type ToolCallResult = Awaited<ReturnType<Parameters<typeof sdkTool>[3]>>;
type ToolExtras = Parameters<typeof sdkTool>[4];

/**
 * Drop-in replacement for `@anthropic-ai/claude-agent-sdk`'s `tool()`. The
 * supplied handler is wrapped so each invocation runs inside an
 * AsyncLocalStorage scope carrying a fresh `tool_call_id`. Outgoing
 * `fetch()` calls within the handler will carry the `x-pome-correlation-id`
 * header for allowlisted twin origins.
 *
 * The signature mirrors the SDK's `tool()` — the generic `Schema` still binds
 * from `inputSchema` so each handler's `args` stay precisely typed — but the
 * return is widened to `SdkMcpToolDefinition<any>`. That deliberate widening
 * lets callers collect tools of differing schemas into one array and hand it to
 * `createSdkMcpServer({ tools })` (whose param is `SdkMcpToolDefinition<any>[]`).
 * The SDK's own `tool()` returns the precise `SdkMcpToolDefinition<Schema>`,
 * which — when this adapter is consumed via a local `file:` link and thus
 * resolves a *different physical copy* of the SDK types than the caller's
 * `createSdkMcpServer` — trips a cross-copy structural check on the handler's
 * contravariant `args` (`InferShape<any>` widens to `{ [x: string]: unknown }`)
 * and fails to typecheck. Widening the return sidesteps that trap without
 * losing per-handler `args` inference. (F-866.)
 */
export function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<ToolCallResult>,
  extras?: ToolExtras,
): SdkMcpToolDefinition<any> {
  const wrapped = wrapHandler(handler as (a: unknown) => Promise<ToolCallResult>);
  return sdkTool(
    name,
    description,
    inputSchema,
    wrapped as (args: InferShape<Schema>, extra: unknown) => Promise<ToolCallResult>,
    extras,
  );
}
