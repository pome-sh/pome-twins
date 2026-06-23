import { beforeEach, describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";

process.env.SLACK_DETERMINISTIC_TS = "1";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { db, domain };
}

describe("SlackDomain — direct unit coverage", () => {
  it("seeds three users and two channels", () => {
    const { domain } = fresh();
    const state = domain.exportState() as {
      users: unknown[];
      channels: Array<{ id: string; messages: unknown[] }>;
    };
    expect(state.users.length).toBe(3);
    expect(state.channels.map((c) => c.id).sort()).toEqual(["C_GENERAL", "C_RANDOM"]);
    expect(state.channels.find((c) => c.id === "C_GENERAL")!.messages.length).toBe(2);
  });

  it("chat.postMessage → conversations.history round-trip", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "hello" },
      { login: "pome-agent" }
    ) as { ts: string };
    const history = domain.conversationsHistory({ channel: "C_GENERAL" }) as {
      messages: Array<{ ts: string; text: string }>;
    };
    expect(history.messages.length).toBe(3);
    expect(history.messages[0]!.ts).toBe(posted.ts);
    expect(history.messages[0]!.text).toBe("hello");
  });

  it("thread parent → 2 replies → conversations.replies returns 3 in ASC order", () => {
    const { domain } = fresh();
    const parent = domain.chatPostMessage({ channel: "C_GENERAL", text: "parent" }, { login: "pome-agent" }) as {
      ts: string;
    };
    domain.chatPostMessage({ channel: "C_GENERAL", text: "r1", thread_ts: parent.ts }, { login: "alice" });
    domain.chatPostMessage({ channel: "C_GENERAL", text: "r2", thread_ts: parent.ts }, { login: "bob" });
    const replies = domain.conversationsReplies({ channel: "C_GENERAL", ts: parent.ts }) as {
      messages: Array<{ text: string }>;
    };
    expect(replies.messages.map((m) => m.text)).toEqual(["parent", "r1", "r2"]);
  });

  it("reply_count and reply_users_count get incremented on the parent", () => {
    const { db, domain } = fresh();
    const parent = domain.chatPostMessage({ channel: "C_GENERAL", text: "p" }, { login: "pome-agent" }) as {
      ts: string;
    };
    domain.chatPostMessage({ channel: "C_GENERAL", text: "r1", thread_ts: parent.ts }, { login: "alice" });
    domain.chatPostMessage({ channel: "C_GENERAL", text: "r2", thread_ts: parent.ts }, { login: "alice" });
    domain.chatPostMessage({ channel: "C_GENERAL", text: "r3", thread_ts: parent.ts }, { login: "bob" });
    const row = db.prepare(`SELECT reply_count, reply_users_count, latest_reply FROM messages WHERE ts = ?`).get(parent.ts) as {
      reply_count: number;
      reply_users_count: number;
      latest_reply: string;
    };
    expect(row.reply_count).toBe(3);
    expect(row.reply_users_count).toBe(2);
    expect(row.latest_reply).toMatch(/^\d+\.\d{6}$/);
  });

  it("chat.delete hard-removes the row and decrements thread parent counters", () => {
    const { db, domain } = fresh();
    const parent = domain.chatPostMessage({ channel: "C_GENERAL", text: "p" }, { login: "pome-agent" }) as {
      ts: string;
    };
    const reply = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "r", thread_ts: parent.ts },
      { login: "alice" }
    ) as { ts: string };
    domain.chatDelete({ channel: "C_GENERAL", ts: reply.ts }, { login: "alice" });
    const gone = db.prepare(`SELECT * FROM messages WHERE ts = ?`).get(reply.ts);
    expect(gone).toBeUndefined();
    const row = db.prepare(`SELECT reply_count FROM messages WHERE ts = ?`).get(parent.ts) as { reply_count: number };
    expect(row.reply_count).toBe(0);
  });

  it("chat.delete fails for non-author non-admin", () => {
    const { domain } = fresh();
    const posted = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "alice's msg" },
      { login: "alice" }
    ) as { ts: string };
    expect(() => domain.chatDelete({ channel: "C_GENERAL", ts: posted.ts }, { login: "bob" })).toThrow(/cant_delete_message/);
  });

  it("reactions are unique per (channel,ts,name,user)", () => {
    const { domain } = fresh();
    const post = domain.chatPostMessage(
      { channel: "C_GENERAL", text: "react" },
      { login: "pome-agent" }
    ) as { ts: string };
    domain.reactionsAdd({ channel: "C_GENERAL", timestamp: post.ts, name: "fire" }, { login: "alice" });
    expect(() =>
      domain.reactionsAdd({ channel: "C_GENERAL", timestamp: post.ts, name: "fire" }, { login: "alice" })
    ).toThrow(/already_reacted/);
  });

  it("users.lookupByEmail finds by exact email", () => {
    const { domain } = fresh();
    const res = domain.usersLookupByEmail({ email: "alice@pome-twin.slack.com" }) as { user: { id: string } };
    expect(res.user.id).toBe("U_ALICE");
  });

  it("users.profile.set updates profile and reflects in get", () => {
    const { domain } = fresh();
    domain.usersProfileSet(
      { user: "U_ALICE", profile: JSON.stringify({ status_text: "OOO", status_emoji: ":palm_tree:" }) },
      { login: "pome-agent" }
    );
    const got = domain.usersProfileGet({ user: "U_ALICE" }, { login: "pome-agent" }) as {
      profile: { status_text: string; status_emoji: string };
    };
    expect(got.profile.status_text).toBe("OOO");
    expect(got.profile.status_emoji).toBe(":palm_tree:");
  });

  it("pins flow: add → list → remove", () => {
    const { domain } = fresh();
    const post = domain.chatPostMessage({ channel: "C_GENERAL", text: "pinme" }, { login: "pome-agent" }) as {
      ts: string;
    };
    domain.pinsAdd({ channel: "C_GENERAL", timestamp: post.ts }, { login: "pome-agent" });
    const listed = domain.pinsList({ channel: "C_GENERAL" }) as { items: unknown[] };
    expect(listed.items.length).toBe(1);
    domain.pinsRemove({ channel: "C_GENERAL", timestamp: post.ts }, { login: "pome-agent" });
    const empty = domain.pinsList({ channel: "C_GENERAL" }) as { items: unknown[] };
    expect(empty.items.length).toBe(0);
  });

  it("bookmarks add/list/remove", () => {
    const { domain } = fresh();
    domain.bookmarksAdd(
      { channel_id: "C_GENERAL", title: "docs", type: "link", link: "https://pome.sh" },
      { login: "pome-agent" }
    );
    const listed = domain.bookmarksList({ channel_id: "C_GENERAL" }) as { bookmarks: Array<{ id: string; title: string }> };
    expect(listed.bookmarks.length).toBe(1);
    expect(listed.bookmarks[0]!.title).toBe("docs");
    domain.bookmarksRemove(
      { channel_id: "C_GENERAL", bookmark_id: listed.bookmarks[0]!.id },
      { login: "pome-agent" }
    );
    const empty = domain.bookmarksList({ channel_id: "C_GENERAL" }) as { bookmarks: unknown[] };
    expect(empty.bookmarks.length).toBe(0);
  });

  it("search.messages finds seeded text", () => {
    const { domain } = fresh();
    const res = domain.searchMessages({ query: "morning" }) as { messages: { total: number; matches: Array<{ text: string }> } };
    expect(res.messages.total).toBeGreaterThanOrEqual(2);
    expect(res.messages.matches.every((m) => m.text.includes("morning"))).toBe(true);
  });

  it("chat.update updates text and sets edited fields", () => {
    const { domain } = fresh();
    const post = domain.chatPostMessage({ channel: "C_GENERAL", text: "v1" }, { login: "pome-agent" }) as {
      ts: string;
    };
    domain.chatUpdate({ channel: "C_GENERAL", ts: post.ts, text: "v2" }, { login: "pome-agent" });
    const replies = domain.conversationsHistory({ channel: "C_GENERAL", limit: 5 }) as {
      messages: Array<{ ts: string; text: string; edited?: { user: string } }>;
    };
    const updated = replies.messages.find((m) => m.ts === post.ts);
    expect(updated?.text).toBe("v2");
    expect(updated?.edited?.user).toBe("U_PRIMARY");
  });

  it("files.upload metadata persists in files.info", () => {
    const { domain } = fresh();
    const up = domain.filesUpload(
      { filename: "hello.txt", content: "hello world", filetype: "text", channels: "C_GENERAL" },
      { login: "pome-agent" }
    ) as { file: { id: string } };
    const info = domain.filesInfo({ file: up.file.id }) as { file: { id: string; name: string } };
    expect(info.file.id).toBe(up.file.id);
    expect(info.file.name).toBe("hello.txt");
  });

  it("conversations.archive then list with exclude_archived hides it", () => {
    const { domain } = fresh();
    domain.conversationsArchive({ channel: "C_RANDOM" }, { login: "pome-agent" });
    const all = domain.conversationsList({ exclude_archived: true }) as { channels: Array<{ id: string }> };
    expect(all.channels.find((c) => c.id === "C_RANDOM")).toBeUndefined();
  });

  it("chat.postMessage with no text/blocks/attachments returns no_text", () => {
    const { domain } = fresh();
    expect(() => domain.chatPostMessage({ channel: "C_GENERAL" }, { login: "pome-agent" })).toThrow(/no_text/);
  });

  it("chat.postMessage with non-existent thread_ts returns thread_not_found", () => {
    const { domain } = fresh();
    expect(() =>
      domain.chatPostMessage(
        { channel: "C_GENERAL", text: "orphan", thread_ts: "9999999999.999999" },
        { login: "pome-agent" }
      )
    ).toThrow(/thread_not_found/);
  });

  it("usersLookupByEmail returns users_not_found for unknown email", () => {
    const { domain } = fresh();
    expect(() => domain.usersLookupByEmail({ email: "nobody@example.com" })).toThrow(/users_not_found/);
  });

  it("reactions.remove on non-reacted message returns no_reaction", () => {
    const { domain } = fresh();
    const post = domain.chatPostMessage({ channel: "C_GENERAL", text: "unreacted" }, { login: "pome-agent" }) as {
      ts: string;
    };
    expect(() =>
      domain.reactionsRemove({ channel: "C_GENERAL", timestamp: post.ts, name: "thumbsup" }, { login: "alice" })
    ).toThrow(/no_reaction/);
  });

  it("conversations.kick of self returns cant_kick_self", () => {
    const { domain } = fresh();
    const ch = domain.conversationsCreate({ name: "kick-self" }, { login: "pome-agent" }) as {
      channel: { id: string };
    };
    domain.conversationsInvite({ channel: ch.channel.id, users: "U_ALICE" }, { login: "pome-agent" });
    expect(() =>
      domain.conversationsKick({ channel: ch.channel.id, user: "U_PRIMARY" }, { login: "pome-agent" })
    ).toThrow(/cant_kick_self/);
  });

  it("conversations.kick from #general returns cant_kick_from_general", () => {
    const { domain } = fresh();
    expect(() =>
      domain.conversationsKick({ channel: "C_GENERAL", user: "U_ALICE" }, { login: "pome-agent" })
    ).toThrow(/cant_kick_from_general/);
  });

  it("chat.scheduleMessage + delete round-trip", () => {
    const { db, domain } = fresh();
    const future = Math.floor(Date.now() / 1000) + 300;
    const sched = domain.chatScheduleMessage(
      { channel: "C_GENERAL", text: "later", post_at: future },
      { login: "pome-agent" }
    ) as { scheduled_message_id: string };
    expect(sched.scheduled_message_id).toBeTruthy();
    domain.chatDeleteScheduledMessage(
      { channel: "C_GENERAL", scheduled_message_id: sched.scheduled_message_id },
      { login: "pome-agent" }
    );
    const remaining = db
      .prepare(`SELECT COUNT(*) AS c FROM scheduled_messages WHERE id = ?`)
      .get(sched.scheduled_message_id) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("conversations.invite same user twice returns already_in_channel on second", () => {
    const { domain } = fresh();
    const ch = domain.conversationsCreate({ name: "invite-twice" }, { login: "pome-agent" }) as {
      channel: { id: string };
    };
    domain.conversationsInvite({ channel: ch.channel.id, users: "U_ALICE" }, { login: "pome-agent" });
    expect(() =>
      domain.conversationsInvite({ channel: ch.channel.id, users: "U_ALICE" }, { login: "pome-agent" })
    ).toThrow(/already_in_channel/);
  });
});
