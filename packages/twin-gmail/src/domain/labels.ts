// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound } from "../errors.js";
import { nextId } from "../storage.js";
import type { GmailDomain } from "./gmail-domain.js";

export type LabelResource = {
  id: string;
  name: string;
  type: "system" | "user";
  textColor: string | null;
  backgroundColor: string | null;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
};

export function createLabel(
  domain: GmailDomain,
  email: string,
  name: string,
  color?: { textColor?: string; backgroundColor?: string }
): { id: string; name: string } {
  const mailboxId = domain.mailboxId(email);
  if (!name.trim()) invalidArgument("Label name is required");
  return domain.db.transaction(() => {
    const id = nextId(domain.db, mailboxId, "label_counter", "Label");
    try {
      domain.db
        .prepare(
          "INSERT INTO labels(mailbox_id, id, name, type, text_color, background_color) VALUES (?, ?, ?, 'user', ?, ?)"
        )
        .run(mailboxId, id, name.trim(), color?.textColor ?? null, color?.backgroundColor ?? null);
    } catch {
      invalidArgument(`Label already exists: ${name}`);
    }
    return { id, name: name.trim() };
  }).immediate();
}

export function listUserLabels(domain: GmailDomain, email: string): Array<{
  id: string;
  name: string;
  color?: { textColor?: string; backgroundColor?: string };
  threadsTotal: number;
  threadsUnread: number;
}> {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare(
      `SELECT l.id, l.name, l.text_color, l.background_color,
        COUNT(DISTINCT m.thread_id) AS threads_total,
        COUNT(DISTINCT CASE WHEN unread.message_id IS NOT NULL THEN m.thread_id END) AS threads_unread
       FROM labels l
       LEFT JOIN message_labels ml
         ON ml.mailbox_id = l.mailbox_id AND ml.label_id = l.id
       LEFT JOIN messages m
         ON m.mailbox_id = ml.mailbox_id AND m.id = ml.message_id
       LEFT JOIN message_labels unread
         ON unread.mailbox_id = m.mailbox_id
        AND unread.message_id = m.id
        AND unread.label_id = 'UNREAD'
       WHERE l.mailbox_id = ? AND l.type = 'user'
       GROUP BY l.mailbox_id, l.id
       ORDER BY l.name COLLATE NOCASE, l.id`
    )
    .all(mailboxId) as Array<{
    id: string;
    name: string;
    text_color: string | null;
    background_color: string | null;
    threads_total: number;
    threads_unread: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.text_color || row.background_color
      ? {
          color: {
            ...(row.text_color ? { textColor: row.text_color } : {}),
            ...(row.background_color ? { backgroundColor: row.background_color } : {}),
          },
        }
      : {}),
    threadsTotal: row.threads_total,
    threadsUnread: row.threads_unread,
  }));
}

/** Batch label list with counts (replaces per-label N+1 from rest-store). */
export function labels(domain: GmailDomain, email: string): LabelResource[] {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare(
      `SELECT l.id, l.name, l.type, l.text_color, l.background_color,
        COUNT(DISTINCT ml.message_id) AS messagesTotal,
        COUNT(DISTINCT CASE WHEN unread.message_id IS NOT NULL THEN ml.message_id END) AS messagesUnread,
        COUNT(DISTINCT m.thread_id) AS threadsTotal,
        COUNT(DISTINCT CASE WHEN unread.message_id IS NOT NULL THEN m.thread_id END) AS threadsUnread
       FROM labels l
       LEFT JOIN message_labels ml
         ON ml.mailbox_id = l.mailbox_id AND ml.label_id = l.id
       LEFT JOIN messages m
         ON m.mailbox_id = ml.mailbox_id AND m.id = ml.message_id
       LEFT JOIN message_labels unread
         ON unread.mailbox_id = ml.mailbox_id
        AND unread.message_id = ml.message_id
        AND unread.label_id = 'UNREAD'
       WHERE l.mailbox_id = ?
       GROUP BY l.mailbox_id, l.id
       ORDER BY CASE l.type WHEN 'system' THEN 0 ELSE 1 END, l.name COLLATE NOCASE, l.id`
    )
    .all(mailboxId) as Array<{
    id: string;
    name: string;
    type: "system" | "user";
    text_color: string | null;
    background_color: string | null;
    messagesTotal: number;
    messagesUnread: number;
    threadsTotal: number;
    threadsUnread: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    textColor: row.text_color,
    backgroundColor: row.background_color,
    messagesTotal: row.messagesTotal,
    messagesUnread: row.messagesUnread,
    threadsTotal: row.threadsTotal,
    threadsUnread: row.threadsUnread,
  }));
}

export function label(domain: GmailDomain, email: string, labelId: string): LabelResource {
  const found = labels(domain, email).find((item) => item.id === labelId);
  if (!found) notFound("Label");
  return found;
}

export function updateLabel(
  domain: GmailDomain,
  email: string,
  labelId: string,
  input: { name?: string; color?: { textColor?: string; backgroundColor?: string } },
  replace: boolean
): LabelResource {
  const mailboxId = domain.mailboxId(email);
  const current = label(domain, email, labelId);
  if (current.type !== "user") invalidArgument("System labels cannot be modified");
  const name = replace ? input.name : input.name ?? current.name;
  if (!name?.trim()) invalidArgument("Label name is required");
  const textColor = input.color?.textColor ?? (replace ? null : current.textColor);
  const backgroundColor = input.color?.backgroundColor ?? (replace ? null : current.backgroundColor);
  try {
    domain.db
      .prepare("UPDATE labels SET name = ?, text_color = ?, background_color = ? WHERE mailbox_id = ? AND id = ?")
      .run(name.trim(), textColor, backgroundColor, mailboxId, labelId);
  } catch {
    invalidArgument(`Label already exists: ${name}`);
  }
  return label(domain, email, labelId);
}

export function deleteLabel(domain: GmailDomain, email: string, labelId: string): void {
  const mailboxId = domain.mailboxId(email);
  const current = label(domain, email, labelId);
  if (current.type !== "user") invalidArgument("System labels cannot be deleted");
  domain.db.prepare("DELETE FROM labels WHERE mailbox_id = ? AND id = ?").run(mailboxId, labelId);
}
