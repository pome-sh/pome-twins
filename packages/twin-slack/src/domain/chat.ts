// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";
import { slackError, notFound, TwinError } from "../errors.js";
import {
  groupReactions,
  serializeBookmark,
  serializeChannel,
  serializeFile,
  serializeMessage,
  serializePin,
  serializeScheduledMessage,
  serializeUser,
  serializeUserProfile,
  serializeWorkspace,
} from "../serializers.js";
import type {
  BookmarkRow,
  ChannelMemberRow,
  ChannelRow,
  FileRow,
  MessageRow,
  PinRow,
  ReactionRow,
  ScheduledMessageRow,
  SlackTwinDatabase,
  UserRow,
  WorkspaceRow,
} from "../types.js";
import { cursorDecode, cursorEncode, nowIso, nowUnix, padTsCounter, tsBaseSeconds } from "../util.js";
import type { Actor, DeltaHook, SlackDomain } from "./slack-domain.js";
import { NOOP } from "./slack-domain.js";
import { sanitizeJsonString } from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// Chat
// ───────────────────────────────────────────────────────────────────────────

export function chatPostMessage(domain: SlackDomain, 
  args: {
    channel: string;
    text?: string;
    blocks?: string;
    attachments?: string;
    thread_ts?: string;
    reply_broadcast?: boolean;
    icon_emoji?: string;
    icon_url?: string;
    username?: string;
    as_user?: boolean;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
    mrkdwn?: boolean;
    link_names?: boolean;
    parse?: string;
  },
  actor: Actor,
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.is_archived) slackError("is_archived", 400);
  if (!args.text && !args.blocks && !args.attachments) slackError("no_text", 400);
  if (args.thread_ts) {
    const parent = domain.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.thread_ts) as MessageRow | undefined;
    if (!parent) slackError("thread_not_found", 404);
  }
  const author = domain.resolveActorUser(actor);
  if (channel.is_private || channel.is_im || channel.is_mpim) {
    const member = domain.db
      .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, author.id);
    if (!member) slackError("not_in_channel", 400);
  }
  const ts = domain.allocMessageTs(channel.id);
  const blocks = args.blocks ? sanitizeJsonString(args.blocks, "[]") : "[]";
  const attachments = args.attachments ? sanitizeJsonString(args.attachments, "[]") : "[]";
  const subtype = author.is_bot ? "bot_message" : null;
  // For bot authors: bot_id = the bot user's id; app_id = synthetic A_POME so
  // SDK consumers see a non-null app_id consistent with real Slack.
  const botId = author.is_bot ? author.id : null;
  const appId = author.is_bot ? "A_POME" : null;
  const username = typeof args.username === "string" && args.username.length > 0 ? args.username : null;
  const iconUrl = typeof args.icon_url === "string" && args.icon_url.length > 0 ? args.icon_url : null;
  const iconEmoji = typeof args.icon_emoji === "string" && args.icon_emoji.length > 0 ? args.icon_emoji : null;
  const out = domain.db.transaction(() => {
    domain.db
      .prepare(
        `INSERT INTO messages (channel_id, ts, user_id, text, subtype, thread_ts, blocks_json, attachments_json,
                               bot_id, app_id, username, icon_url, icon_emoji)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        channel.id,
        ts,
        author.id,
        args.text ?? "",
        subtype,
        args.thread_ts ?? null,
        blocks,
        attachments,
        botId,
        appId,
        username,
        iconUrl,
        iconEmoji
      );
    if (args.thread_ts) {
      domain.db
        .prepare(
          `UPDATE messages SET reply_count = reply_count + 1, latest_reply = ?,
            reply_users_count = (
              SELECT COUNT(DISTINCT user_id) FROM messages WHERE channel_id = ? AND thread_ts = ?
            )
           WHERE channel_id = ? AND ts = ?`
        )
        .run(ts, channel.id, args.thread_ts, channel.id, args.thread_ts);
    }
    const row = domain.requireMessageRow(channel.id, ts);
    onDelta({ before: null, after: row });
    const workspaceId = domain.requireWorkspace().id;
    return { channel: channel.id, ts, message: serializeMessage(row, { include_team: workspaceId }) };
  })();
  return out;
}


export function chatUpdate(domain: SlackDomain, 
  args: { channel: string; ts: string; text?: string; blocks?: string; attachments?: string },
  actor: Actor,
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.is_archived) slackError("is_archived", 400);
  const acting = domain.resolveActorUser(actor);
  const before = domain.db
    .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
    .get(channel.id, args.ts) as MessageRow | undefined;
  if (!before) slackError("message_not_found", 404);
  // Real Slack has no admin override at the API layer — only the message's
  // author may update their own message. Single-tenant sandbox semantics:
  // the JWT's `login` claim identifies the acting user.
  if (before!.user_id !== acting.id) slackError("cant_update_message", 403);
  const out = domain.db.transaction(() => {
    const updatedTs = domain.allocMessageTs(channel.id);
    const newText = args.text ?? before!.text;
    const newBlocks = args.blocks ? sanitizeJsonString(args.blocks, before!.blocks_json) : before!.blocks_json;
    const newAttachments = args.attachments
      ? sanitizeJsonString(args.attachments, before!.attachments_json)
      : before!.attachments_json;
    domain.db
      .prepare(
        `UPDATE messages SET text = ?, blocks_json = ?, attachments_json = ?, edited_user_id = ?, edited_ts = ? WHERE channel_id = ? AND ts = ?`
      )
      .run(newText, newBlocks, newAttachments, acting.id, updatedTs, channel.id, args.ts);
    const after = domain.requireMessageRow(channel.id, args.ts);
    onDelta({ before, after });
    return { channel: channel.id, ts: args.ts, text: after.text, message: serializeMessage(after) };
  })();
  return out;
}


export function chatDelete(domain: SlackDomain, args: { channel: string; ts: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  const acting = domain.resolveActorUser(actor);
  const before = domain.db
    .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
    .get(channel.id, args.ts) as MessageRow | undefined;
  if (!before) slackError("message_not_found", 404);
  // Real Slack has no admin override on chat.delete — only the author may delete.
  if (before!.user_id !== acting.id) slackError("cant_delete_message", 403);
  const out = domain.db.transaction(() => {
    domain.db.prepare(`DELETE FROM messages WHERE channel_id = ? AND ts = ?`).run(channel.id, args.ts);
    // Decrement thread parent if this was a reply.
    if (before!.thread_ts) {
      domain.db
        .prepare(
          `UPDATE messages SET reply_count = MAX(reply_count - 1, 0),
            reply_users_count = (
              SELECT COUNT(DISTINCT user_id) FROM messages WHERE channel_id = ? AND thread_ts = ?
            ),
            latest_reply = (
              SELECT ts FROM messages WHERE channel_id = ? AND thread_ts = ? ORDER BY ts DESC LIMIT 1
            )
           WHERE channel_id = ? AND ts = ?`
        )
        .run(channel.id, before!.thread_ts, channel.id, before!.thread_ts, channel.id, before!.thread_ts);
    }
    onDelta({ before, after: null });
    return { channel: channel.id, ts: args.ts };
  })();
  return out;
}


export function chatScheduleMessage(domain: SlackDomain, 
  args: { channel: string; text: string; post_at: number; thread_ts?: string; blocks?: string },
  actor: Actor,
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.is_archived) slackError("is_archived", 400);
  if (!args.text) slackError("no_text", 400);
  if (!args.post_at || args.post_at <= nowUnix()) slackError("time_in_past", 400);
  const acting = domain.resolveActorUser(actor);
  const id = domain.allocId(domain.requireWorkspace().id, "Q");
  const now = nowUnix();
  const out = domain.db.transaction(() => {
    domain.db
      .prepare(
        `INSERT INTO scheduled_messages (id, channel_id, user_id, text, thread_ts, post_at, date_created, blocks_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, channel.id, acting.id, args.text, args.thread_ts ?? null, args.post_at, now, args.blocks ? sanitizeJsonString(args.blocks, "[]") : "[]");
    const row = domain.requireScheduledMessage(id);
    onDelta({ before: null, after: row });
    return {
      channel: channel.id,
      scheduled_message_id: id,
      post_at: args.post_at,
      message: { text: args.text, type: "delayed_message" },
    };
  })();
  return out;
}


export function chatDeleteScheduledMessage(domain: SlackDomain, args: { channel: string; scheduled_message_id: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  void actor;
  const channel = domain.requireChannel(args.channel);
  const row = domain.db
    .prepare(`SELECT * FROM scheduled_messages WHERE id = ? AND channel_id = ?`)
    .get(args.scheduled_message_id, channel.id) as ScheduledMessageRow | undefined;
  if (!row) slackError("scheduled_message_not_found", 404);
  const out = domain.db.transaction(() => {
    domain.db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`).run(row!.id);
    onDelta({ before: row, after: null });
    return {};
  })();
  return out;
}

