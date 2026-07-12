// SPDX-License-Identifier: Apache-2.0
//
// fidelity:parity — declarative parity scenario for twin-slack (F-730).
// The runner lives in @pome-sh/sdk/parity; this file is scenario data only:
// an ordered, stateful chain (post → thread → reaction → reads) that
// exercises every MCP tool in fidelity.inventory.json against the seeded
// workspace, plus the loud-501 probe for an unsupported Web API method.
//
// Slack answers HTTP 200 with `{ok:false, error}` on API errors, so every
// step also asserts the Slack envelope's own ok flag.

import { join } from "node:path";
import { loadFidelityInventory, runParityCli, type ParityStep } from "@pome-sh/sdk/parity";
import { defaultSeedState } from "../src/seed.js";
import { createSlackTwinApp } from "../src/twin.js";
import { listTools } from "../src/tools.js";

type SlackEnvelope = { ok?: boolean; error?: string };

const steps: ParityStep[] = [
  {
    tool: "slack_list_channels",
    capture: (body, state) => {
      const channels = (body as { channels?: Array<{ id?: string; name?: string }> }).channels ?? [];
      state.channelId = channels.find((channel) => channel.name === "general")?.id;
    },
  },
  {
    tool: "slack_post_message",
    arguments: (state) => ({ channel_id: state.channelId, text: "Parity message" }),
    capture: (body, state) => {
      state.ts = (body as { ts?: string }).ts;
    },
  },
  { tool: "slack_reply_to_thread", arguments: (state) => ({ channel_id: state.channelId, thread_ts: state.ts, text: "Parity reply" }) },
  { tool: "slack_add_reaction", arguments: (state) => ({ channel_id: state.channelId, timestamp: state.ts, reaction: "thumbsup" }) },
  { tool: "slack_get_channel_history", arguments: (state) => ({ channel_id: state.channelId }) },
  { tool: "slack_get_thread_replies", arguments: (state) => ({ channel_id: state.channelId, thread_ts: state.ts }) },
  {
    tool: "slack_get_users",
    capture: (body, state) => {
      const members = (body as { members?: Array<{ id?: string; name?: string }> }).members ?? [];
      state.aliceId = members.find((member) => member.name === "alice")?.id;
    },
  },
  { tool: "slack_get_user_profile", arguments: (state) => ({ user_id: state.aliceId }) },
  // F-736 hot-gap read tools: search the posted message, read back the
  // reaction added above, list the members of the channel we posted into.
  {
    tool: "slack_search_messages",
    arguments: { query: "Parity" },
    verify: (body) => {
      const matches = (body as { messages?: { matches?: unknown[] } }).messages?.matches ?? [];
      return matches.length > 0 ? undefined : "search returned no match for the posted message";
    },
  },
  {
    tool: "slack_get_reactions",
    arguments: (state) => ({ channel_id: state.channelId, timestamp: state.ts }),
    verify: (body) => {
      const reactions = (body as { message?: { reactions?: Array<{ name?: string }> } }).message?.reactions ?? [];
      return reactions.some((r) => r.name === "thumbsup")
        ? undefined
        : "reactions read did not include the thumbsup added earlier";
    },
  },
  {
    tool: "slack_list_channel_members",
    arguments: (state) => ({ channel_id: state.channelId }),
    verify: (body) => {
      const members = (body as { members?: string[] }).members ?? [];
      return members.length > 0 ? undefined : "channel member list came back empty";
    },
  },
];

await runParityCli({
  app: createSlackTwinApp({ seed: defaultSeedState() }),
  twin: "slack",
  inventory: loadFidelityInventory(join(import.meta.dirname, "..", "fidelity.inventory.json")),
  liveToolNames: listTools().map((tool) => tool.name),
  steps,
  claims: { team_id: "T_POME", login: "pome-agent" },
  stepVerify: (body) => {
    const envelope = body as SlackEnvelope;
    return envelope.ok === false ? `slack error envelope: ${envelope.error ?? "unknown"}` : undefined;
  },
  restProbes: [
    { surface: "unsupported-rest", method: "POST", path: "/admin.conversations.search", status: 501, expectUnsupportedEnvelope: true },
    // Named cold rows (F-729 ruling / F-736): the loud 501 is part of the contract.
    { surface: "cold:chat.postEphemeral", method: "POST", path: "/chat.postEphemeral", status: 501, expectUnsupportedEnvelope: true },
    { surface: "cold:files.getUploadURLExternal", method: "GET", path: "/files.getUploadURLExternal", status: 501, expectUnsupportedEnvelope: true },
    { surface: "cold:usergroups.list", method: "GET", path: "/usergroups.list", status: 501, expectUnsupportedEnvelope: true },
    { surface: "cold:views.publish", method: "POST", path: "/views.publish", status: 501, expectUnsupportedEnvelope: true },
  ],
});
