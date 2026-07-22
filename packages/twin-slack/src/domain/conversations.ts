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
import { clampLimit } from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// Conversations
// ───────────────────────────────────────────────────────────────────────────

export function conversationsList(domain: SlackDomain, args: {
  types?: string;
  exclude_archived?: boolean;
  limit?: number;
  cursor?: string;
  team_id?: string;
}): Record<string, unknown> {
  const requested = (args.types ?? "public_channel")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const typeFilters: string[] = [];
  if (requested.includes("public_channel")) typeFilters.push(`(is_private = 0 AND is_im = 0 AND is_mpim = 0)`);
  if (requested.includes("private_channel")) typeFilters.push(`(is_private = 1 AND is_im = 0 AND is_mpim = 0)`);
  if (requested.includes("mpim")) typeFilters.push(`is_mpim = 1`);
  if (requested.includes("im")) typeFilters.push(`is_im = 1`);
  const where: string[] = [];
  if (typeFilters.length > 0) where.push(`(${typeFilters.join(" OR ")})`);
  if (args.exclude_archived) where.push(`is_archived = 0`);
  const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
  const limit = clampLimit(args.limit, 1000, 100);
  const stmt = `SELECT * FROM channels${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id LIMIT ? OFFSET ?`;
  const rows = domain.db.prepare(stmt).all(limit + 1, offset) as ChannelRow[];
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const channels = slice.map((row) => {
    const numMembers = (
      domain.db.prepare(`SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?`).get(row.id) as { c: number }
    ).c;
    return serializeChannel(row, { num_members: numMembers });
  });
  return {
    channels,
    response_metadata: {
      next_cursor: hasMore ? cursorEncode({ offset: offset + slice.length }) : "",
    },
  };
}


export function conversationsInfo(domain: SlackDomain, args: { channel: string; include_num_members?: boolean }, actor: Actor = {}): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  domain.assertChannelMemberForActor(channel, actor);
  const numMembers = (
    domain.db.prepare(`SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?`).get(channel.id) as { c: number }
  ).c;
  return { channel: serializeChannel(channel, { num_members: numMembers }) };
}


export function conversationsCreate(domain: SlackDomain, args: { name: string; is_private?: boolean; team_id?: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  // Slack distinguishes invalid_name_required (missing), invalid_name_maxlength
  // (>80), invalid_name_specials (any letter outside [a-z0-9_-]), and
  // invalid_name_punctuation (leading/trailing dash, leading underscore,
  // pure digits). Match per https://docs.slack.dev/reference/methods/conversations.create
  if (!args.name) slackError("invalid_name_required", 400);
  if (args.name.length > 80) slackError("invalid_name_maxlength", 400);
  if (/[A-Z]/.test(args.name) || /[^a-z0-9_-]/.test(args.name)) {
    slackError("invalid_name_specials", 400);
  }
  if (/^[-_]/.test(args.name) || /^\d+$/.test(args.name)) {
    slackError("invalid_name_punctuation", 400);
  }
  const workspace = domain.requireWorkspace();
  const creator = domain.resolveActorUser(actor).id;
  const channelId = domain.allocId(workspace.id, args.is_private ? "G" : "C");
  const now = nowIso();
  const out = domain.db.transaction(() => {
    const existing = domain.db
      .prepare(`SELECT id FROM channels WHERE team_id = ? AND name = ?`)
      .get(workspace.id, args.name);
    if (existing) slackError("name_taken", 409);
    domain.db
      .prepare(
        `INSERT INTO channels (id, team_id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived, topic, purpose, creator, created_at, ts_counter)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, '', '', ?, ?, 0)`
      )
      .run(channelId, workspace.id, args.name, args.is_private ? 0 : 1, args.is_private ? 1 : 0, args.is_private ? 1 : 0, creator, now);
    domain.db
      .prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
      .run(channelId, creator, now);
    const row = domain.requireChannelRow(channelId);
    onDelta({ before: null, after: row });
    return serializeChannel(row, { num_members: 1, is_member: true });
  })();
  return { channel: out };
}


export function conversationsArchive(domain: SlackDomain, args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.is_archived) slackError("already_archived", 400);
  if (channel.name === "general") slackError("cant_archive_general", 400);
  const acting = domain.resolveActorUser(actor);
  if (!acting.is_admin) domain.assertChannelMember(channel, acting.id);
  const out = domain.db.transaction(() => {
    const before = domain.requireChannelRow(channel.id);
    domain.db.prepare(`UPDATE channels SET is_archived = 1 WHERE id = ?`).run(channel.id);
    const after = domain.requireChannelRow(channel.id);
    onDelta({ before, after });
    return { ok: true };
  })();
  return out;
}


