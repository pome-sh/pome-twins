// SPDX-License-Identifier: Apache-2.0
//
// Wraps an MCP tool handler so each invocation runs inside an
// AsyncLocalStorage scope carrying a freshly-generated `tool_call_id`. The
// fetch hook (`./fetch.ts`) reads that id from ALS and stamps it onto the
// `x-pome-correlation-id` header for allowlisted twin origins, so the twin's
// `TwinHttpEvent` row can be correlated back to the calling tool invocation.
//
// FDRS-407: no longer writes a legacy `tool_call` signal. The on-disk
// `ToolUseEvent` row is emitted by the message-stream wrapper (FDRS-408)
// from the SDK assistant message that issued the tool_use block.

import { callContext } from "./als.js";
import { generateToolCallId } from "./ids.js";

export function wrapHandler<A, R>(handler: (args: A) => R | Promise<R>) {
  return async (args: A): Promise<R> => {
    const tool_call_id = generateToolCallId();
    return callContext.run({ tool_call_id }, () => Promise.resolve(handler(args)));
  };
}
