// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";
import { resetDatabase } from "./db.js";
import { slackError, notFound, TwinError } from "./errors.js";
import { parseSeed } from "./seed.js";
import {
  SLACK_TWIN_HOST,
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
} from "./serializers.js";
import type {
  BookmarkRow,
  ChannelMemberRow,
  ChannelRow,
  FileRow,
  MessageRow,
  PinRow,
  ReactionRow,
  ScheduledMessageRow,
  SlackStateSeed,
  SlackTwinDatabase,
  UserRow,
  WorkspaceRow,
} from "./types.js";
import { cursorDecode, cursorEncode, nowIso, nowUnix, padTsCounter, tsBaseSeconds } from "./util.js";

export type DeltaHook = (delta: StateDelta) => void;

const NOOP: DeltaHook = () => {};

export type Actor = {
  login?: string;
};

const DEFAULT_BOT_USER = "U_PRIMARY";
const DEFAULT_TEAM_ID = "T_POME";

export class SlackDomain {
  constructor(private readonly db: SlackTwinDatabase) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  seed(state: SlackStateSeed): void {
    resetDatabase(this.db);
    const team = state.team ?? {};
    const teamId = team.id ?? DEFAULT_TEAM_ID;
    const teamName = team.name ?? "Pome Twin Workspace";
    const teamDomain = team.domain ?? "pome-twin";
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, name, domain, url, enterprise_id, created_at, entity_counter)
           VALUES (?, ?, ?, ?, NULL, ?, 0)`
        )
        .run(teamId, teamName, teamDomain, `${SLACK_TWIN_HOST}/`, now);

      // Pre-create users from seed.
      const userIdByHandle = new Map<string, string>();
      const seedUsers = state.users ?? [];
      for (const u of seedUsers) {
        const id = u.id ?? this.allocId(teamId, u.is_bot ? "B" : "U");
        const handle = u.name;
        userIdByHandle.set(handle, id);
        userIdByHandle.set(id, id);
        this.db
          .prepare(
            `INSERT INTO users (id, team_id, name, real_name, display_name, email, is_bot, is_admin, deleted, tz, profile_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
          )
          .run(
            id,
            teamId,
            handle,
            u.real_name ?? "",
            "",
            u.email ?? null,
            u.is_bot ? 1 : 0,
            u.is_admin ? 1 : 0,
            u.tz ?? "America/Los_Angeles",
            JSON.stringify(u.profile ?? {}),
            now,
            now
          );
      }

      // Ensure the pome-agent user always exists.
      if (!userIdByHandle.has("pome-agent") && !userIdByHandle.has(DEFAULT_BOT_USER)) {
        const id = DEFAULT_BOT_USER;
        userIdByHandle.set("pome-agent", id);
        userIdByHandle.set(id, id);
        this.db
          .prepare(
            `INSERT INTO users (id, team_id, name, real_name, display_name, email, is_bot, is_admin, deleted, tz, profile_json, created_at, updated_at)
             VALUES (?, ?, 'pome-agent', 'Pome Agent', '', 'pome-agent@pome-twin.slack.com', 0, 1, 0, 'America/Los_Angeles', '{}', ?, ?)`
          )
          .run(id, teamId, now, now);
      }

      // Channels + members + messages.
      const seedChannels = state.channels ?? [];
      for (const ch of seedChannels) {
        const channelId = ch.id ?? this.allocId(teamId, ch.is_private ? "G" : "C");
        const creator = this.resolveSeedUserId(ch.creator, userIdByHandle) ?? DEFAULT_BOT_USER;
        this.db
          .prepare(
            `INSERT INTO channels (id, team_id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived, topic, purpose, creator, created_at, ts_counter)
             VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, 0)`
          )
          .run(
            channelId,
            teamId,
            ch.name,
            ch.is_private ? 0 : 1,
            ch.is_private ? 1 : 0,
            ch.is_private ? 1 : 0,
            ch.topic ?? "",
            ch.purpose ?? "",
            creator,
            now
          );

        for (const member of ch.members ?? []) {
          const memberId = this.resolveSeedUserId(member, userIdByHandle);
          if (!memberId) continue;
          this.db
            .prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
            .run(channelId, memberId, now);
        }

        // Seeded messages preserve thread relationships.
        const seededTsByOriginalTs = new Map<string, string>();
        for (const m of ch.messages ?? []) {
          const ts = m.ts ?? this.allocMessageTs(channelId);
          if (m.ts) seededTsByOriginalTs.set(m.ts, ts);
          const userId = this.resolveSeedUserId(m.user, userIdByHandle) ?? DEFAULT_BOT_USER;
          const threadTs = m.thread_ts ? seededTsByOriginalTs.get(m.thread_ts) ?? m.thread_ts : null;
          this.db
            .prepare(
              `INSERT INTO messages (channel_id, ts, user_id, text, subtype, thread_ts, reply_count, reply_users_count, latest_reply, edited_user_id, edited_ts, blocks_json, attachments_json)
               VALUES (?, ?, ?, ?, NULL, ?, 0, 0, NULL, NULL, NULL, '[]', '[]')`
            )
            .run(channelId, ts, userId, m.text, threadTs);
          if (threadTs) {
            this.db
              .prepare(
                `UPDATE messages SET reply_count = reply_count + 1, latest_reply = ?,
                  reply_users_count = (
                    SELECT COUNT(DISTINCT user_id) FROM messages WHERE channel_id = ? AND thread_ts = ?
                  )
                 WHERE channel_id = ? AND ts = ?`
              )
              .run(ts, channelId, threadTs, channelId, threadTs);
          }
          for (const r of m.reactions ?? []) {
            const reactorId = this.resolveSeedUserId(r.user, userIdByHandle);
            if (!reactorId) continue;
            this.db
              .prepare(
                `INSERT OR IGNORE INTO reactions (channel_id, message_ts, name, user_id, added_at) VALUES (?, ?, ?, ?, ?)`
              )
              .run(channelId, ts, r.name, reactorId, now);
          }
        }
      }
    })();
  }

  resetToDefault(seedFn: () => SlackStateSeed, onDelta: DeltaHook = NOOP): { ok: true } {
    const beforeSummary = this.summarizeState();
    this.seed(seedFn());
    const afterSummary = this.summarizeState();
    onDelta({ before: beforeSummary, after: afterSummary });
    return { ok: true };
  }

  applySeed(input: unknown, onDelta: DeltaHook = NOOP): { ok: true } {
    const beforeSummary = this.summarizeState();
    const next = parseSeed(input);
    this.seed(next);
    const afterSummary = this.summarizeState();
    onDelta({ before: beforeSummary, after: afterSummary });
    return { ok: true };
  }

  exportState(): Record<string, unknown> {
    const workspace = this.firstWorkspace();
    if (!workspace) return { workspace: null };
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        domain: workspace.domain,
      },
      users: this.db.prepare(`SELECT * FROM users WHERE team_id = ? ORDER BY id`).all(workspace.id),
      channels: this.allChannels().map((channel) => ({
        ...channel,
        members: this.db
          .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id`)
          .all(channel.id)
          .map((row) => (row as { user_id: string }).user_id),
        messages: this.db
          .prepare(`SELECT * FROM messages WHERE channel_id = ? ORDER BY ts`)
          .all(channel.id),
      })),
      reactions: this.db.prepare(`SELECT * FROM reactions ORDER BY channel_id, message_ts, name, user_id`).all(),
      pins: this.db.prepare(`SELECT * FROM pins ORDER BY channel_id, message_ts`).all(),
      files: this.db.prepare(`SELECT * FROM files ORDER BY id`).all(),
      bookmarks: this.db.prepare(`SELECT * FROM bookmarks ORDER BY id`).all(),
      scheduled_messages: this.db.prepare(`SELECT * FROM scheduled_messages ORDER BY id`).all(),
    };
  }

  private summarizeState(): Record<string, number> {
    const get = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      users: get(`SELECT COUNT(*) AS c FROM users`),
      channels: get(`SELECT COUNT(*) AS c FROM channels`),
      messages: get(`SELECT COUNT(*) AS c FROM messages`),
      reactions: get(`SELECT COUNT(*) AS c FROM reactions`),
      pins: get(`SELECT COUNT(*) AS c FROM pins`),
      files: get(`SELECT COUNT(*) AS c FROM files`),
      bookmarks: get(`SELECT COUNT(*) AS c FROM bookmarks`),
      scheduled_messages: get(`SELECT COUNT(*) AS c FROM scheduled_messages`),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Auth
  // ───────────────────────────────────────────────────────────────────────────

  authTest(actor: Actor): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    const userRow = this.resolveActorUser(actor);
    return {
      url: `${SLACK_TWIN_HOST}/`,
      team: workspace.name,
      user: userRow.name,
      team_id: workspace.id,
      user_id: userRow.id,
      bot_id: userRow.is_bot ? userRow.id : null,
      is_enterprise_install: false,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Conversations
  // ───────────────────────────────────────────────────────────────────────────

  conversationsList(args: {
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
    const rows = this.db.prepare(stmt).all(limit + 1, offset) as ChannelRow[];
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const channels = slice.map((row) => {
      const numMembers = (
        this.db.prepare(`SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?`).get(row.id) as { c: number }
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

  conversationsInfo(args: { channel: string; include_num_members?: boolean }, actor: Actor = {}): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    this.assertChannelMemberForActor(channel, actor);
    const numMembers = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?`).get(channel.id) as { c: number }
    ).c;
    return { channel: serializeChannel(channel, { num_members: numMembers }) };
  }

  conversationsCreate(args: { name: string; is_private?: boolean; team_id?: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
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
    const workspace = this.requireWorkspace();
    const creator = this.resolveActorUser(actor).id;
    const channelId = this.allocId(workspace.id, args.is_private ? "G" : "C");
    const now = nowIso();
    const out = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT id FROM channels WHERE team_id = ? AND name = ?`)
        .get(workspace.id, args.name);
      if (existing) slackError("name_taken", 409);
      this.db
        .prepare(
          `INSERT INTO channels (id, team_id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived, topic, purpose, creator, created_at, ts_counter)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, '', '', ?, ?, 0)`
        )
        .run(channelId, workspace.id, args.name, args.is_private ? 0 : 1, args.is_private ? 1 : 0, args.is_private ? 1 : 0, creator, now);
      this.db
        .prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
        .run(channelId, creator, now);
      const row = this.requireChannelRow(channelId);
      onDelta({ before: null, after: row });
      return serializeChannel(row, { num_members: 1, is_member: true });
    })();
    return { channel: out };
  }

  conversationsArchive(args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.is_archived) slackError("already_archived", 400);
    if (channel.name === "general") slackError("cant_archive_general", 400);
    const acting = this.resolveActorUser(actor);
    if (!acting.is_admin) this.assertChannelMember(channel, acting.id);
    const out = this.db.transaction(() => {
      const before = this.requireChannelRow(channel.id);
      this.db.prepare(`UPDATE channels SET is_archived = 1 WHERE id = ?`).run(channel.id);
      const after = this.requireChannelRow(channel.id);
      onDelta({ before, after });
      return { ok: true };
    })();
    return out;
  }

  conversationsInvite(args: { channel: string; users: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.is_archived) slackError("is_archived", 400);
    const acting = this.resolveActorUser(actor);
    if (!acting.is_admin) this.assertChannelMember(channel, acting.id);
    const userIds = (args.users ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (userIds.length === 0) slackError("no_user", 400);
    const now = nowIso();
    const out = this.db.transaction(() => {
      const beforeMembers = this.channelMemberIds(channel.id);
      for (const userRef of userIds) {
        const user = this.resolveUser(userRef);
        if (!user) slackError("user_not_found", 404);
        const exists = this.db
          .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
          .get(channel.id, user.id);
        if (exists) slackError("already_in_channel", 400);
        this.db
          .prepare(`INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
          .run(channel.id, user.id, now);
      }
      const afterMembers = this.channelMemberIds(channel.id);
      onDelta({
        before: { channel_id: channel.id, members: beforeMembers },
        after: { channel_id: channel.id, members: afterMembers },
      });
      return { channel: serializeChannel(channel, { num_members: afterMembers.length }) };
    })();
    return out;
  }

  conversationsJoin(args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.is_archived) slackError("is_archived", 400);
    if (channel.is_private) slackError("channel_not_found", 404);
    const userId = this.resolveActorUser(actor).id;
    const now = nowIso();
    const out = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
        .get(channel.id, userId) as ChannelMemberRow | undefined;
      if (existing) {
        return { channel: serializeChannel(channel, { is_member: true }), already_in_channel: true, warning: "already_in_channel" };
      }
      this.db
        .prepare(`INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
        .run(channel.id, userId, now);
      const after = this.db
        .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
        .get(channel.id, userId) as ChannelMemberRow;
      onDelta({ before: null, after });
      return { channel: serializeChannel(channel, { is_member: true }) };
    })();
    return out;
  }

  conversationsLeave(args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.name === "general") slackError("cant_leave_general", 400);
    const userId = this.resolveActorUser(actor).id;
    const out = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
        .get(channel.id, userId) as ChannelMemberRow | undefined;
      if (!existing) slackError("not_in_channel", 400);
      this.db.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?`).run(channel.id, userId);
      onDelta({ before: existing, after: null });
      return { not_in_channel: false };
    })();
    return out;
  }

  conversationsKick(args: { channel: string; user: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.name === "general") slackError("cant_kick_from_general", 400);
    const acting = this.resolveActorUser(actor);
    const target = this.resolveUser(args.user);
    if (!target) slackError("user_not_found", 404);
    if (target!.id === acting.id) slackError("cant_kick_self", 400);
    const out = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?`)
        .get(channel.id, target!.id) as ChannelMemberRow | undefined;
      if (!existing) slackError("not_in_channel", 400);
      this.db.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?`).run(channel.id, target!.id);
      onDelta({ before: existing, after: null });
      return {};
    })();
    return out;
  }

  conversationsMembers(args: { channel: string; limit?: number; cursor?: string }, actor: Actor = {}): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    this.assertChannelMemberForActor(channel, actor);
    const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
    const limit = clampLimit(args.limit, 1000, 100);
    const rows = this.db
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

  conversationsHistory(args: {
    channel: string;
    cursor?: string;
    inclusive?: boolean;
    latest?: string;
    limit?: number;
    oldest?: string;
  }, actor: Actor = {}): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    this.assertChannelMemberForActor(channel, actor);
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
    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const workspaceId = this.requireWorkspace().id;
    return {
      messages: slice.map((row) => serializeMessage(row, { reactions: this.reactionsFor(row.channel_id, row.ts), include_team: workspaceId })),
      has_more: hasMore,
      pin_count: (
        this.db.prepare(`SELECT COUNT(*) AS c FROM pins WHERE channel_id = ?`).get(channel.id) as { c: number }
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

  conversationsReplies(args: {
    channel: string;
    ts: string;
    cursor?: string;
    inclusive?: boolean;
    latest?: string;
    limit?: number;
    oldest?: string;
  }, actor: Actor = {}): Record<string, unknown> {
    if (!args.ts) slackError("invalid_arguments", 400);
    const channel = this.requireChannel(args.channel);
    this.assertChannelMemberForActor(channel, actor);
    const parent = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.ts) as MessageRow | undefined;
    if (!parent) slackError("thread_not_found", 404);
    const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
    const limit = clampLimit(args.limit, 1000, 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND (ts = ? OR thread_ts = ?)
         ORDER BY ts ASC LIMIT ? OFFSET ?`
      )
      .all(channel.id, args.ts, args.ts, limit + 1, offset) as MessageRow[];
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const workspaceId = this.requireWorkspace().id;
    const parentAuthor = parent!.user_id;
    const parentTs = parent!.ts;
    return {
      messages: slice.map((row) => {
        const isParent = row.ts === parentTs && !row.thread_ts;
        const serialized = serializeMessage(row, {
          reactions: this.reactionsFor(row.channel_id, row.ts),
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

  conversationsOpen(args: { users?: string; channel?: string; return_im?: boolean }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    const acting = this.resolveActorUser(actor);
    if (args.channel) {
      // Re-open existing DM/MPIM.
      const existing = this.requireChannel(args.channel);
      onDelta({ before: existing, after: existing });
      return { no_op: true, already_open: true, channel: serializeChannel(existing, { is_member: true }) };
    }
    if (!args.users) slackError("users_list_not_supplied", 400);
    const targetIds = args.users
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((u) => {
        const found = this.resolveUser(u);
        if (!found) slackError("user_not_found", 404);
        return found!.id;
      });
    const allIds = [...new Set([acting.id, ...targetIds])].sort();
    const isMpim = allIds.length > 2;
    const lookupName = isMpim ? `mpdm-${allIds.join("--")}` : "";
    const dmSignature = allIds.join("|");
    const out = this.db.transaction(() => {
      const existingChannel = this.findDirectChannelBySignature(workspace.id, dmSignature);
      if (existingChannel) {
        onDelta({ before: existingChannel, after: existingChannel });
        return { no_op: true, already_open: true, channel: serializeChannel(existingChannel, { is_member: true }) };
      }
      const channelId = this.allocId(workspace.id, isMpim ? "M" : "D");
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO channels (id, team_id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived, topic, purpose, creator, created_at, ts_counter, dm_signature)
           VALUES (?, ?, ?, 0, 0, ?, ?, 1, 0, '', '', ?, ?, 0, ?)`
        )
        .run(channelId, workspace.id, lookupName, isMpim ? 0 : 1, isMpim ? 1 : 0, acting.id, now, dmSignature);
      for (const id of allIds) {
        this.db
          .prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)`)
          .run(channelId, id, now);
      }
      const created = this.requireChannelRow(channelId);
      onDelta({ before: null, after: created });
      return { channel: serializeChannel(created, { is_member: true, num_members: allIds.length }) };
    })();
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Chat
  // ───────────────────────────────────────────────────────────────────────────

  chatPostMessage(
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
    const channel = this.requireChannel(args.channel);
    if (channel.is_archived) slackError("is_archived", 400);
    if (!args.text && !args.blocks && !args.attachments) slackError("no_text", 400);
    if (args.thread_ts) {
      const parent = this.db
        .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
        .get(channel.id, args.thread_ts) as MessageRow | undefined;
      if (!parent) slackError("thread_not_found", 404);
    }
    const author = this.resolveActorUser(actor);
    if (channel.is_private || channel.is_im || channel.is_mpim) {
      const member = this.db
        .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
        .get(channel.id, author.id);
      if (!member) slackError("not_in_channel", 400);
    }
    const ts = this.allocMessageTs(channel.id);
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
    const out = this.db.transaction(() => {
      this.db
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
        this.db
          .prepare(
            `UPDATE messages SET reply_count = reply_count + 1, latest_reply = ?,
              reply_users_count = (
                SELECT COUNT(DISTINCT user_id) FROM messages WHERE channel_id = ? AND thread_ts = ?
              )
             WHERE channel_id = ? AND ts = ?`
          )
          .run(ts, channel.id, args.thread_ts, channel.id, args.thread_ts);
      }
      const row = this.requireMessageRow(channel.id, ts);
      onDelta({ before: null, after: row });
      const workspaceId = this.requireWorkspace().id;
      return { channel: channel.id, ts, message: serializeMessage(row, { include_team: workspaceId }) };
    })();
    return out;
  }

  chatUpdate(
    args: { channel: string; ts: string; text?: string; blocks?: string; attachments?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.is_archived) slackError("is_archived", 400);
    const acting = this.resolveActorUser(actor);
    const before = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.ts) as MessageRow | undefined;
    if (!before) slackError("message_not_found", 404);
    // Real Slack has no admin override at the API layer — only the message's
    // author may update their own message. Single-tenant sandbox semantics:
    // the JWT's `login` claim identifies the acting user.
    if (before!.user_id !== acting.id) slackError("cant_update_message", 403);
    const out = this.db.transaction(() => {
      const updatedTs = this.allocMessageTs(channel.id);
      const newText = args.text ?? before!.text;
      const newBlocks = args.blocks ? sanitizeJsonString(args.blocks, before!.blocks_json) : before!.blocks_json;
      const newAttachments = args.attachments
        ? sanitizeJsonString(args.attachments, before!.attachments_json)
        : before!.attachments_json;
      this.db
        .prepare(
          `UPDATE messages SET text = ?, blocks_json = ?, attachments_json = ?, edited_user_id = ?, edited_ts = ? WHERE channel_id = ? AND ts = ?`
        )
        .run(newText, newBlocks, newAttachments, acting.id, updatedTs, channel.id, args.ts);
      const after = this.requireMessageRow(channel.id, args.ts);
      onDelta({ before, after });
      return { channel: channel.id, ts: args.ts, text: after.text, message: serializeMessage(after) };
    })();
    return out;
  }

  chatDelete(args: { channel: string; ts: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    const acting = this.resolveActorUser(actor);
    const before = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.ts) as MessageRow | undefined;
    if (!before) slackError("message_not_found", 404);
    // Real Slack has no admin override on chat.delete — only the author may delete.
    if (before!.user_id !== acting.id) slackError("cant_delete_message", 403);
    const out = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE channel_id = ? AND ts = ?`).run(channel.id, args.ts);
      // Decrement thread parent if this was a reply.
      if (before!.thread_ts) {
        this.db
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

  chatScheduleMessage(
    args: { channel: string; text: string; post_at: number; thread_ts?: string; blocks?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    if (channel.is_archived) slackError("is_archived", 400);
    if (!args.text) slackError("no_text", 400);
    if (!args.post_at || args.post_at <= nowUnix()) slackError("time_in_past", 400);
    const acting = this.resolveActorUser(actor);
    const id = this.allocId(this.requireWorkspace().id, "Q");
    const now = nowUnix();
    const out = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scheduled_messages (id, channel_id, user_id, text, thread_ts, post_at, date_created, blocks_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, channel.id, acting.id, args.text, args.thread_ts ?? null, args.post_at, now, args.blocks ? sanitizeJsonString(args.blocks, "[]") : "[]");
      const row = this.requireScheduledMessage(id);
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

  chatDeleteScheduledMessage(args: { channel: string; scheduled_message_id: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    void actor;
    const channel = this.requireChannel(args.channel);
    const row = this.db
      .prepare(`SELECT * FROM scheduled_messages WHERE id = ? AND channel_id = ?`)
      .get(args.scheduled_message_id, channel.id) as ScheduledMessageRow | undefined;
    if (!row) slackError("scheduled_message_not_found", 404);
    const out = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`).run(row!.id);
      onDelta({ before: row, after: null });
      return {};
    })();
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reactions
  // ───────────────────────────────────────────────────────────────────────────

  reactionsAdd(args: { channel: string; timestamp: string; name: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    if (!args.name) slackError("no_reaction", 400);
    const channel = this.requireChannel(args.channel);
    const message = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.timestamp) as MessageRow | undefined;
    if (!message) slackError("message_not_found", 404);
    const acting = this.resolveActorUser(actor);
    const reaction = normalizeReactionName(args.name);
    const out = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
        .get(channel.id, args.timestamp, reaction, acting.id);
      if (existing) slackError("already_reacted", 400);
      const now = nowIso();
      this.db
        .prepare(`INSERT INTO reactions (channel_id, message_ts, name, user_id, added_at) VALUES (?, ?, ?, ?, ?)`)
        .run(channel.id, args.timestamp, reaction, acting.id, now);
      const after = this.db
        .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
        .get(channel.id, args.timestamp, reaction, acting.id) as ReactionRow;
      onDelta({ before: null, after });
      return {};
    })();
    return out;
  }

  reactionsRemove(args: { channel: string; timestamp: string; name: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    if (!args.name) slackError("no_reaction", 400);
    const channel = this.requireChannel(args.channel);
    const acting = this.resolveActorUser(actor);
    const reaction = normalizeReactionName(args.name);
    const before = this.db
      .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
      .get(channel.id, args.timestamp, reaction, acting.id) as ReactionRow | undefined;
    if (!before) slackError("no_reaction", 404);
    const out = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?`)
        .run(channel.id, args.timestamp, reaction, acting.id);
      onDelta({ before, after: null });
      return {};
    })();
    return out;
  }

  reactionsGet(args: { channel: string; timestamp: string; full?: boolean }, actor: Actor = {}): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    this.assertChannelMemberForActor(channel, actor);
    const message = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.timestamp) as MessageRow | undefined;
    if (!message) slackError("message_not_found", 404);
    const reactions = this.reactionsFor(channel.id, args.timestamp);
    return {
      type: "message",
      channel: channel.id,
      message: { ...serializeMessage(message!, { reactions }) },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Users
  // ───────────────────────────────────────────────────────────────────────────

  usersList(args: { cursor?: string; limit?: number; include_locale?: boolean; team_id?: string }): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
    const limit = clampLimit(args.limit, 1000, 100);
    const rows = this.db
      .prepare(`SELECT * FROM users WHERE team_id = ? ORDER BY id LIMIT ? OFFSET ?`)
      .all(workspace.id, limit + 1, offset) as UserRow[];
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
      // users.list embeds each user's profile WITHOUT `email` — real Slack only
      // returns the email on the single-user reads (FDRS-473 Kind B).
      members: slice.map((row) => serializeUser(row, { include_locale: args.include_locale, omitProfileEmail: true })),
      cache_ts: nowUnix(),
      response_metadata: {
        next_cursor: hasMore ? cursorEncode({ offset: offset + slice.length }) : "",
      },
    };
  }

  usersInfo(args: { user: string; include_locale?: boolean }): Record<string, unknown> {
    const user = this.resolveUser(args.user);
    if (!user) slackError("user_not_found", 404);
    return { user: serializeUser(user!, { include_locale: args.include_locale }) };
  }

  usersLookupByEmail(args: { email: string }): Record<string, unknown> {
    if (!args.email) slackError("users_not_found", 400);
    const workspace = this.requireWorkspace();
    const user = this.db
      .prepare(`SELECT * FROM users WHERE team_id = ? AND email = ?`)
      .get(workspace.id, args.email) as UserRow | undefined;
    if (!user) slackError("users_not_found", 404);
    return { user: serializeUser(user!) };
  }

  usersProfileGet(args: { user?: string; include_labels?: boolean }, actor: Actor): Record<string, unknown> {
    const target = args.user ? this.resolveUser(args.user) : this.resolveActorUser(actor);
    if (!target) slackError("user_not_found", 404);
    // users.profile.get returns the bare profile WITHOUT `team` — real Slack omits
    // it on this endpoint (it carries it in the embedded user.profile elsewhere)
    // (FDRS-473 Kind B).
    return { profile: serializeUserProfile(target!, { omitTeam: true }) };
  }

  usersProfileSet(args: { user?: string; profile?: string; name?: string; value?: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const target = args.user ? this.resolveUser(args.user) : this.resolveActorUser(actor);
    if (!target) slackError("user_not_found", 404);
    const acting = this.resolveActorUser(actor);
    if (target!.id !== acting.id && !acting.is_admin) slackError("cant_set_profile_for_other_user", 403);
    const out = this.db.transaction(() => {
      const before = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(target!.id) as UserRow;
      let profile = safeParseJson(before.profile_json);
      if (args.profile) {
        const incoming = safeParseJson(args.profile);
        profile = { ...(profile as object), ...(incoming as object) };
      } else if (args.name) {
        profile = { ...(profile as object), [args.name]: args.value ?? "" };
      }
      this.db
        .prepare(`UPDATE users SET profile_json = ?, real_name = COALESCE((SELECT json_extract(?, '$.real_name')), real_name), updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(profile), JSON.stringify(profile), nowIso(), target!.id);
      const after = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(target!.id) as UserRow;
      onDelta({ before, after });
      // users.profile.set echoes the bare profile, same shape as users.profile.get
      // (no `team`) — FDRS-473 Kind B.
      return { profile: serializeUserProfile(after, { omitTeam: true }) };
    })();
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pins
  // ───────────────────────────────────────────────────────────────────────────

  pinsAdd(args: { channel: string; timestamp: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    const message = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channel.id, args.timestamp) as MessageRow | undefined;
    if (!message) slackError("message_not_found", 404);
    const acting = this.resolveActorUser(actor);
    const out = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM pins WHERE channel_id = ? AND message_ts = ?`)
        .get(channel.id, args.timestamp);
      if (existing) slackError("already_pinned", 400);
      this.db
        .prepare(`INSERT INTO pins (channel_id, message_ts, pinned_by, pinned_at) VALUES (?, ?, ?, ?)`)
        .run(channel.id, args.timestamp, acting.id, nowIso());
      const after = this.db
        .prepare(`SELECT * FROM pins WHERE channel_id = ? AND message_ts = ?`)
        .get(channel.id, args.timestamp) as PinRow;
      onDelta({ before: null, after });
      return {};
    })();
    return out;
  }

  pinsRemove(args: { channel: string; timestamp: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    void actor;
    const channel = this.requireChannel(args.channel);
    const before = this.db
      .prepare(`SELECT * FROM pins WHERE channel_id = ? AND message_ts = ?`)
      .get(channel.id, args.timestamp) as PinRow | undefined;
    if (!before) slackError("no_pin", 404);
    const out = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM pins WHERE channel_id = ? AND message_ts = ?`).run(channel.id, args.timestamp);
      onDelta({ before, after: null });
      return {};
    })();
    return out;
  }

  pinsList(args: { channel: string }, actor: Actor = {}): Record<string, unknown> {
    const channel = this.requireChannel(args.channel);
    this.assertChannelMemberForActor(channel, actor);
    const pins = this.db
      .prepare(`SELECT * FROM pins WHERE channel_id = ? ORDER BY pinned_at`)
      .all(channel.id) as PinRow[];
    const items = pins.map((pin) => {
      const message = this.db
        .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
        .get(pin.channel_id, pin.message_ts) as MessageRow | undefined;
      const serializedMessage = message ? serializeMessage(message, { reactions: this.reactionsFor(pin.channel_id, pin.message_ts) }) : { ts: pin.message_ts };
      return serializePin(pin, serializedMessage);
    });
    return { items };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Search
  // ───────────────────────────────────────────────────────────────────────────

  searchMessages(
    args: {
      query: string;
      count?: number;
      page?: number;
      sort?: string;
      sort_dir?: string;
      highlight?: boolean;
    },
    actor: Actor = {}
  ): Record<string, unknown> {
    if (!args.query || args.query.trim() === "") slackError("no_query", 400);
    const acting = this.resolveActorUser(actor);
    const count = clampLimit(args.count, 100, 20);
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const offset = (page - 1) * count;
    const sortDir = (args.sort_dir ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    // Simple LIKE-based search. Slack's actual full-text engine is more
    // sophisticated; for twin scenarios this is enough to match seeded
    // and posted messages on substring.
    const like = `%${args.query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const visibilityClause = `(
      channel_id IN (SELECT id FROM channels WHERE is_private = 0 AND is_im = 0 AND is_mpim = 0)
      OR channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
    )`;
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM messages WHERE text LIKE ? ESCAPE '\\' AND ${visibilityClause}`)
        .get(like, acting.id) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE text LIKE ? ESCAPE '\\' AND ${visibilityClause}
         ORDER BY ts ${sortDir}
         LIMIT ? OFFSET ?`
      )
      .all(like, acting.id, count, offset) as MessageRow[];
    const matches = rows.map((row) => {
      const channel = this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(row.channel_id) as ChannelRow | undefined;
      return {
        iid: `${row.channel_id}-${row.ts}`,
        type: "message",
        user: row.user_id,
        username: this.userNameOf(row.user_id),
        ts: row.ts,
        text: row.text,
        permalink: `${SLACK_TWIN_HOST}/archives/${row.channel_id}/p${row.ts.replace(".", "")}`,
        team: this.requireWorkspace().id,
        channel: channel ? { id: channel.id, name: channel.name, is_private: Boolean(channel.is_private) } : { id: row.channel_id, name: "", is_private: false },
      };
    });
    return {
      query: args.query,
      messages: {
        total,
        pagination: {
          page,
          page_count: total === 0 ? 0 : Math.ceil(total / count),
          per_page: count,
          total_count: total,
          first: offset + 1,
          last: offset + matches.length,
        },
        paging: {
          count,
          total,
          page,
          pages: total === 0 ? 0 : Math.ceil(total / count),
        },
        matches,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Files
  // ───────────────────────────────────────────────────────────────────────────

  filesUpload(
    args: { channels?: string; channel?: string; filename?: string; title?: string; filetype?: string; content?: string; initial_comment?: string; thread_ts?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    const acting = this.resolveActorUser(actor);
    const channelsRaw = args.channels ?? args.channel ?? "";
    const channelIds = channelsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((ref) => this.requireChannel(ref).id);
    const id = this.allocId(workspace.id, "F");
    const name = args.filename ?? `untitled-${id}.txt`;
    const title = args.title ?? name;
    const filetype = args.filetype ?? "text";
    const content = args.content ?? null;
    const size = content ? Buffer.byteLength(content, "utf8") : 0;
    const out = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO files (id, team_id, user_id, name, title, mimetype, filetype, size, url_private, channels_json, deleted, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?)`
        )
        .run(id, workspace.id, acting.id, name, title, filetypeMimetype(filetype), filetype, size, JSON.stringify(channelIds), content, nowIso());
      const after = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow;
      // Optionally post initial_comment as a message in the first channel.
      if (args.initial_comment && channelIds.length > 0) {
        const ts = this.allocMessageTs(channelIds[0]!);
        this.db
          .prepare(
            `INSERT INTO messages (channel_id, ts, user_id, text, subtype, thread_ts, blocks_json, attachments_json)
             VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`
          )
          .run(
            channelIds[0],
            ts,
            acting.id,
            args.initial_comment,
            "file_share",
            args.thread_ts ?? null,
            JSON.stringify([{ id: 1, file_id: id, title }])
          );
      }
      onDelta({ before: null, after });
      return { file: serializeFile(after) };
    })();
    return out;
  }

  filesInfo(args: { file: string }): Record<string, unknown> {
    const file = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(args.file) as FileRow | undefined;
    if (!file) slackError("file_not_found", 404);
    return {
      file: serializeFile(file!),
      comments: [],
      response_metadata: { next_cursor: "" },
    };
  }

  filesList(args: { channel?: string; user?: string; count?: number; page?: number; types?: string }): Record<string, unknown> {
    const count = clampLimit(args.count, 1000, 100);
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const offset = (page - 1) * count;
    const params: unknown[] = [];
    const where: string[] = [`deleted = 0`];
    if (args.user) {
      const user = this.resolveUser(args.user);
      if (!user) slackError("user_not_found", 404);
      where.push(`user_id = ?`);
      params.push(user!.id);
    }
    let sql = `SELECT * FROM files WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(count, offset);
    let rows = this.db.prepare(sql).all(...params) as FileRow[];
    if (args.channel) {
      const channelId = this.requireChannel(args.channel).id;
      rows = rows.filter((row) => (JSON.parse(row.channels_json) as string[]).includes(channelId));
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM files WHERE deleted = 0`).get() as { c: number }).c;
    return {
      files: rows.map((row) => serializeFile(row)),
      paging: {
        count,
        total,
        page,
        pages: total === 0 ? 0 : Math.ceil(total / count),
      },
      // files.list paginates via `paging` (page/pages), not a cursor. Real Slack
      // does NOT return a `response_metadata.next_cursor` envelope on files.list,
      // so the twin omits it rather than emitting an empty-cursor stub that diffs
      // as a twin-only field (FDRS-473 Kind B).
    };
  }

  filesDelete(args: { file: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    void actor;
    const before = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(args.file) as FileRow | undefined;
    if (!before) slackError("file_not_found", 404);
    const out = this.db.transaction(() => {
      this.db.prepare(`UPDATE files SET deleted = 1 WHERE id = ?`).run(args.file);
      const after = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(args.file) as FileRow;
      onDelta({ before, after });
      return {};
    })();
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bookmarks
  // ───────────────────────────────────────────────────────────────────────────

  bookmarksAdd(
    args: { channel_id: string; title: string; type?: string; link?: string; emoji?: string; entity_id?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const channel = this.requireChannel(args.channel_id);
    if (!args.title) slackError("invalid_arguments", 400);
    if (!args.link && (!args.type || args.type === "link")) slackError("invalid_arguments", 400);
    const acting = this.resolveActorUser(actor);
    const id = this.allocId(this.requireWorkspace().id, "Bk");
    const out = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bookmarks (id, channel_id, title, link, emoji, type, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, channel.id, args.title, args.link ?? "", args.emoji ?? null, args.type ?? "link", acting.id, nowIso());
      const after = this.db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id) as BookmarkRow;
      onDelta({ before: null, after });
      return { bookmark: serializeBookmark(after) };
    })();
    return out;
  }

  bookmarksRemove(args: { channel_id: string; bookmark_id: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    void actor;
    const channel = this.requireChannel(args.channel_id);
    const before = this.db
      .prepare(`SELECT * FROM bookmarks WHERE id = ? AND channel_id = ?`)
      .get(args.bookmark_id, channel.id) as BookmarkRow | undefined;
    if (!before) slackError("no_bookmark_found", 404);
    const out = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(before!.id);
      onDelta({ before, after: null });
      return {};
    })();
    return out;
  }

  bookmarksList(args: { channel_id: string }): Record<string, unknown> {
    const channel = this.requireChannel(args.channel_id);
    const rows = this.db
      .prepare(`SELECT * FROM bookmarks WHERE channel_id = ? ORDER BY created_at`)
      .all(channel.id) as BookmarkRow[];
    return { bookmarks: rows.map((row) => serializeBookmark(row)) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Team
  // ───────────────────────────────────────────────────────────────────────────

  teamInfo(args: { team?: string }): Record<string, unknown> {
    void args;
    return { team: serializeWorkspace(this.requireWorkspace()) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  private firstWorkspace(): WorkspaceRow | undefined {
    return this.db.prepare(`SELECT * FROM workspaces LIMIT 1`).get() as WorkspaceRow | undefined;
  }

  private requireWorkspace(): WorkspaceRow {
    const w = this.firstWorkspace();
    if (!w) slackError("team_not_found", 404);
    return w!;
  }

  private allChannels(): ChannelRow[] {
    // Insertion order (rowid), not `created_at, id`: created_at has wall-clock
    // millisecond precision, so ordering by it made the /_pome/state export
    // nondeterministic — a channel created within the same ms as the seed rows
    // tie-broke by id, while one created a ms later sorted last. rowid equals
    // creation order (created_at is monotonic within a run), which is what the
    // old ordering produced in every non-tie case (F-683 determinism check).
    return this.db.prepare(`SELECT * FROM channels ORDER BY rowid`).all() as ChannelRow[];
  }

  private allocId(workspaceId: string, prefix: string): string {
    const row = this.db
      .prepare(`UPDATE workspaces SET entity_counter = entity_counter + 1 WHERE id = ? RETURNING entity_counter`)
      .get(workspaceId) as { entity_counter: number } | undefined;
    if (!row) throw new Error(`workspace ${workspaceId} not found for id allocation`);
    return `${prefix}${String(row.entity_counter).padStart(6, "0")}`;
  }

  private allocMessageTs(channelId: string): string {
    // Real Slack ts is workspace-globally-unique. Increment the workspace
    // counter (not the channel counter) so two channels' first messages
    // get distinct ts values. The channels.ts_counter column is kept for
    // back-compat but no longer drives allocation.
    const channel = this.db
      .prepare(`SELECT team_id FROM channels WHERE id = ?`)
      .get(channelId) as { team_id: string } | undefined;
    if (!channel) throw new Error(`channel ${channelId} not found for ts allocation`);
    const row = this.db
      .prepare(`UPDATE workspaces SET ts_counter = ts_counter + 1 WHERE id = ? RETURNING ts_counter`)
      .get(channel.team_id) as { ts_counter: number } | undefined;
    if (!row) throw new Error(`workspace ${channel.team_id} not found for ts allocation`);
    return `${tsBaseSeconds()}.${padTsCounter(row.ts_counter)}`;
  }

  private resolveSeedUserId(ref: string | undefined, map: Map<string, string>): string | undefined {
    if (!ref) return undefined;
    return map.get(ref) ?? ref;
  }

  private resolveUser(ref: string | undefined): UserRow | undefined {
    if (!ref) return undefined;
    const byId = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(ref) as UserRow | undefined;
    if (byId) return byId;
    const workspace = this.firstWorkspace();
    if (!workspace) return undefined;
    const byName = this.db
      .prepare(`SELECT * FROM users WHERE team_id = ? AND name = ?`)
      .get(workspace.id, ref) as UserRow | undefined;
    if (byName) return byName;
    if (ref.includes("@")) {
      const byEmail = this.db
        .prepare(`SELECT * FROM users WHERE team_id = ? AND email = ?`)
        .get(workspace.id, ref) as UserRow | undefined;
      if (byEmail) return byEmail;
    }
    return undefined;
  }

  private resolveActorUser(actor: Actor): UserRow {
    if (actor.login) {
      const user = this.resolveUser(actor.login);
      if (!user) slackError("user_not_found", 404);
      return user;
    }
    const defaultUser = this.resolveUser("pome-agent");
    if (defaultUser) return defaultUser;
    const fallback = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(DEFAULT_BOT_USER) as UserRow | undefined;
    if (fallback) return fallback;
    slackError("user_not_found", 404);
  }

  private channelRequiresMembership(channel: ChannelRow): boolean {
    return Boolean(channel.is_private) || Boolean(channel.is_im) || Boolean(channel.is_mpim);
  }

  private assertChannelMember(channel: ChannelRow, userId: string): void {
    if (!this.channelRequiresMembership(channel)) return;
    const member = this.db
      .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, userId);
    if (!member) slackError("not_in_channel", 400);
  }

  private assertChannelMemberForActor(channel: ChannelRow, actor: Actor): void {
    this.assertChannelMember(channel, this.resolveActorUser(actor).id);
  }

  private requireChannel(ref: string): ChannelRow {
    const byId = this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(ref) as ChannelRow | undefined;
    if (byId) return byId;
    const workspace = this.firstWorkspace();
    if (workspace) {
      const cleaned = ref.startsWith("#") ? ref.slice(1) : ref;
      const byName = this.db
        .prepare(`SELECT * FROM channels WHERE team_id = ? AND name = ?`)
        .get(workspace.id, cleaned) as ChannelRow | undefined;
      if (byName) return byName;
    }
    notFound("channel_not_found");
  }

  private requireChannelRow(id: string): ChannelRow {
    const row = this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as ChannelRow | undefined;
    if (!row) slackError("channel_not_found", 404);
    return row!;
  }

  private requireMessageRow(channelId: string, ts: string): MessageRow {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channelId, ts) as MessageRow | undefined;
    if (!row) slackError("message_not_found", 404);
    return row!;
  }

  private requireScheduledMessage(id: string): ScheduledMessageRow {
    const row = this.db.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`).get(id) as ScheduledMessageRow | undefined;
    if (!row) slackError("scheduled_message_not_found", 404);
    return row!;
  }

  private channelMemberIds(channelId: string): string[] {
    return (
      this.db
        .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at, user_id`)
        .all(channelId) as Array<{ user_id: string }>
    ).map((r) => r.user_id);
  }

  private reactionsFor(channelId: string, ts: string): ReactionRow[] {
    return this.db
      .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? ORDER BY added_at, name, user_id`)
      .all(channelId, ts) as ReactionRow[];
  }

  private findDirectChannelBySignature(teamId: string, dmSignature: string): ChannelRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM channels WHERE team_id = ? AND dm_signature = ?`)
      .get(teamId, dmSignature) as ChannelRow | undefined;
    return row;
  }

  private userNameOf(id: string): string {
    const row = this.db.prepare(`SELECT name FROM users WHERE id = ?`).get(id) as { name: string } | undefined;
    return row?.name ?? id;
  }
}

function clampLimit(value: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function safeParseJson(raw: string | undefined | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sanitizeJsonString(raw: string, fallback: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    return fallback;
  }
}

function normalizeReactionName(raw: string): string {
  return raw.trim().replace(/^:|:$/g, "");
}

function filetypeMimetype(filetype: string): string {
  const mapping: Record<string, string> = {
    text: "text/plain",
    markdown: "text/markdown",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
  };
  return mapping[filetype] ?? "application/octet-stream";
}
