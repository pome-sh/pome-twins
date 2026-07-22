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
// Bookmarks
// ───────────────────────────────────────────────────────────────────────────

export function bookmarksAdd(domain: SlackDomain, 
  args: { channel_id: string; title: string; type?: string; link?: string; emoji?: string; entity_id?: string },
  actor: Actor,
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel_id);
  if (!args.title) slackError("invalid_arguments", 400);
  if (!args.link && (!args.type || args.type === "link")) slackError("invalid_arguments", 400);
  const acting = domain.resolveActorUser(actor);
  const id = domain.allocId(domain.requireWorkspace().id, "Bk");
  const out = domain.db.transaction(() => {
    domain.db
      .prepare(
        `INSERT INTO bookmarks (id, channel_id, title, link, emoji, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, channel.id, args.title, args.link ?? "", args.emoji ?? null, args.type ?? "link", acting.id, nowIso());
    const after = domain.db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id) as BookmarkRow;
    onDelta({ before: null, after });
    return { bookmark: serializeBookmark(after) };
  })();
  return out;
}


export function bookmarksRemove(domain: SlackDomain, args: { channel_id: string; bookmark_id: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  void actor;
  const channel = domain.requireChannel(args.channel_id);
  const before = domain.db
    .prepare(`SELECT * FROM bookmarks WHERE id = ? AND channel_id = ?`)
    .get(args.bookmark_id, channel.id) as BookmarkRow | undefined;
  if (!before) slackError("no_bookmark_found", 404);
  const out = domain.db.transaction(() => {
    domain.db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(before!.id);
    onDelta({ before, after: null });
    return {};
  })();
  return out;
}


export function bookmarksList(domain: SlackDomain, args: { channel_id: string }): Record<string, unknown> {
  const channel = domain.requireChannel(args.channel_id);
  const rows = domain.db
    .prepare(`SELECT * FROM bookmarks WHERE channel_id = ? ORDER BY created_at`)
    .all(channel.id) as BookmarkRow[];
  return { bookmarks: rows.map((row) => serializeBookmark(row)) };
}

