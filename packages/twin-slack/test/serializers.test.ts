// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  groupReactions,
  safeJson,
  safeJsonArray,
  serializeChannel,
  serializeMessage,
  slackError,
  slackOk,
  tsToUnix,
} from "../src/serializers.js";
import type { ChannelRow, MessageRow, ReactionRow } from "../src/types.js";

describe("serializer helpers", () => {
  it("safeJson returns parsed object", () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("safeJson returns {} on malformed JSON", () => {
    expect(safeJson("not-json")).toEqual({});
  });

  it("safeJsonArray returns parsed array", () => {
    expect(safeJsonArray("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("safeJsonArray returns [] for non-array JSON", () => {
    expect(safeJsonArray('{"a":1}')).toEqual([]);
  });

  it("safeJsonArray returns [] on malformed JSON", () => {
    expect(safeJsonArray("garbage")).toEqual([]);
  });

  it("tsToUnix parses ISO timestamps", () => {
    expect(tsToUnix("2026-01-01T00:00:00.000Z")).toBe(1767225600);
  });

  it("tsToUnix returns 0 for unparseable input", () => {
    expect(tsToUnix("not-a-date")).toBe(0);
  });

  it("slackOk wraps payload with ok:true", () => {
    expect(slackOk({ foo: "bar" })).toEqual({ ok: true, foo: "bar" });
  });

  it("slackError wraps code + extras", () => {
    expect(slackError("channel_not_found", { warning: "x" })).toEqual({
      ok: false,
      error: "channel_not_found",
      warning: "x",
    });
  });
});

describe("groupReactions", () => {
  it("groups same-name reactions by name with users list", () => {
    const rows: ReactionRow[] = [
      { channel_id: "c", message_ts: "1.0", name: "fire", user_id: "U1", added_at: "" },
      { channel_id: "c", message_ts: "1.0", name: "fire", user_id: "U2", added_at: "" },
      { channel_id: "c", message_ts: "1.0", name: "rocket", user_id: "U1", added_at: "" },
    ];
    const grouped = groupReactions(rows);
    const fire = grouped.find((g) => g.name === "fire")!;
    expect(fire.count).toBe(2);
    expect(fire.users).toEqual(["U1", "U2"]);
    const rocket = grouped.find((g) => g.name === "rocket")!;
    expect(rocket.count).toBe(1);
  });
});

describe("serializeMessage edge cases", () => {
  const baseRow: MessageRow = {
    channel_id: "C_X",
    ts: "1.000001",
    user_id: "U1",
    text: "hi",
    subtype: null,
    thread_ts: null,
    reply_count: 0,
    reply_users_count: 0,
    latest_reply: null,
    edited_user_id: null,
    edited_ts: null,
    blocks_json: "[]",
    attachments_json: "[]",
    bot_id: null,
    app_id: null,
    username: null,
    icon_url: null,
    icon_emoji: null,
  };

  it("falls back to ID-prefix bot detection for legacy rows with no bot_id column", () => {
    const legacy: MessageRow = { ...baseRow, user_id: "B_LEGACY", bot_id: null };
    const out = serializeMessage(legacy) as { bot_id?: string };
    expect(out.bot_id).toBe("B_LEGACY");
  });

  it("does not emit bot_id when user_id is a normal user and bot_id column is null", () => {
    const userRow: MessageRow = { ...baseRow, user_id: "U_ALICE", bot_id: null };
    const out = serializeMessage(userRow) as { bot_id?: string };
    expect(out.bot_id).toBeUndefined();
  });

  it("respects malformed JSON in blocks_json by emitting empty arrays", () => {
    const corrupt: MessageRow = { ...baseRow, blocks_json: "{not-valid-json", attachments_json: "x" };
    const out = serializeMessage(corrupt) as { blocks?: unknown[]; attachments?: unknown[] };
    // safeJsonArray returns [] for both; serializer omits the field entirely
    // when the array is empty.
    expect(out.blocks).toBeUndefined();
    expect(out.attachments).toBeUndefined();
  });
});

describe("serializeChannel edge cases", () => {
  const baseChannel: ChannelRow = {
    id: "C_X",
    team_id: "T_X",
    name: "test",
    is_channel: 1,
    is_group: 0,
    is_im: 0,
    is_mpim: 0,
    is_private: 0,
    is_archived: 0,
    topic: "",
    purpose: "",
    creator: "U_X",
    created_at: "2026-01-01T00:00:00.000Z",
    ts_counter: 0,
    dm_signature: null,
  };

  it("marks #general with is_general:true", () => {
    const general: ChannelRow = { ...baseChannel, name: "general" };
    const out = serializeChannel(general) as { is_general: boolean };
    expect(out.is_general).toBe(true);
  });

  it("marks private channels with is_group:true when not a DM", () => {
    const priv: ChannelRow = { ...baseChannel, is_private: 1, name: "secrets" };
    const out = serializeChannel(priv) as { is_group: boolean; is_private: boolean };
    expect(out.is_private).toBe(true);
    expect(out.is_group).toBe(true);
  });

  it("DM channels have is_im:true and is_channel:false", () => {
    const dm: ChannelRow = { ...baseChannel, is_im: 1, is_channel: 0, name: "" };
    const out = serializeChannel(dm) as { is_im: boolean; is_channel: boolean };
    expect(out.is_im).toBe(true);
    expect(out.is_channel).toBe(false);
  });
});
