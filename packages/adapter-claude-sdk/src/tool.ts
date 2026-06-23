// SPDX-License-Identifier: Apache-2.0
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { wrapHandler } from "./wrapHandler.js";

/**
 * Drop-in replacement for `@anthropic-ai/claude-agent-sdk`'s `tool()`. The
 * supplied handler is wrapped so each invocation runs inside an
 * AsyncLocalStorage scope carrying a fresh `tool_call_id`. Outgoing
 * `fetch()` calls within the handler will carry the `x-pome-correlation-id`
 * header for allowlisted twin origins.
 */
export const tool: typeof sdkTool = ((
  name: string,
  description: string,
  inputSchema: Parameters<typeof sdkTool>[2],
  handler: Parameters<typeof sdkTool>[3],
  extras?: Parameters<typeof sdkTool>[4],
) => {
  const wrapped = wrapHandler(handler as (a: unknown) => Promise<unknown>);
  return sdkTool(
    name,
    description,
    inputSchema,
    wrapped as Parameters<typeof sdkTool>[3],
    extras,
  );
}) as typeof sdkTool;
