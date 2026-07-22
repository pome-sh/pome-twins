// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";
import { slackError, notFound, TwinError } from "../errors.js";
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
  SlackTwinDatabase,
  UserRow,
  WorkspaceRow,
} from "../types.js";
import { cursorDecode, cursorEncode, nowIso, nowUnix, padTsCounter, tsBaseSeconds } from "../util.js";
import type { Actor, SlackDomain } from "./slack-domain.js";
import { clampLimit } from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// Search
// ───────────────────────────────────────────────────────────────────────────

export function searchMessages(domain: SlackDomain, 
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
  const acting = domain.resolveActorUser(actor);
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
    domain.db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE text LIKE ? ESCAPE '\\' AND ${visibilityClause}`)
      .get(like, acting.id) as { c: number }
  ).c;
  const rows = domain.db
    .prepare(
      `SELECT * FROM messages
       WHERE text LIKE ? ESCAPE '\\' AND ${visibilityClause}
       ORDER BY ts ${sortDir}
       LIMIT ? OFFSET ?`
    )
    .all(like, acting.id, count, offset) as MessageRow[];
  const matches = rows.map((row) => {
    const channel = domain.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(row.channel_id) as ChannelRow | undefined;
    return {
      iid: `${row.channel_id}-${row.ts}`,
      type: "message",
      user: row.user_id,
      username: domain.userNameOf(row.user_id),
      ts: row.ts,
      text: row.text,
      permalink: `${SLACK_TWIN_HOST}/archives/${row.channel_id}/p${row.ts.replace(".", "")}`,
      team: domain.requireWorkspace().id,
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

