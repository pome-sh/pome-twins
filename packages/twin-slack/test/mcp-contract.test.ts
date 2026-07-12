// SPDX-License-Identifier: Apache-2.0
//
// MCP tools contract — pins the 11 visible Slack-agent tools' shapes so any
// drift (added/removed/renamed tool, changed description, changed required
// fields, changed mutating set) breaks this test loudly. Constants are
// declared in-test so the contract has no external dependency.

import { describe, expect, it } from "vitest";
import { listToolsForMcp, listTools, MUTATING_TOOL_NAMES, toolDefinitions } from "../src/tools.js";

interface ExpectedTool {
  name: string;
  description: string;
  required: string[];
  readOnly: boolean;
}

const EXPECTED_TOOLS: ExpectedTool[] = [
  {
    name: "slack_post_message",
    description: "Post a new message to a Slack channel",
    required: ["channel_id", "text"],
    readOnly: false,
  },
  {
    name: "slack_reply_to_thread",
    description: "Reply to a specific message thread in Slack",
    required: ["channel_id", "thread_ts", "text"],
    readOnly: false,
  },
  {
    name: "slack_add_reaction",
    description: "Add a reaction emoji to a message",
    required: ["channel_id", "timestamp", "reaction"],
    readOnly: false,
  },
  {
    name: "slack_get_channel_history",
    description: "Get recent messages from a channel",
    required: ["channel_id"],
    readOnly: true,
  },
  {
    name: "slack_get_thread_replies",
    description: "Get all replies in a message thread",
    required: ["channel_id", "thread_ts"],
    readOnly: true,
  },
  {
    name: "slack_list_channels",
    description: "List public or pre-defined channels in the workspace with pagination",
    required: [],
    readOnly: true,
  },
  {
    name: "slack_get_users",
    description: "Get a list of all users in the workspace with their basic profile information",
    required: [],
    readOnly: true,
  },
  {
    name: "slack_get_user_profile",
    description: "Get detailed profile information for a specific user",
    required: ["user_id"],
    readOnly: true,
  },
  {
    name: "slack_search_messages",
    description: "Search messages in the workspace by text query",
    required: ["query"],
    readOnly: true,
  },
  {
    name: "slack_get_reactions",
    description: "Get all reactions on a specific message",
    required: ["channel_id", "timestamp"],
    readOnly: true,
  },
  {
    name: "slack_list_channel_members",
    description: "List the member user IDs of a channel with pagination",
    required: ["channel_id"],
    readOnly: true,
  },
];

const EXPECTED_NAMES = EXPECTED_TOOLS.map((t) => t.name).sort();
const EXPECTED_MUTATORS = new Set(EXPECTED_TOOLS.filter((t) => !t.readOnly).map((t) => t.name));

describe("MCP tools contract", () => {
  it("exposes exactly the 11 visible Slack-agent tools", () => {
    expect(toolDefinitions.map((t) => t.name).sort()).toEqual(EXPECTED_NAMES);
    expect(EXPECTED_TOOLS.length).toBe(11);
  });

  it("MUTATING_TOOL_NAMES contains the 3 write tools (no readOnlyHint)", () => {
    expect(EXPECTED_MUTATORS.size).toBe(3);
    expect(MUTATING_TOOL_NAMES).toEqual(EXPECTED_MUTATORS);
  });

  it("each visible tool emits additionalProperties:false JSON-Schema", () => {
    for (const tool of listToolsForMcp()) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("tool descriptions are pinned exactly", () => {
    const byName = new Map(EXPECTED_TOOLS.map((t) => [t.name, t]));
    for (const tool of toolDefinitions) {
      const expected = byName.get(tool.name);
      expect(expected, `tool ${tool.name} missing from EXPECTED_TOOLS`).toBeDefined();
      expect(tool.description).toBe(expected!.description);
    }
  });

  it("tool required-fields match the pinned set exactly", () => {
    const byName = new Map(EXPECTED_TOOLS.map((t) => [t.name, t]));
    for (const tool of listToolsForMcp()) {
      const expected = byName.get(tool.name)!;
      const actualRequired = [...tool.inputSchema.required].sort();
      const expectedRequired = [...expected.required].sort();
      expect(actualRequired).toEqual(expectedRequired);
    }
  });

  it("listTools() returns snake_case input_schema (legacy)", () => {
    const tools = listTools();
    expect(tools.length).toBe(11);
    expect(tools[0]).toHaveProperty("input_schema");
  });

  it("listToolsForMcp() returns camelCase inputSchema (MCP spec)", () => {
    const tools = listToolsForMcp();
    expect(tools.length).toBe(11);
    expect(tools[0]).toHaveProperty("inputSchema");
  });

  it("readOnlyHint is present on read tools, absent on mutators", () => {
    const tools = listToolsForMcp();
    const mutators = tools.filter((t) => !("annotations" in t));
    const readers = tools.filter((t) => t.annotations?.readOnlyHint === true);
    expect(mutators.length).toBe(3);
    expect(readers.length).toBe(8);
  });
});
