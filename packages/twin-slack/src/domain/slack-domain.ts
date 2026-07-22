// file-size: SlackDomain coordinator keeps seed/lifecycle plus shared channel/user helpers; area modules own conversations/chat/etc.
// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";
import { resetDatabase } from "../db.js";
import {
  canvasesCreate as canvasesCreateImpl,
  canvasesDelete as canvasesDeleteImpl,
  canvasesEdit as canvasesEditImpl,
} from "./canvases.js";
import { emojiList as emojiListImpl, seedEmojiRows } from "./emoji.js";
import {
  conversationsSetPurpose as conversationsSetPurposeImpl,
  conversationsSetTopic as conversationsSetTopicImpl,
} from "./topic.js";
import { slackError, notFound, TwinError } from "../errors.js";
import { parseSeed } from "../seed.js";
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
  SlackStateSeed,
  SlackTwinDatabase,
  UserRow,
  WorkspaceRow,
} from "../types.js";
import { cursorDecode, cursorEncode, nowIso, nowUnix, padTsCounter, tsBaseSeconds } from "../util.js";
import * as bookmarks from "./bookmarks.js";
import * as chat from "./chat.js";
import * as conversations from "./conversations.js";
import * as files from "./files.js";
import * as pins from "./pins.js";
import * as reactions from "./reactions.js";
import * as search from "./search.js";
import * as team from "./team.js";
import * as users from "./users.js";

export type DeltaHook = (delta: StateDelta) => void;

export const NOOP: DeltaHook = () => {};

export type Actor = {
  login?: string;
};

const DEFAULT_BOT_USER = "U_PRIMARY";
const DEFAULT_TEAM_ID = "T_POME";


export class SlackDomain {
  constructor(readonly db: SlackTwinDatabase) {}

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