export function conversationsInvite(domain: SlackDomain, args: { channel: string; users: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.is_archived) slackError("is_archived", 400);
  const acting = domain.resolveActorUser(actor);
  if (!acting.is_admin) domain.assertChannelMember(channel, acting.id);
  const userIds = (args.users ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (userIds.length === 0) slackError("no_user", 400);
  const now = nowIso();
  const out = domain.db.transaction(() => {
    const beforeMembers = domain.channelMemberIds(channel.id);
    for (const userRef of userIds) {
      const user = domain.resolveUser(userRef);
      if (!user) slackError("user_not_found", 404);
      const exists = domain.db
        .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
        .get(channel.id, user.id);
      if (exists) slackError("already_in_channel", 400);
      domain.db
        .prepare(`INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
        .run(channel.id, user.id, now);
    }
    const afterMembers = domain.channelMemberIds(channel.id);
    onDelta({
      before: { channel_id: channel.id, members: beforeMembers },
      after: { channel_id: channel.id, members: afterMembers },
    });
    return { channel: serializeChannel(channel, { num_members: afterMembers.length }) };
  })();
  return out;
}


export function conversationsJoin(domain: SlackDomain, args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.is_archived) slackError("is_archived", 400);
  if (channel.is_private) slackError("channel_not_found", 404);
  const userId = domain.resolveActorUser(actor).id;
  const now = nowIso();
  const out = domain.db.transaction(() => {
    const existing = domain.db
      .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, userId) as ChannelMemberRow | undefined;
    if (existing) {
      return { channel: serializeChannel(channel, { is_member: true }), already_in_channel: true, warning: "already_in_channel" };
    }
    domain.db
      .prepare(`INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
      .run(channel.id, userId, now);
    const after = domain.db
      .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, userId) as ChannelMemberRow;
    onDelta({ before: null, after });
    return { channel: serializeChannel(channel, { is_member: true }) };
  })();
  return out;
}


export function conversationsLeave(domain: SlackDomain, args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.name === "general") slackError("cant_leave_general", 400);
  const userId = domain.resolveActorUser(actor).id;
  const out = domain.db.transaction(() => {
    const existing = domain.db
      .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, userId) as ChannelMemberRow | undefined;
    if (!existing) slackError("not_in_channel", 400);
    domain.db.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?`).run(channel.id, userId);
    onDelta({ before: existing, after: null });
    return { not_in_channel: false };
  })();
  return out;
}


export function conversationsKick(domain: SlackDomain, args: { channel: string; user: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  if (channel.name === "general") slackError("cant_kick_from_general", 400);
  const acting = domain.resolveActorUser(actor);
  const target = domain.resolveUser(args.user);
  if (!target) slackError("user_not_found", 404);
  if (target!.id === acting.id) slackError("cant_kick_self", 400);
  const out = domain.db.transaction(() => {
    const existing = domain.db
      .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, target!.id) as ChannelMemberRow | undefined;
    if (!existing) slackError("not_in_channel", 400);
    domain.db.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?`).run(channel.id, target!.id);
    onDelta({ before: existing, after: null });
    return {};
  })();
  return out;
}


