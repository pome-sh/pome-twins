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

// ───────────────────────────────────────────────────────────────────────────
// Pins
// ───────────────────────────────────────────────────────────────────────────

export function pinsAdd(domain: SlackDomain, args: { channel: string; timestamp: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  const message = domain.db
    .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
    .get(channel.id, args.timestamp) as MessageRow | undefined;
  if (!message) slackError("message_not_found", 404);
  const acting = domain.resolveActorUser(actor);
  const out = domain.db.transaction(() => {
    const existing = domain.db
      .prepare(`SELECT * FROM pins WHERE channel_id = ? AND message_ts = ?`)
      .get(channel.id, args.timestamp);
    if (existing) slackError("already_pinned", 400);
    domain.db
      .prepare(`INSERT INTO pins (channel_id, message_ts, pinned_by, pinned_at) VALUES (?, ?, ?, ?)`)
      .run(channel.id, args.timestamp, acting.id, nowIso());
    const after = domain.db
      .prepare(`SELECT * FROM pins WHERE channel_id = ? AND message_ts = ?`)
      .get(channel.id, args.timestamp) as PinRow;
    onDelta({ before: null, after });
    return {};
  })();
  return out;
}


export function pinsRemove(domain: SlackDomain, args: { channel: string; timestamp: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  void actor;
  const channel = domain.requireChannel(args.channel);
  const before = domain.db
    .prepare(`SELECT * FROM pins WHERE channel_id = ? AND message_ts = ?`)
    .get(channel.id, args.timestamp) as PinRow | undefined;
  if (!before) slackError("no_pin", 404);
  const out = domain.db.transaction(() => {
    domain.db.prepare(`DELETE FROM pins WHERE channel_id = ? AND message_ts = ?`).run(channel.id, args.timestamp);
    onDelta({ before, after: null });
    return {};
  })();
  return out;
}


export function pinsList(domain: SlackDomain, args: { channel: string }, actor: Actor = {}): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  domain.assertChannelMemberForActor(channel, actor);
  const pins = domain.db
    .prepare(`SELECT * FROM pins WHERE channel_id = ? ORDER BY pinned_at`)
    .all(channel.id) as PinRow[];
  const items = pins.map((pin) => {
    const message = domain.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(pin.channel_id, pin.message_ts) as MessageRow | undefined;
    const serializedMessage = message ? serializeMessage(message, { reactions: domain.reactionsFor(pin.channel_id, pin.message_ts) }) : { ts: pin.message_ts };
    return serializePin(pin, serializedMessage);
  });
  return { items };
}