      const seedEmoji = state.emoji ?? [];
      if (seedEmoji.length > 0) {
        seedEmojiRows(this.db, teamId, seedEmoji);
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
      canvases: this.db.prepare(`SELECT * FROM canvases ORDER BY id`).all(),
      emoji: this.db.prepare(`SELECT * FROM emoji ORDER BY team_id, name`).all(),
    };
  }


  summarizeState(): Record<string, number> {
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
      canvases: get(`SELECT COUNT(*) AS c FROM canvases`),
      emoji: get(`SELECT COUNT(*) AS c FROM emoji`),
    };
  }


  authTest(actor: Actor): Record<string, unknown> {
    return team.authTest(this, actor);
  }

  conversationsList(args: {
    types?: string;
    exclude_archived?: boolean;
    limit?: number;
    cursor?: string;
    team_id?: string;
  }): Record<string, unknown> {
    return conversations.conversationsList(this, args);
  }

  conversationsInfo(args: { channel: string; include_num_members?: boolean }, actor: Actor = {}): Record<string, unknown> {
    return conversations.conversationsInfo(this, args, actor);
  }

  conversationsCreate(args: { name: string; is_private?: boolean; team_id?: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsCreate(this, args, actor, onDelta);
  }

  conversationsArchive(args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsArchive(this, args, actor, onDelta);
  }

  conversationsInvite(args: { channel: string; users: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsInvite(this, args, actor, onDelta);
  }

  conversationsJoin(args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsJoin(this, args, actor, onDelta);
  }

  conversationsLeave(args: { channel: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsLeave(this, args, actor, onDelta);
  }

  conversationsKick(args: { channel: string; user: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsKick(this, args, actor, onDelta);
  }

  conversationsMembers(args: { channel: string; limit?: number; cursor?: string }, actor: Actor = {}): Record<string, unknown> {
    return conversations.conversationsMembers(this, args, actor);
  }

  conversationsHistory(args: {
    channel: string;
    cursor?: string;
    inclusive?: boolean;
    latest?: string;
    limit?: number;
    oldest?: string;
  }, actor: Actor = {}): Record<string, unknown> {
    return conversations.conversationsHistory(this, args, actor);
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
    return conversations.conversationsReplies(this, args, actor);
  }

  conversationsOpen(args: { users?: string; channel?: string; return_im?: boolean }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return conversations.conversationsOpen(this, args, actor, onDelta);
  }

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
    return chat.chatPostMessage(this, args, actor, onDelta);
  }

  chatUpdate(
    args: { channel: string; ts: string; text?: string; blocks?: string; attachments?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    return chat.chatUpdate(this, args, actor, onDelta);
  }

  chatDelete(args: { channel: string; ts: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return chat.chatDelete(this, args, actor, onDelta);
  }

  chatScheduleMessage(
    args: { channel: string; text: string; post_at: number; thread_ts?: string; blocks?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    return chat.chatScheduleMessage(this, args, actor, onDelta);
  }

  chatDeleteScheduledMessage(args: { channel: string; scheduled_message_id: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return chat.chatDeleteScheduledMessage(this, args, actor, onDelta);
  }

  reactionsAdd(args: { channel: string; timestamp: string; name: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return reactions.reactionsAdd(this, args, actor, onDelta);
  }

  reactionsRemove(args: { channel: string; timestamp: string; name: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return reactions.reactionsRemove(this, args, actor, onDelta);
  }

  reactionsGet(args: { channel: string; timestamp: string; full?: boolean }, actor: Actor = {}): Record<string, unknown> {
    return reactions.reactionsGet(this, args, actor);
  }

  usersList(args: { cursor?: string; limit?: number; include_locale?: boolean; team_id?: string }): Record<string, unknown> {
    return users.usersList(this, args);
  }

  usersInfo(args: { user: string; include_locale?: boolean }): Record<string, unknown> {
    return users.usersInfo(this, args);
  }

  usersLookupByEmail(args: { email: string }): Record<string, unknown> {
    return users.usersLookupByEmail(this, args);
  }

  usersProfileGet(args: { user?: string; include_labels?: boolean }, actor: Actor): Record<string, unknown> {
    return users.usersProfileGet(this, args, actor);
  }

  usersProfileSet(args: { user?: string; profile?: string; name?: string; value?: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return users.usersProfileSet(this, args, actor, onDelta);
  }

  pinsAdd(args: { channel: string; timestamp: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return pins.pinsAdd(this, args, actor, onDelta);
  }

  pinsRemove(args: { channel: string; timestamp: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return pins.pinsRemove(this, args, actor, onDelta);
  }

  pinsList(args: { channel: string }, actor: Actor = {}): Record<string, unknown> {
    return pins.pinsList(this, args, actor);
  }

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
    return search.searchMessages(this, args, actor);
  }

  filesUpload(
    args: { channels?: string; channel?: string; filename?: string; title?: string; filetype?: string; content?: string; initial_comment?: string; thread_ts?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    return files.filesUpload(this, args, actor, onDelta);
  }

  filesInfo(args: { file: string }): Record<string, unknown> {
    return files.filesInfo(this, args);
  }

  filesList(args: { channel?: string; user?: string; count?: number; page?: number; types?: string }): Record<string, unknown> {
    return files.filesList(this, args);
  }

  filesDelete(args: { file: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return files.filesDelete(this, args, actor, onDelta);
  }

  bookmarksAdd(
    args: { channel_id: string; title: string; type?: string; link?: string; emoji?: string; entity_id?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    return bookmarks.bookmarksAdd(this, args, actor, onDelta);
  }

  bookmarksRemove(args: { channel_id: string; bookmark_id: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
    return bookmarks.bookmarksRemove(this, args, actor, onDelta);
  }

  bookmarksList(args: { channel_id: string }): Record<string, unknown> {
    return bookmarks.bookmarksList(this, args);
  }

  teamInfo(args: { team?: string }): Record<string, unknown> {
    return team.teamInfo(this, args);
  }


  // ───────────────────────────────────────────────────────────────────────────
  // Conversations topic / purpose (Wave 3)
  // ───────────────────────────────────────────────────────────────────────────

  conversationsSetTopic(
    args: { channel: string; topic: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    return conversationsSetTopicImpl(
      {
        db: this.db,
        requireChannel: (ref) => this.requireChannel(ref),
        actor: this.resolveActorUser(actor),
      },
      args,
      onDelta
    );
  }


  conversationsSetPurpose(
    args: { channel: string; purpose: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    return conversationsSetPurposeImpl(
      {
        db: this.db,
        requireChannel: (ref) => this.requireChannel(ref),
        actor: this.resolveActorUser(actor),
      },
      args,
      onDelta
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Canvases (Wave 3)
  // ───────────────────────────────────────────────────────────────────────────

  canvasesCreate(
    args: { title?: string; document_content?: unknown; channel_id?: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    return canvasesCreateImpl(
      {
        db: this.db,
        workspaceId: workspace.id,
        actor: this.resolveActorUser(actor),
        allocId: (prefix) => this.allocId(workspace.id, prefix),
        requireChannel: (ref) => this.requireChannel(ref),
      },
      args,
      onDelta
    );
  }


  canvasesEdit(
    args: { canvas_id: string; changes: unknown },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    return canvasesEditImpl(
      {
        db: this.db,
        workspaceId: workspace.id,
        actor: this.resolveActorUser(actor),
        allocId: (prefix) => this.allocId(workspace.id, prefix),
        requireChannel: (ref) => this.requireChannel(ref),
      },
      args,
      onDelta
    );
  }


  canvasesDelete(
    args: { canvas_id: string },
    actor: Actor,
    onDelta: DeltaHook = NOOP
  ): Record<string, unknown> {
    const workspace = this.requireWorkspace();
    return canvasesDeleteImpl(
      {
        db: this.db,
        workspaceId: workspace.id,
        actor: this.resolveActorUser(actor),
        allocId: (prefix) => this.allocId(workspace.id, prefix),
        requireChannel: (ref) => this.requireChannel(ref),
      },
      args,
      onDelta
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Emoji (Wave 3)
  // ───────────────────────────────────────────────────────────────────────────

  emojiList(_args: Record<string, unknown> = {}): Record<string, unknown> {
    void _args;
    return emojiListImpl({ db: this.db, workspaceId: this.requireWorkspace().id });
  }


  // ----- shared helpers (used by domain/* modules) -----

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  firstWorkspace(): WorkspaceRow | undefined {
    return this.db.prepare(`SELECT * FROM workspaces LIMIT 1`).get() as WorkspaceRow | undefined;
  }


  requireWorkspace(): WorkspaceRow {
    const w = this.firstWorkspace();
    if (!w) slackError("team_not_found", 404);
    return w!;
  }


  allChannels(): ChannelRow[] {
    // Insertion order (rowid), not `created_at, id`: created_at has wall-clock
    // millisecond precision, so ordering by it made the /_pome/state export
    // nondeterministic — a channel created within the same ms as the seed rows
    // tie-broke by id, while one created a ms later sorted last. rowid equals
    // creation order (created_at is monotonic within a run), which is what the
    // old ordering produced in every non-tie case (F-683 determinism check).
    return this.db.prepare(`SELECT * FROM channels ORDER BY rowid`).all() as ChannelRow[];
  }


  allocId(workspaceId: string, prefix: string): string {
    const row = this.db
      .prepare(`UPDATE workspaces SET entity_counter = entity_counter + 1 WHERE id = ? RETURNING entity_counter`)
      .get(workspaceId) as { entity_counter: number } | undefined;
    if (!row) throw new Error(`workspace ${workspaceId} not found for id allocation`);
    return `${prefix}${String(row.entity_counter).padStart(6, "0")}`;
  }


  allocMessageTs(channelId: string): string {
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


  resolveSeedUserId(ref: string | undefined, map: Map<string, string>): string | undefined {
    if (!ref) return undefined;
    return map.get(ref) ?? ref;
  }


  resolveUser(ref: string | undefined): UserRow | undefined {
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


  resolveActorUser(actor: Actor): UserRow {
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


  channelRequiresMembership(channel: ChannelRow): boolean {
    return Boolean(channel.is_private) || Boolean(channel.is_im) || Boolean(channel.is_mpim);
  }


  assertChannelMember(channel: ChannelRow, userId: string): void {
    if (!this.channelRequiresMembership(channel)) return;
    const member = this.db
      .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
      .get(channel.id, userId);
    if (!member) slackError("not_in_channel", 400);
  }


  assertChannelMemberForActor(channel: ChannelRow, actor: Actor): void {
    this.assertChannelMember(channel, this.resolveActorUser(actor).id);
  }


  requireChannel(ref: string): ChannelRow {
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


  requireChannelRow(id: string): ChannelRow {
    const row = this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as ChannelRow | undefined;
    if (!row) slackError("channel_not_found", 404);
    return row!;
  }


  requireMessageRow(channelId: string, ts: string): MessageRow {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(channelId, ts) as MessageRow | undefined;
    if (!row) slackError("message_not_found", 404);
    return row!;
  }


  requireScheduledMessage(id: string): ScheduledMessageRow {
    const row = this.db.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`).get(id) as ScheduledMessageRow | undefined;
    if (!row) slackError("scheduled_message_not_found", 404);
    return row!;
  }


  channelMemberIds(channelId: string): string[] {
    return (
      this.db
        .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at, user_id`)
        .all(channelId) as Array<{ user_id: string }>
    ).map((r) => r.user_id);
  }


  reactionsFor(channelId: string, ts: string): ReactionRow[] {
    return this.db
      .prepare(`SELECT * FROM reactions WHERE channel_id = ? AND message_ts = ? ORDER BY added_at, name, user_id`)
      .all(channelId, ts) as ReactionRow[];
  }


  findDirectChannelBySignature(teamId: string, dmSignature: string): ChannelRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM channels WHERE team_id = ? AND dm_signature = ?`)
      .get(teamId, dmSignature) as ChannelRow | undefined;
    return row;
  }


  userNameOf(id: string): string {
    const row = this.db.prepare(`SELECT name FROM users WHERE id = ?`).get(id) as { name: string } | undefined;
    return row?.name ?? id;
  }

}
