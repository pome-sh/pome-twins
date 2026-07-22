// SPDX-License-Identifier: Apache-2.0
import { notFound } from "../errors.js";
import type { SearchDocument } from "../search-parse.js";
import type { GmailTwinDatabase, MessageRow, SemanticMessage } from "../types.js";

/** Batch-load labels + attachments for many message ids (avoids semanticMessage × N). */
export function batchSemanticMessages(
  db: GmailTwinDatabase,
  mailboxId: number,
  messageIds: string[]
): SemanticMessage[] {
  if (!messageIds.length) return [];
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE mailbox_id = ? AND id IN (${placeholders})`
    )
    .all(mailboxId, ...messageIds) as MessageRow[];
  if (rows.length !== messageIds.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = messageIds.find((id) => !found.has(id));
    if (missing) notFound("Message");
  }
  const byId = new Map(rows.map((row) => [row.id, row]));

  const labelRows = db
    .prepare(
      `SELECT message_id, label_id FROM message_labels
       WHERE mailbox_id = ? AND message_id IN (${placeholders})
       ORDER BY message_id, label_id`
    )
    .all(mailboxId, ...messageIds) as Array<{ message_id: string; label_id: string }>;
  const labelsByMessage = new Map<string, string[]>();
  for (const row of labelRows) {
    const list = labelsByMessage.get(row.message_id) ?? [];
    list.push(row.label_id);
    labelsByMessage.set(row.message_id, list);
  }

  const attachmentRows = db
    .prepare(
      `SELECT message_id, id, filename, mime_type, disposition, content_id, sha256, size, part_index
       FROM attachments
       WHERE mailbox_id = ? AND message_id IN (${placeholders})
       ORDER BY message_id, part_index`
    )
    .all(mailboxId, ...messageIds) as Array<{
    message_id: string;
    id: string;
    filename: string;
    mime_type: string;
    disposition: string;
    content_id: string | null;
    sha256: string;
    size: number;
    part_index: number;
  }>;
  const attachmentsByMessage = new Map<string, SemanticMessage["attachments"]>();
  for (const row of attachmentRows) {
    const list = attachmentsByMessage.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      disposition: row.disposition,
      contentId: row.content_id,
      sha256: row.sha256,
      size: row.size,
    });
    attachmentsByMessage.set(row.message_id, list);
  }

  return messageIds.map((id) => {
    const row = byId.get(id)!;
    return {
      id: row.id,
      threadId: row.thread_id,
      rfcMessageId: row.rfc_message_id,
      internalDate: row.internal_date,
      from: row.from_address,
      to: JSON.parse(row.to_json) as string[],
      cc: JSON.parse(row.cc_json) as string[],
      bcc: JSON.parse(row.bcc_json) as string[],
      subject: row.subject,
      snippet: row.snippet,
      text: row.text_body,
      html: row.html_body,
      sizeEstimate: row.size_estimate,
      labelIds: labelsByMessage.get(id) ?? [],
      attachments: attachmentsByMessage.get(id) ?? [],
    };
  });
}

/** Build search documents for already-hydrated messages with batched header/user-label lookups. */
export function batchSearchDocuments(
  db: GmailTwinDatabase,
  mailboxId: number,
  messages: SemanticMessage[]
): SearchDocument[] {
  if (!messages.length) return [];
  const ids = messages.map((message) => message.id);
  const placeholders = ids.map(() => "?").join(", ");
  const metaRows = db
    .prepare(
      `SELECT id, delivered_to, headers_json FROM messages
       WHERE mailbox_id = ? AND id IN (${placeholders})`
    )
    .all(mailboxId, ...ids) as Array<{ id: string; delivered_to: string; headers_json: string }>;
  const metaById = new Map(metaRows.map((row) => [row.id, row]));

  const userLabelRows = db
    .prepare(
      `SELECT ml.message_id, COUNT(*) AS count
       FROM message_labels ml
       JOIN labels l ON l.mailbox_id = ml.mailbox_id AND l.id = ml.label_id
       WHERE ml.mailbox_id = ? AND ml.message_id IN (${placeholders}) AND l.type = 'user'
       GROUP BY ml.message_id`
    )
    .all(mailboxId, ...ids) as Array<{ message_id: string; count: number }>;
  const userLabelCount = new Map(userLabelRows.map((row) => [row.message_id, row.count]));

  return messages.map((message) => {
    const meta = metaById.get(message.id)!;
    return {
      from: message.from.toLowerCase(),
      to: message.to.map((item) => item.toLowerCase()),
      cc: message.cc.map((item) => item.toLowerCase()),
      bcc: message.bcc.map((item) => item.toLowerCase()),
      deliveredTo: meta.delivered_to.toLowerCase(),
      subject: message.subject,
      text: message.text,
      html: message.html,
      dateMs: message.internalDate,
      rfcMessageId: message.rfcMessageId,
      size: message.sizeEstimate,
      labels: message.labelIds,
      userLabelCount: userLabelCount.get(message.id) ?? 0,
      attachmentNames: message.attachments.map((attachment) => attachment.filename),
      attachmentMimeTypes: message.attachments.map((attachment) => attachment.mimeType),
      headers: JSON.parse(meta.headers_json) as Array<{ name: string; value: string }>,
    };
  });
}

export function searchDocument(
  db: GmailTwinDatabase,
  mailboxId: number,
  message: SemanticMessage
): SearchDocument {
  return batchSearchDocuments(db, mailboxId, [message])[0]!;
}

export function searchNow(db: GmailTwinDatabase): number {
  const clock = db.prepare("SELECT value FROM gmail_config WHERE key = 'clock'").get() as { value: string };
  const row = db
    .prepare("SELECT COALESCE(MAX(logical_clock), 0) AS value FROM mailbox_counters")
    .get() as { value: number };
  return Date.parse(clock.value) + row.value * 1000;
}
