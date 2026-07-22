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
import { clampLimit, filetypeMimetype } from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// Files
// ───────────────────────────────────────────────────────────────────────────

export function filesUpload(domain: SlackDomain, 
  args: { channels?: string; channel?: string; filename?: string; title?: string; filetype?: string; content?: string; initial_comment?: string; thread_ts?: string },
  actor: Actor,
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  const workspace = domain.requireWorkspace();
  const acting = domain.resolveActorUser(actor);
  const channelsRaw = args.channels ?? args.channel ?? "";
  const channelIds = channelsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((ref) => domain.requireChannel(ref).id);
  const id = domain.allocId(workspace.id, "F");
  const name = args.filename ?? `untitled-${id}.txt`;
  const title = args.title ?? name;
  const filetype = args.filetype ?? "text";
  const content = args.content ?? null;
  const size = content ? Buffer.byteLength(content, "utf8") : 0;
  const out = domain.db.transaction(() => {
    domain.db
      .prepare(
        `INSERT INTO files (id, team_id, user_id, name, title, mimetype, filetype, size, url_private, channels_json, deleted, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?)`
      )
      .run(id, workspace.id, acting.id, name, title, filetypeMimetype(filetype), filetype, size, JSON.stringify(channelIds), content, nowIso());
    const after = domain.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow;
    // Optionally post initial_comment as a message in the first channel.
    if (args.initial_comment && channelIds.length > 0) {
      const ts = domain.allocMessageTs(channelIds[0]!);
      domain.db
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


export function filesInfo(domain: SlackDomain, args: { file: string }): Record<string, unknown> {
  const file = domain.db.prepare(`SELECT * FROM files WHERE id = ?`).get(args.file) as FileRow | undefined;
  if (!file) slackError("file_not_found", 404);
  return {
    file: serializeFile(file!),
    comments: [],
    response_metadata: { next_cursor: "" },
  };
}


export function filesList(domain: SlackDomain, args: { channel?: string; user?: string; count?: number; page?: number; types?: string }): Record<string, unknown> {
  const count = clampLimit(args.count, 1000, 100);
  const page = Math.max(1, Math.floor(args.page ?? 1));
  const offset = (page - 1) * count;
  const params: unknown[] = [];
  const where: string[] = [`deleted = 0`];
  if (args.user) {
    const user = domain.resolveUser(args.user);
    if (!user) slackError("user_not_found", 404);
    where.push(`user_id = ?`);
    params.push(user!.id);
  }
  let sql = `SELECT * FROM files WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(count, offset);
  let rows = domain.db.prepare(sql).all(...params) as FileRow[];
  if (args.channel) {
    const channelId = domain.requireChannel(args.channel).id;
    rows = rows.filter((row) => (JSON.parse(row.channels_json) as string[]).includes(channelId));
  }
  const total = (domain.db.prepare(`SELECT COUNT(*) AS c FROM files WHERE deleted = 0`).get() as { c: number }).c;
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


export function filesDelete(domain: SlackDomain, args: { file: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  void actor;
  const before = domain.db.prepare(`SELECT * FROM files WHERE id = ?`).get(args.file) as FileRow | undefined;
  if (!before) slackError("file_not_found", 404);
  const out = domain.db.transaction(() => {
    domain.db.prepare(`UPDATE files SET deleted = 1 WHERE id = ?`).run(args.file);
    const after = domain.db.prepare(`SELECT * FROM files WHERE id = ?`).get(args.file) as FileRow;
    onDelta({ before, after });
    return {};
  })();
  return out;
}

