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
import { normalizeReactionName } from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// Reactions
// ───────────────────────────────────────────────────────────────────────────

export function reactionsAdd(domain: SlackDomain, args: { channel: string; timestamp: string; name: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  if (!args.name) slackError("no_reaction", 400);
  const channel = domain.requireChannel(args.channel);
  const message = domain.db
    .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
    .get(channel.id, args.timestamp) as MessageRow | undefined;
  if (!message) slackError("message_not_found", 404);
  const acting = domain.resolveActorUser(actor);
  const reaction = normalizeReactionName(args.name);
  const out = domain.db.transaction(() => {
    const existing = domain.db
      .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
      .get(channel.id, args.timestamp, reaction, acting.id);
    if (existing) slackError("already_reacted", 400);
    const now = nowIso();
    domain.db
      .prepare(`INSERT INTO reactions (channel_id, message_ts, name, user_id, added_at) VALUES (?, ?, ?, ?, ?)`)
      .run(channel.id, args.timestamp, reaction, acting.id, now);
    const after = domain.db
      .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
      .get(channel.id, args.timestamp, reaction, acting.id) as ReactionRow;
    onDelta({ before: null, after });
    return {};
  })();
  return out;
}


export function reactionsRemove(domain: SlackDomain, args: { channel: string; timestamp: string; name: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  if (!args.name) slackError("no_reaction", 400);
  const channel = domain.requireChannel(args.channel);
  const acting = domain.resolveActorUser(actor);
  const reaction = normalizeReactionName(args.name);
  const before = domain.db
    .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
    .get(channel.id, args.timestamp, reaction, acting.id) as ReactionRow | undefined;
  if (!before) slackError("no_reaction", 404);
  const out = domain.db.transaction(() => {
    domain.db
      .prepare(`DELETE FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
      .run(channel.id, args.timestamp, reaction, acting.id);
    onDelta({ before, after: null });
    return {};
  })();
  return out;
}


export function reactionsGet(domain: SlackDomain, args: { channel: string; timestamp: string; full?: boolean }, actor: Actor = {}): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  domain.assertChannelMemberForActor(channel, actor);
  const message = domain.db
    .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
    .get(channel.id, args.timestamp) as MessageRow | undefined;
  if (!message) slackError("message_not_found", 404);
  const reactions = domain.reactionsFor(channel.id, args.timestamp);
  return {
    type: "message",
    channel: channel.id,
    message: { ...serializeMessage(message!, { reactions }) },
  };
}

