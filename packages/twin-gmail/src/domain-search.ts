// SPDX-License-Identifier: Apache-2.0
import { unsupported } from "./errors.js";
import { matchesSearch, parseSearchQuery, type SearchDocument } from "./search.js";
import { assertLabels, semanticMessage } from "./storage.js";
import type { GmailTwinDatabase, SemanticMessage } from "./types.js";

export function applyInboundFilters(db: GmailTwinDatabase, mailboxId: number, messageId: string): void {
  const filters = db
    .prepare("SELECT criteria_json, action_json FROM filters WHERE mailbox_id = ? ORDER BY id")
    .all(mailboxId) as Array<{ criteria_json: string; action_json: string }>;
  for (const row of filters) {
    const criteria = JSON.parse(row.criteria_json) as Record<string, unknown>;
    const action = JSON.parse(row.action_json) as {
      addLabelIds?: string[];
      removeLabelIds?: string[];
      forward?: string;
    };
    if (action.forward) unsupported("Filter forwarding is not implemented");
    const message = semanticMessage(db, mailboxId, messageId);
    const document = searchDocument(db, mailboxId, message);
    const criteriaTo = typeof criteria.to === "string" ? criteria.to.toLowerCase() : undefined;
    const now = searchNow(db);
    const matches =
      (typeof criteria.from !== "string" || document.from.includes(criteria.from.toLowerCase())) &&
      (criteriaTo === undefined || document.to.some((to) => to.includes(criteriaTo))) &&
      (typeof criteria.subject !== "string" ||
        document.subject.toLowerCase().includes(criteria.subject.toLowerCase())) &&
      (criteria.hasAttachment !== true || document.attachmentNames.length > 0) &&
      (typeof criteria.size !== "number" ||
        (criteria.sizeComparison === "smaller" ? document.size < criteria.size : document.size > criteria.size)) &&
      (typeof criteria.query !== "string" || matchesSearch(parseSearchQuery(criteria.query), document, now)) &&
      (typeof criteria.negatedQuery !== "string" ||
        !matchesSearch(parseSearchQuery(criteria.negatedQuery), document, now));
    if (!matches) continue;
    assertLabels(db, mailboxId, [...(action.addLabelIds ?? []), ...(action.removeLabelIds ?? [])]);
    for (const label of action.removeLabelIds ?? []) {
      db.prepare("DELETE FROM message_labels WHERE mailbox_id = ? AND message_id = ? AND label_id = ?")
        .run(mailboxId, messageId, label);
    }
    for (const label of action.addLabelIds ?? []) {
      db.prepare("INSERT OR IGNORE INTO message_labels(mailbox_id, message_id, label_id) VALUES (?, ?, ?)")
        .run(mailboxId, messageId, label);
    }
  }
}

export function searchDocument(
  db: GmailTwinDatabase,
  mailboxId: number,
  message: SemanticMessage
): SearchDocument {
  const row = db
    .prepare("SELECT delivered_to, headers_json FROM messages WHERE mailbox_id = ? AND id = ?")
    .get(mailboxId, message.id) as { delivered_to: string; headers_json: string };
  const userLabelCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM message_labels ml
         JOIN labels l ON l.mailbox_id = ml.mailbox_id AND l.id = ml.label_id
         WHERE ml.mailbox_id = ? AND ml.message_id = ? AND l.type = 'user'`
      )
      .get(mailboxId, message.id) as { count: number }
  ).count;
  return {
    from: message.from.toLowerCase(),
    to: message.to.map((item) => item.toLowerCase()),
    cc: message.cc.map((item) => item.toLowerCase()),
    bcc: message.bcc.map((item) => item.toLowerCase()),
    deliveredTo: row.delivered_to.toLowerCase(),
    subject: message.subject,
    text: message.text,
    html: message.html,
    dateMs: message.internalDate,
    rfcMessageId: message.rfcMessageId,
    size: message.sizeEstimate,
    labels: message.labelIds,
    userLabelCount,
    attachmentNames: message.attachments.map((attachment) => attachment.filename),
    attachmentMimeTypes: message.attachments.map((attachment) => attachment.mimeType),
    headers: JSON.parse(row.headers_json) as Array<{ name: string; value: string }>,
  };
}

export function searchNow(db: GmailTwinDatabase): number {
  const clock = db.prepare("SELECT value FROM gmail_config WHERE key = 'clock'").get() as { value: string };
  const row = db
    .prepare("SELECT COALESCE(MAX(logical_clock), 0) AS value FROM mailbox_counters")
    .get() as { value: number };
  return Date.parse(clock.value) + row.value * 1000;
}