export function conversationsMembers(domain: SlackDomain, args: { channel: string; limit?: number; cursor?: string }, actor: Actor = {}): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  domain.assertChannelMemberForActor(channel, actor);
  const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
  const limit = clampLimit(args.limit, 1000, 100);
  const rows = domain.db
    .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at, user_id LIMIT ? OFFSET ?`)
    .all(channel.id, limit + 1, offset) as Array<{ user_id: string }>;
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  return {
    members: slice.map((row) => row.user_id),
    response_metadata: {
      next_cursor: hasMore ? cursorEncode({ offset: offset + slice.length }) : "",
    },
  };
}


export function conversationsHistory(domain: SlackDomain, args: {
  channel: string;
  cursor?: string;
  inclusive?: boolean;
  latest?: string;
  limit?: number;
  oldest?: string;
}, actor: Actor = {}): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel);
  domain.assertChannelMemberForActor(channel, actor);
  const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
  const limit = clampLimit(args.limit, 1000, 100);
  const params: unknown[] = [channel.id];
  const where: string[] = [`channel_id = ?`, `(thread_ts IS NULL OR ts = thread_ts)`];
  if (args.oldest) {
    where.push(args.inclusive ? `ts >= ?` : `ts > ?`);
    params.push(args.oldest);
  }
  if (args.latest) {
    where.push(args.inclusive ? `ts <= ?` : `ts < ?`);
    params.push(args.latest);
  }
  const sql = `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ? OFFSET ?`;
  params.push(limit + 1, offset);
  const rows = domain.db.prepare(sql).all(...params) as MessageRow[];
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const workspaceId = domain.requireWorkspace().id;
  return {
    messages: slice.map((row) => serializeMessage(row, { reactions: domain.reactionsFor(row.channel_id, row.ts), include_team: workspaceId })),
    has_more: hasMore,
    pin_count: (
      domain.db.prepare(`SELECT COUNT(*) AS c FROM pins WHERE channel_id = ?`).get(channel.id) as { c: number }
    ).c,
    channel_actions_ts: null,
    channel_actions_count: 0,
    // Real Slack OMITS `response_metadata` on conversations.history when there is
    // no next page (it only carries the pagination cursor when hasMore); it does
    // NOT return an empty-cursor envelope here the way conversations.list does
    // (FDRS-473 Kind B — conditional pagination matched per endpoint).
    ...(hasMore
      ? { response_metadata: { next_cursor: cursorEncode({ offset: offset + slice.length }) } }
      : {}),
  };
}


export function conversationsReplies(domain: SlackDomain, args: {
  channel: string;
  ts: string;
  cursor?: string;
  inclusive?: boolean;
  latest?: string;
  limit?: number;
  oldest?: string;
}, actor: Actor = {}): Record<string, unknown> {
  if (!args.ts) slackError("invalid_arguments", 400);
  const channel = domain.requireChannel(args.channel);
  domain.assertChannelMemberForActor(channel, actor);
  const parent = domain.db
    .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
    .get(channel.id, args.ts) as MessageRow | undefined;
  if (!parent) slackError("thread_not_found", 404);
  const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
  const limit = clampLimit(args.limit, 1000, 100);
  const rows = domain.db
    .prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND (ts = ? OR thread_ts = ?)
       ORDER BY ts ASC LIMIT ? OFFSET ?`
    )
    .all(channel.id, args.ts, args.ts, limit + 1, offset) as MessageRow[];
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const workspaceId = domain.requireWorkspace().id;
  const parentAuthor = parent!.user_id;
  const parentTs = parent!.ts;
  return {
    messages: slice.map((row) => {
      const isParent = row.ts === parentTs && !row.thread_ts;
      const serialized = serializeMessage(row, {
        reactions: domain.reactionsFor(row.channel_id, row.ts),
        include_team: workspaceId,
        parent_user_id: row.thread_ts ? parentAuthor : undefined,
      });
      if (isParent) {
        // Real Slack conversations.replies decorates the thread parent
        // with thread_ts === ts (even though the stored row has no
        // thread_ts), plus subscribed/is_locked. Every thread-walking
        // SDK consumer relies on this invariant.
        (serialized as Record<string, unknown>).thread_ts = parentTs;
        (serialized as Record<string, unknown>).subscribed = false;
        (serialized as Record<string, unknown>).is_locked = false;
      }
      return serialized;
    }),
    has_more: hasMore,
    // Real Slack OMITS `response_metadata` on conversations.replies when there is
    // no next page (cursor present only when hasMore) — FDRS-473 Kind B.
    ...(hasMore
      ? { response_metadata: { next_cursor: cursorEncode({ offset: offset + slice.length }) } }
      : {}),
  };
}


export function conversationsOpen(domain: SlackDomain, args: { users?: string; channel?: string; return_im?: boolean }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const workspace = domain.requireWorkspace();
  const acting = domain.resolveActorUser(actor);
  if (args.channel) {
    // Re-open existing DM/MPIM.
    const existing = domain.requireChannel(args.channel);
    onDelta({ before: existing, after: existing });
    return { no_op: true, already_open: true, channel: serializeChannel(existing, { is_member: true }) };
  }
  if (!args.users) slackError("users_list_not_supplied", 400);
  const targetIds = args.users
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => {
      const found = domain.resolveUser(u);
      if (!found) slackError("user_not_found", 404);
      return found!.id;
    });
  const allIds = [...new Set([acting.id, ...targetIds])].sort();
  const isMpim = allIds.length > 2;
  const lookupName = isMpim ? `mpdm-${allIds.join("--")}` : "";
  const dmSignature = allIds.join("|");
  const out = domain.db.transaction(() => {
    const existingChannel = domain.findDirectChannelBySignature(workspace.id, dmSignature);
    if (existingChannel) {
      onDelta({ before: existingChannel, after: existingChannel });
      return { no_op: true, already_open: true, channel: serializeChannel(existingChannel, { is_member: true }) };
    }
    const channelId = domain.allocId(workspace.id, isMpim ? "M" : "D");
    const now = nowIso();
    domain.db
      .prepare(
        `INSERT INTO channels (id, team_id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived, topic, purpose, creator, created_at, ts_counter, dm_signature)
         VALUES (?, ?, ?, 0, 0, ?, ?, 1, 0, '', '', ?, ?, 0, ?)`
      )
      .run(channelId, workspace.id, lookupName, isMpim ? 0 : 1, isMpim ? 1 : 0, acting.id, now, dmSignature);
    for (const id of allIds) {
      domain.db
        .prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
        .run(channelId, id, now);
    }
    const created = domain.requireChannelRow(channelId);
    onDelta({ before: null, after: created });
    return { channel: serializeChannel(created, { is_member: true, num_members: allIds.length }) };
  })();
  return out;
}

