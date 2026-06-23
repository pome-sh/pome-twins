import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { nowUnix } from "../src/util.js";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { db, domain };
}

describe("SlackDomain chat", () => {
  it("chat.update forbidden for non-author non-admin", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage({ channel: "C_GENERAL", text: "mine" }, { login: "alice" }) as {
      ts: string;
    };
    expect(() =>
      domain.chatUpdate({ channel: "C_GENERAL", ts: posted.ts, text: "hijack" }, { login: "bob" })
    ).toThrow(/cant_update_message/);
  });

  it("chat.update forbidden for admin acting on someone else's message", () => {
    const { domain } = fresh();
    // alice posts; pome-agent is admin (seeded U_PRIMARY)
    const posted = domain.chatPostMessage({ channel: "C_GENERAL", text: "alice's" }, { login: "alice" }) as {
      ts: string;
    };
    expect(() =>
      domain.chatUpdate({ channel: "C_GENERAL", ts: posted.ts, text: "admin override" }, { login: "pome-agent" })
    ).toThrow(/cant_update_message/);
  });

  it("chat.delete forbidden for admin acting on someone else's message", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage({ channel: "C_GENERAL", text: "alice's" }, { login: "alice" }) as {
      ts: string;
    };
    expect(() =>
      domain.chatDelete({ channel: "C_GENERAL", ts: posted.ts }, { login: "pome-agent" })
    ).toThrow(/cant_delete_message/);
  });

  it("chat.scheduleMessage rejects time in the past", () => {
    const { domain } = fresh();
    expect(() =>
      domain.chatScheduleMessage(
        { channel: "C_GENERAL", text: "later", post_at: nowUnix() - 10 },
        { login: "pome-agent" }
      )
    ).toThrow(/time_in_past/);
  });

  it("cannot post to archived channel", () => {
    const { domain } = fresh();
    const ch = domain.conversationsCreate({ name: "temp-archive" }, { login: "pome-agent" }) as {
      channel: { id: string };
    };
    domain.conversationsArchive({ channel: ch.channel.id }, { login: "pome-agent" });
    expect(() =>
      domain.chatPostMessage({ channel: ch.channel.id, text: "nope" }, { login: "pome-agent" })
    ).toThrow(/is_archived/);
  });

  it("chat.update advances edited_ts so consecutive edits never collide", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "first" },
      { login: "pome-agent" }
    ) as { ts: string };
    const firstEdit = domain.chatUpdate(
      { channel: "C_GENERAL", ts: posted.ts, text: "second" },
      { login: "pome-agent" }
    ) as { message: { edited: { ts: string } } };
    const secondEdit = domain.chatUpdate(
      { channel: "C_GENERAL", ts: posted.ts, text: "third" },
      { login: "pome-agent" }
    ) as { message: { edited: { ts: string } } };
    expect(firstEdit.message.edited.ts).not.toBe(secondEdit.message.edited.ts);
    expect(Number(secondEdit.message.edited.ts)).toBeGreaterThan(Number(firstEdit.message.edited.ts));
  });

  it("bot identity: bot_id, app_id, bot_profile emitted for bot author", () => {
    const { domain } = fresh();
    domain.applySeed({
      users: [{ id: "B_HELPER", name: "helper-bot", is_bot: true }],
      channels: [{ id: "C_BOTS", name: "bots", members: ["B_HELPER"] }],
    } as Parameters<typeof domain.applySeed>[0]);
    const posted = domain.chatPostMessage(
      { channel: "C_BOTS", text: "ping" },
      { login: "helper-bot" }
    ) as { message: { bot_id?: string; app_id?: string; subtype?: string; bot_profile?: { id: string; name: string } } };
    expect(posted.message.subtype).toBe("bot_message");
    expect(posted.message.bot_id).toBe("B_HELPER");
    expect(posted.message.app_id).toBe("A_POME");
    expect(posted.message.bot_profile?.id).toBe("B_HELPER");
  });

  it("user posts do not emit bot_id / bot_profile", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage({ channel: "C_GENERAL", text: "hi" }, { login: "alice" }) as {
      message: Record<string, unknown>;
    };
    expect(posted.message.bot_id).toBeUndefined();
    expect(posted.message.bot_profile).toBeUndefined();
    expect(posted.message.app_id).toBeUndefined();
  });

  it("chat.postMessage persists username and icon_emoji on the message row", () => {
    const { db, domain } = fresh();
    const posted = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "custom", username: "MyBot", icon_emoji: ":robot_face:" },
      { login: "pome-agent" }
    ) as { ts: string; message: { username?: string; icons?: { emoji?: string } } };
    const row = db
      .prepare(`SELECT username, icon_emoji FROM messages WHERE channel_id = ? AND ts = ?`)
      .get("C_GENERAL", posted.ts) as { username: string; icon_emoji: string };
    expect(row.username).toBe("MyBot");
    expect(row.icon_emoji).toBe(":robot_face:");
    expect(posted.message.username).toBe("MyBot");
    expect(posted.message.icons?.emoji).toBe(":robot_face:");
  });

  it("ts is workspace-globally-unique across channels", () => {
    const { domain } = fresh();
    const inGeneral = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "in-general" },
      { login: "pome-agent" }
    ) as { ts: string };
    const inRandom = domain.chatPostMessage(
      { channel: "C_RANDOM", text: "in-random" },
      { login: "pome-agent" }
    ) as { ts: string };
    expect(inGeneral.ts).not.toBe(inRandom.ts);
    expect(Number(inRandom.ts)).toBeGreaterThan(Number(inGeneral.ts));
  });

  it("conversations.replies decorates the parent with thread_ts === ts", () => {
    const { domain } = fresh();
    const parent = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "parent" },
      { login: "pome-agent" }
    ) as { ts: string };
    domain.chatPostMessage(
      { channel: "C_GENERAL", text: "reply 1", thread_ts: parent.ts },
      { login: "alice" }
    );
    const replies = domain.conversationsReplies(
      { channel: "C_GENERAL", ts: parent.ts },
      { login: "pome-agent" }
    ) as { messages: Array<{ ts: string; thread_ts?: string; subscribed?: boolean; is_locked?: boolean; parent_user_id?: string }> };
    const decoratedParent = replies.messages.find((m) => m.ts === parent.ts)!;
    expect(decoratedParent.thread_ts).toBe(parent.ts);
    expect(decoratedParent.subscribed).toBe(false);
    expect(decoratedParent.is_locked).toBe(false);
    const reply = replies.messages.find((m) => m.ts !== parent.ts)!;
    expect(reply.thread_ts).toBe(parent.ts);
    expect(reply.parent_user_id).toBe("U_PRIMARY");
  });

  it("edited_ts does not collide with a subsequent postMessage ts", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "first" },
      { login: "pome-agent" }
    ) as { ts: string };
    const edited = domain.chatUpdate(
      { channel: "C_GENERAL", ts: posted.ts, text: "second" },
      { login: "pome-agent" }
    ) as { message: { edited: { ts: string } } };
    const next = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "after-edit" },
      { login: "pome-agent" }
    ) as { ts: string };
    expect(edited.message.edited.ts).not.toBe(next.ts);
  });
});
