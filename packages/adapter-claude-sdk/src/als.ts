// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";

export type CallContext = { tool_call_id: string };

export const callContext = new AsyncLocalStorage<CallContext>();

export function currentToolCallId(): string | null {
  return callContext.getStore()?.tool_call_id ?? null;
}
