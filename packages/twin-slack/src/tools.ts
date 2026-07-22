// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { StateDelta } from "@pome-sh/shared-types";
import type { SlackDomain } from "./domain/index.js";

// Slack MCP tools — the 11 visible Slack-agent tools exposed by tools/list.
// Schemas use z.strictObject so toJSONSchema emits `additionalProperties:false`.

export const toolDefinitions = [
  {
    name: "slack_post_message",
    description: "Post a new message to a Slack channel",
    readOnly: false,
    schema: z
      .strictObject({
        channel_id: z.string(),
        text: z.string(),
      })
      .strict(),
  },
  {
    name: "slack_reply_to_thread",
    description: "Reply to a specific message thread in Slack",
    readOnly: false,
    schema: z
      .strictObject({
        channel_id: z.string(),
        thread_ts: z.string(),
        text: z.string(),
      })
      .strict(),
  },
  {
    name: "slack_add_reaction",
    description: "Add a reaction emoji to a message",
    readOnly: false,
    schema: z
      .strictObject({
        channel_id: z.string(),
        timestamp: z.string(),
        reaction: z.string(),
      })
      .strict(),
  },
  {
    name: "slack_get_channel_history",
    description: "Get recent messages from a channel",
    readOnly: true,
    schema: z
      .strictObject({
        channel_id: z.string(),
        limit: z.number().optional(),
      })
      .strict(),
  },
  {
    name: "slack_get_thread_replies",
    description: "Get all replies in a message thread",
    readOnly: true,
    schema: z
      .strictObject({
        channel_id: z.string(),
        thread_ts: z.string(),
      })
      .strict(),
  },
  {
    name: "slack_list_channels",
    description: "List public or pre-defined channels in the workspace with pagination",
    readOnly: true,
    schema: z
      .strictObject({
        limit: z.number().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
  },
  {
    name: "slack_get_users",
    description: "Get a list of all users in the workspace with their basic profile information",
    readOnly: true,
    schema: z
      .strictObject({
        cursor: z.string().optional(),
        limit: z.number().optional(),
      })
      .strict(),
  },
  {
    name: "slack_get_user_profile",
    description: "Get detailed profile information for a specific user",
    readOnly: true,
    schema: z
      .strictObject({
        user_id: z.string(),
      })
      .strict(),
  },
  {
    name: "slack_search_messages",
    description: "Search messages in the workspace by text query",
    readOnly: true,
    schema: z
      .strictObject({
        query: z.string(),
        count: z.number().optional(),
        page: z.number().optional(),
      })
      .strict(),
  },
  {
    name: "slack_get_reactions",
    description: "Get all reactions on a specific message",
    readOnly: true,
    schema: z
      .strictObject({
        channel_id: z.string(),
        timestamp: z.string(),
      })
      .strict(),
  },
  {
    name: "slack_list_channel_members",
    description: "List the member user IDs of a channel with pagination",
    readOnly: true,
    schema: z
      .strictObject({
        channel_id: z.string(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
  },
] as const;

export const MUTATING_TOOL_NAMES = new Set<string>([
  "slack_post_message",
  "slack_reply_to_thread",
  "slack_add_reaction",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

type ToolJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

function toJsonSchema(schema: z.ZodTypeAny): ToolJsonSchema {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return {
    type: "object",
    properties: (json.properties as Record<string, unknown>) ?? {},
    required: (json.required as string[]) ?? [],
    additionalProperties: false,
  };
}

export function listTools() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toJsonSchema(tool.schema),
    ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));
}

export function listToolsForMcp() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.schema),
    ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));
}

export function executeTool(
  domain: SlackDomain,
  name: string,
  args: Record<string, unknown>,
  onDelta?: (delta: StateDelta) => void,
  actor: { login?: string } = {}
): unknown {
  const def = toolDefinitions.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown tool: ${name}`);
  const parsed = def.schema.parse(args);
  const delta = (d: StateDelta) => onDelta?.(d);
  switch (name) {
    case "slack_post_message": {
      const p = parsed as { channel_id: string; text: string };
      return domain.chatPostMessage({ channel: p.channel_id, text: p.text }, actor, delta);
    }
    case "slack_reply_to_thread": {
      const p = parsed as { channel_id: string; thread_ts: string; text: string };
      return domain.chatPostMessage(
        { channel: p.channel_id, thread_ts: p.thread_ts, text: p.text },
        actor,
        delta
      );
    }
    case "slack_add_reaction": {
      const p = parsed as { channel_id: string; timestamp: string; reaction: string };
      return domain.reactionsAdd(
        { channel: p.channel_id, timestamp: p.timestamp, name: p.reaction },
        actor,
        delta
      );
    }
    case "slack_get_channel_history": {
      const p = parsed as { channel_id: string; limit?: number };
      return domain.conversationsHistory({ channel: p.channel_id, limit: p.limit }, actor);
    }
    case "slack_get_thread_replies": {
      const p = parsed as { channel_id: string; thread_ts: string };
      return domain.conversationsReplies({ channel: p.channel_id, ts: p.thread_ts }, actor);
    }
    case "slack_list_channels": {
      const p = parsed as { limit?: number; cursor?: string };
      return domain.conversationsList({ limit: p.limit, cursor: p.cursor });
    }
    case "slack_get_users": {
      const p = parsed as { cursor?: string; limit?: number };
      return domain.usersList({ cursor: p.cursor, limit: p.limit });
    }
    case "slack_get_user_profile": {
      const p = parsed as { user_id: string };
      return domain.usersProfileGet({ user: p.user_id }, actor);
    }
    case "slack_search_messages": {
      const p = parsed as { query: string; count?: number; page?: number };
      return domain.searchMessages({ query: p.query, count: p.count, page: p.page }, actor);
    }
    case "slack_get_reactions": {
      const p = parsed as { channel_id: string; timestamp: string };
      return domain.reactionsGet({ channel: p.channel_id, timestamp: p.timestamp }, actor);
    }
    case "slack_list_channel_members": {
      const p = parsed as { channel_id: string; limit?: number; cursor?: string };
      return domain.conversationsMembers(
        { channel: p.channel_id, limit: p.limit, cursor: p.cursor },
        actor
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
