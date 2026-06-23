import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { executeTool } from "../src/tools.js";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return domain;
}

describe("executeTool", () => {
  const actor = { login: "pome-agent" };

  it("runs all 8 tools", () => {
    const domain = fresh();
    const parent = executeTool(
      domain,
      "slack_post_message",
      { channel_id: "C_GENERAL", text: "parent" },
      undefined,
      actor
    ) as { ts: string };

    executeTool(domain, "slack_reply_to_thread", {
      channel_id: "C_GENERAL",
      thread_ts: parent.ts,
      text: "reply",
    }, undefined, actor);

    executeTool(domain, "slack_add_reaction", {
      channel_id: "C_GENERAL",
      timestamp: parent.ts,
      reaction: "eyes",
    }, undefined, actor);

    const history = executeTool(
      domain,
      "slack_get_channel_history",
      { channel_id: "C_GENERAL", limit: 5 },
      undefined,
      actor
    ) as { messages: unknown[] };
    expect(history.messages.length).toBeGreaterThan(0);

    const replies = executeTool(
      domain,
      "slack_get_thread_replies",
      { channel_id: "C_GENERAL", thread_ts: parent.ts },
      undefined,
      actor
    ) as { messages: unknown[] };
    expect(replies.messages.length).toBeGreaterThan(1);

    const channels = executeTool(domain, "slack_list_channels", { limit: 2 }, undefined, actor) as {
      channels: unknown[];
    };
    expect(channels.channels.length).toBe(2);

    const users = executeTool(domain, "slack_get_users", { limit: 3 }, undefined, actor) as {
      members: unknown[];
    };
    expect(users.members.length).toBeGreaterThan(0);

    const profile = executeTool(
      domain,
      "slack_get_user_profile",
      { user_id: "U_ALICE" },
      undefined,
      actor
    ) as { profile: { real_name: string } };
    expect(profile.profile.real_name).toBe("Alice");
  });
});
