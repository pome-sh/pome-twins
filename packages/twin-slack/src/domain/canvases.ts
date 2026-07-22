// SPDX-License-Identifier: Apache-2.0
//
// Canvas lifecycle (Wave 3 / SL3). Shape-tier content model: markdown blob +
// title only — section_id-relative edits are accepted but applied as coarse
// whole-document ops (insert_after/before → append; section replace → full
// replace; section delete → no-op). Matches warm × shape target.

import type { StateDelta } from "@pome-sh/shared-types";
import { slackError } from "../errors.js";
import type { CanvasRow, ChannelMemberRow, ChannelRow, SlackTwinDatabase } from "../types.js";
import { nowIso } from "../util.js";

export type DeltaHook = (delta: StateDelta) => void;

export type CanvasActor = { id: string };

export type CanvasHost = {
  db: SlackTwinDatabase;
  workspaceId: string;
  actor: CanvasActor;
  allocId: (prefix: string) => string;
  requireChannel?: (ref: string) => ChannelRow;
};

export type DocumentContent = { type: string; markdown: string };

export type CanvasChange = {
  operation: string;
  document_content?: DocumentContent;
  title_content?: DocumentContent;
  section_id?: string;
};

const NOOP: DeltaHook = () => {};

export function canvasesCreate(
  host: CanvasHost,
  args: { title?: string; document_content?: unknown; channel_id?: string },
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  const content = coerceDocumentContent(args.document_content);
  if (args.document_content !== undefined && !content) {
    slackError("canvas_creation_failed", 400, { detail: "invalid document_content" });
  }
  if (content && content.type !== "markdown") {
    slackError("canvas_creation_failed", 400, { detail: `unsupported content type: ${content.type}` });
  }
  if (args.channel_id) {
    assertChannelAccess(host, args.channel_id);
  }
  const id = host.allocId("F");
  const now = nowIso();
  const title = args.title ?? "";
  const markdown = content?.markdown ?? "";
  const out = host.db.transaction(() => {
    host.db
      .prepare(
        `INSERT INTO canvases (id, team_id, title, markdown, channel_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, host.workspaceId, title, markdown, args.channel_id ?? null, host.actor.id, now, now);
    const after = host.db.prepare(`SELECT * FROM canvases WHERE id = ?`).get(id) as CanvasRow;
    onDelta({ before: null, after });
    return { canvas_id: id };
  })();
  return out;
}

export function canvasesEdit(
  host: CanvasHost,
  args: { canvas_id: string; changes: unknown },
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  if (!args.canvas_id) slackError("invalid_arguments", 400);
  const before = host.db.prepare(`SELECT * FROM canvases WHERE id = ?`).get(args.canvas_id) as
    | CanvasRow
    | undefined;
  if (!before) slackError("canvas_not_found", 404);
  assertCanvasAccess(host, before);
  const changes = coerceChanges(args.changes);
  if (!changes || changes.length === 0) slackError("invalid_arguments", 400);
  // Real Slack currently accepts one operation per call; we apply the first.
  const change = changes[0]!;
  const next = applyChange(before!, change);
  const now = nowIso();
  const out = host.db.transaction(() => {
    host.db
      .prepare(`UPDATE canvases SET title = ?, markdown = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.markdown, now, before!.id);
    const after = host.db.prepare(`SELECT * FROM canvases WHERE id = ?`).get(before!.id) as CanvasRow;
    onDelta({ before, after });
    return {};
  })();
  return out;
}

export function canvasesDelete(
  host: CanvasHost,
  args: { canvas_id: string },
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  if (!args.canvas_id) slackError("invalid_arguments", 400);
  const before = host.db.prepare(`SELECT * FROM canvases WHERE id = ?`).get(args.canvas_id) as
    | CanvasRow
    | undefined;
  if (!before) slackError("canvas_not_found", 404);
  assertCanvasAccess(host, before);
  const out = host.db.transaction(() => {
    host.db.prepare(`DELETE FROM canvases WHERE id = ?`).run(before!.id);
    onDelta({ before, after: null });
    return {};
  })();
  return out;
}

function assertChannelAccess(host: CanvasHost, channelRef: string): void {
  const channel = host.requireChannel
    ? host.requireChannel(channelRef)
    : (host.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channelRef) as ChannelRow | undefined);
  if (!channel) slackError("channel_not_found", 404);
  const member = host.db
    .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
    .get(channel.id, host.actor.id) as ChannelMemberRow | undefined;
  if (!member) slackError("not_in_channel", 400);
}

/** Channel members may edit/delete channel canvases; creators may edit unattached ones. */
function assertCanvasAccess(host: CanvasHost, canvas: CanvasRow): void {
  if (canvas.channel_id) {
    assertChannelAccess(host, canvas.channel_id);
    return;
  }
  if (canvas.created_by !== host.actor.id) slackError("restricted_action", 403);
}

function applyChange(
  row: CanvasRow,
  change: CanvasChange
): { title: string; markdown: string } {
  const op = change.operation;
  if (op === "rename") {
    const title = change.title_content?.markdown;
    if (title === undefined) slackError("invalid_arguments", 400);
    return { title: title!, markdown: row.markdown };
  }
  const doc = change.document_content;
  if (op === "insert_at_start") {
    if (!doc) slackError("invalid_arguments", 400);
    const markdown = doc!.markdown + (row.markdown ? `\n${row.markdown}` : "");
    return { title: row.title, markdown };
  }
  if (op === "insert_at_end" || op === "insert_after" || op === "insert_before") {
    if (!doc) slackError("invalid_arguments", 400);
    if ((op === "insert_after" || op === "insert_before") && !change.section_id) {
      slackError("invalid_arguments", 400);
    }
    const markdown = row.markdown ? `${row.markdown}\n${doc!.markdown}` : doc!.markdown;
    return { title: row.title, markdown };
  }
  if (op === "replace") {
    if (!doc) slackError("invalid_arguments", 400);
    return { title: row.title, markdown: doc!.markdown };
  }
  if (op === "delete") {
    if (!change.section_id) slackError("invalid_arguments", 400);
    // Shape-tier: section delete is a no-op success (no section model).
    return { title: row.title, markdown: row.markdown };
  }
  slackError("canvas_editing_failed", 400, { detail: `unsupported operation: ${op}` });
}

export function coerceDocumentContent(raw: unknown): DocumentContent | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.markdown !== "string") return undefined;
  return {
    type: typeof obj.type === "string" ? obj.type : "markdown",
    markdown: obj.markdown,
  };
}

export function coerceChanges(raw: unknown): CanvasChange[] | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;
  const out: CanvasChange[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const obj = item as Record<string, unknown>;
    if (typeof obj.operation !== "string") return undefined;
    out.push({
      operation: obj.operation,
      document_content: coerceDocumentContent(obj.document_content),
      title_content: coerceDocumentContent(obj.title_content),
      section_id: typeof obj.section_id === "string" ? obj.section_id : undefined,
    });
  }
  return out;
}
