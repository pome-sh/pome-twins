// SPDX-License-Identifier: Apache-2.0
//
// withToolEvents (FDRS-408 + FDRS-409)
//
// Walks the SDK message stream and emits one `ToolUseEvent` per `tool_use`
// content block in assistant messages, then one `ToolResultEvent` per
// `tool_result` content block in user messages. ToolResultEvent.parent_id
// points at the originating ToolUseEvent.event_id so the two halves of the
// call are durably linked in events.jsonl.
//
// Sub-agent attribution (FDRS-409): when the adapter sees a message whose
// top-level `parent_tool_use_id` is non-null for the first time, it emits
// one `SubagentSpawnEvent` whose `parent_id` points at the spawning
// `ToolUseEvent.event_id` (looked up via `tool_use_id == parent_tool_use_id`).
// Subsequent `ToolUseEvent`s coming from that sub-agent's stream carry
// `parent_id` set to the SubagentSpawnEvent's `event_id`, chaining children
// under the spawn row instead of leaving them parentless.
//
// Step boundaries (the prior `withStepBoundaries` in this file) were removed
// when FDRS-407 replaced step signals with the SDK's hook-driven `HookEvent`
// rows. The message-stream wrapper here is the surviving pome insertion
// point in the SDK iterator.

import { redactSecrets } from "./redaction.js";
import {
  newEventId,
  writeSubagentSpawnEvent,
  writeToolResultEvent,
  writeToolUseEvent,
} from "./signals.js";

type WithType = { type?: string };
type ContentBlock = { type?: string; [k: string]: unknown };

type AssistantLike = {
  type: "assistant";
  message?: { content?: unknown };
};

type UserLike = {
  type: "user";
  message?: { content?: unknown };
};

function readParentToolUseId(msg: WithType): string | null {
  const v = (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isAssistant(msg: WithType): msg is AssistantLike & WithType {
  return msg.type === "assistant";
}

function isUser(msg: WithType): msg is UserLike & WithType {
  return msg.type === "user";
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ContentBlock => typeof b === "object" && b !== null);
}

export async function* withToolEvents<T extends WithType>(
  source: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  // tool_use_id → event_id of the originating ToolUseEvent row. Lets a later
  // tool_result block set its parent_id back to that event_id.
  const toolUseEventIdById = new Map<string, string>();
  // parent_tool_use_id → event_id of the SubagentSpawnEvent emitted the first
  // time the adapter saw that parent_tool_use_id. Lets later child events
  // chain `parent_id` through the spawn row instead of pointing at null.
  const subagentEventIdByParentToolUseId = new Map<string, string>();

  for await (const msg of source) {
    const parentToolUseId = readParentToolUseId(msg);
    if (parentToolUseId && !subagentEventIdByParentToolUseId.has(parentToolUseId)) {
      const event_id = newEventId();
      subagentEventIdByParentToolUseId.set(parentToolUseId, event_id);
      writeSubagentSpawnEvent({
        ts: new Date().toISOString(),
        event_id,
        parent_id: toolUseEventIdById.get(parentToolUseId) ?? null,
        kind: "SubagentSpawnEvent",
        parent_tool_use_id: parentToolUseId,
      });
    }
    const subagentParentId = parentToolUseId
      ? subagentEventIdByParentToolUseId.get(parentToolUseId) ?? null
      : null;

    if (isAssistant(msg)) {
      const blocks = contentBlocks(msg.message?.content);
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const id = typeof block.id === "string" ? block.id : null;
        const name = typeof block.name === "string" ? block.name : null;
        if (!id || !name) continue;
        const event_id = newEventId();
        toolUseEventIdById.set(id, event_id);
        writeToolUseEvent({
          ts: new Date().toISOString(),
          event_id,
          parent_id: subagentParentId,
          kind: "ToolUseEvent",
          tool_use_id: id,
          tool_name: name,
          input: redactSecrets(block.input),
        });
      }
    } else if (isUser(msg)) {
      const blocks = contentBlocks(msg.message?.content);
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const tool_use_id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (!tool_use_id) continue;
        const parent_id = toolUseEventIdById.get(tool_use_id) ?? null;
        writeToolResultEvent({
          ts: new Date().toISOString(),
          event_id: newEventId(),
          parent_id,
          kind: "ToolResultEvent",
          tool_use_id,
          output: redactSecrets((block as { content?: unknown }).content),
          is_error: block.is_error === true,
        });
      }
    }
    yield msg;
  }
}
