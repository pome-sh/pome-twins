// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound } from "./errors.js";
import { mimeSha256, normalizeSubject, parseMime } from "./mime.js";
import { stripHtmlTags } from "./search.js";
import type { GmailTwinDatabase, MessageRow, SemanticMessage } from "./types.js";

export const SYSTEM_LABELS = [
  ["INBOX", "INBOX"],
  ["SPAM", "SPAM"],
  ["TRASH", "TRASH"],
  ["UNREAD", "UNREAD"],
  ["STARRED", "STARRED"],
  ["IMPORTANT", "IMPORTANT"],
  ["SENT", "SENT"],
  ["DRAFT", "DRAFT"],
  ["CATEGORY_PERSONAL", "CATEGORY_PERSONAL"],
  ["CATEGORY_SOCIAL", "CATEGORY_SOCIAL"],
  ["CATEGORY_PROMOTIONS", "CATEGORY_PROMOTIONS"],
  ["CATEGORY_UPDATES", "CATEGORY_UPDATES"],
  ["CATEGORY_FORUMS", "CATEGORY_FORUMS"],
] as const;

type CounterName =
  | "message_counter"
  | "thread_counter"
  | "draft_counter"
  | "label_counter"
  | "attachment_counter"
  | "history_counter"
  | "filter_counter";

export function createMailbox(
  db: GmailTwinDatabase,
  email: string,
  displayName: string,
  createdAt: string
): number {
  const result = db
    .prepare("INSERT INTO mailboxes(email, display_name, created_at) VALUES (?, ?, ?)")
    .run(email, displayName, createdAt);
  const mailboxId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO mailbox_counters(mailbox_id) VALUES (?)").run(mailboxId);
  for (const [id, name] of SYSTEM_LABELS) {
    db.prepare(
      "INSERT INTO labels(mailbox_id, id, name, type, text_color, background_color) VALUES (?, ?, ?, 'system', NULL, NULL)"
    ).run(mailboxId, id, name);
  }
  db.prepare(
    `INSERT INTO send_as(
      mailbox_id, email, display_name, is_primary, is_default, verification_status
    ) VALUES (?, ?, ?, 1, 1, 'accepted')`
  ).run(mailboxId, email, displayName);
  return mailboxId;
}

export function nextId(db: GmailTwinDatabase, mailboxId: number, counter: CounterName, prefix: string): string {
  db.prepare(`UPDATE mailbox_counters SET ${counter} = ${counter} + 1 WHERE mailbox_id = ?`).run(mailboxId);
  const row = db.prepare(`SELECT ${counter} AS value FROM mailbox_counters WHERE mailbox_id = ?`).get(mailboxId) as {
    value: number;
  };
  return `${prefix}_${row.value.toString(16).padStart(16, "0")}`;
}

export function nextTimestamp(db: GmailTwinDatabase, mailboxId: number): string {
  db.prepare("UPDATE mailbox_counters SET logical_clock = logical_clock + 1 WHERE mailbox_id = ?").run(mailboxId);
  const row = db
    .prepare("SELECT logical_clock FROM mailbox_counters WHERE mailbox_id = ?")
    .get(mailboxId) as { logical_clock: number };
  const config = db.prepare("SELECT value FROM gmail_config WHERE key = 'clock'").get() as { value: string };
  return new Date(Date.parse(config.value) + row.logical_clock * 1000).toISOString();
}

export function addHistory(
  db: GmailTwinDatabase,
  mailboxId: number,
  messageId: string | null,
  threadId: string | null,
  eventType: string,
  labelIds: string[] = []
): string {
  const id = nextId(db, mailboxId, "history_counter", "history").slice("history_".length);
  const numeric = Number.parseInt(id, 16);
  const timestamp = nextTimestamp(db, mailboxId);
  db.prepare(
    `INSERT INTO history(mailbox_id, id, message_id, thread_id, event_type, label_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(mailboxId, numeric, messageId, threadId, eventType, JSON.stringify([...labelIds].sort()), timestamp);
  return String(numeric);
}

export function insertStoredMessage(
  db: GmailTwinDatabase,
  mailboxId: number,
  raw: Uint8Array,
  options: {
    id?: string;
    threadId?: string;
    labels?: string[];
    draft?: boolean;
    deliveredTo?: string;
    recordHistory?: boolean;
    forceThreadId?: boolean;
  } = {}
): SemanticMessage {
  const parsed = parseMime(raw);
  const messageId = options.id ?? nextId(db, mailboxId, "message_counter", "msg");
  const subjectKey = normalizeSubject(parsed.subject);
  const threadId =
    options.forceThreadId && options.threadId
      ? options.threadId
      : resolveThread(db, mailboxId, options.threadId, subjectKey, [
          ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
          ...parsed.references,
        ]);
  const date = parsed.date === new Date(0).toISOString() ? nextTimestamp(db, mailboxId) : parsed.date;
  const internalDate = Date.parse(date);
  const snippet = (parsed.text || stripHtmlTags(parsed.html)).replace(/\s+/g, " ").trim().slice(0, 200);
  const exists = db.prepare("SELECT 1 FROM threads WHERE mailbox_id = ? AND id = ?").get(mailboxId, threadId);
  if (!exists) {
    db.prepare("INSERT INTO threads(mailbox_id, id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      mailboxId,
      threadId,
      date,
      date
    );
  }
  db.prepare(
    `INSERT INTO messages(
      mailbox_id, id, thread_id, rfc_message_id, internal_date, sent_at,
      from_address, to_json, cc_json, bcc_json, delivered_to, subject,
      normalized_subject, snippet, text_body, html_body, headers_json, size_estimate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    mailboxId,
    messageId,
    threadId,
    parsed.messageId || `${messageId}@pome-twin.test`,
    internalDate,
    date,
    parsed.from,
    JSON.stringify(parsed.to),
    JSON.stringify(parsed.cc),
    JSON.stringify(parsed.bcc),
    options.deliveredTo ?? parsed.deliveredTo,
    parsed.subject,
    subjectKey,
    snippet,
    parsed.text,
    parsed.html,
    JSON.stringify(parsed.headers),
    raw.byteLength
  );
  db.prepare("INSERT INTO message_blobs(mailbox_id, message_id, raw, sha256, size) VALUES (?, ?, ?, ?, ?)").run(
    mailboxId,
    messageId,
    Buffer.from(raw),
    mimeSha256(raw),
    raw.byteLength
  );
  parsed.attachments.forEach((attachment, index) => {
    const attachmentId = nextId(db, mailboxId, "attachment_counter", "att");
    db.prepare(
      `INSERT INTO attachments(
        mailbox_id, message_id, id, part_index, filename, mime_type, disposition,
        content_id, sha256, size, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mailboxId,
      messageId,
      attachmentId,
      index,
      attachment.filename,
      attachment.mimeType,
      attachment.disposition,
      attachment.contentId ?? null,
      mimeSha256(attachment.data),
      attachment.data.byteLength,
      attachment.data
    );
  });
  const labels = options.draft ? ["DRAFT"] : [...new Set(options.labels ?? [])];
  assertLabels(db, mailboxId, labels);
  for (const label of labels) {
    db.prepare("INSERT INTO message_labels(mailbox_id, message_id, label_id) VALUES (?, ?, ?)").run(
      mailboxId,
      messageId,
      label
    );
  }
  db.prepare("UPDATE threads SET updated_at = ? WHERE mailbox_id = ? AND id = ?").run(date, mailboxId, threadId);
  if (options.recordHistory !== false) addHistory(db, mailboxId, messageId, threadId, "messageAdded", labels);
  return semanticMessage(db, mailboxId, messageId);
}

export function semanticMessage(db: GmailTwinDatabase, mailboxId: number, messageId: string): SemanticMessage {
  const row = db
    .prepare("SELECT * FROM messages WHERE mailbox_id = ? AND id = ?")
    .get(mailboxId, messageId) as MessageRow | undefined;
  if (!row) notFound("Message");
  const labels = db
    .prepare("SELECT label_id FROM message_labels WHERE mailbox_id = ? AND message_id = ? ORDER BY label_id")
    .all(mailboxId, messageId) as Array<{ label_id: string }>;
  const attachments = db
    .prepare(
      `SELECT id, filename, mime_type, disposition, content_id, sha256, size
       FROM attachments WHERE mailbox_id = ? AND message_id = ? ORDER BY part_index`
    )
    .all(mailboxId, messageId) as Array<{
    id: string;
    filename: string;
    mime_type: string;
    disposition: string;
    content_id: string | null;
    sha256: string;
    size: number;
  }>;
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
    labelIds: labels.map((label) => label.label_id),
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mime_type,
      disposition: attachment.disposition,
      contentId: attachment.content_id,
      sha256: attachment.sha256,
      size: attachment.size,
    })),
  };
}

export function rawMessage(db: GmailTwinDatabase, mailboxId: number, messageId: string): Buffer {
  const row = db
    .prepare("SELECT raw FROM message_blobs WHERE mailbox_id = ? AND message_id = ?")
    .get(mailboxId, messageId) as { raw: Uint8Array } | undefined;
  if (!row) notFound("Message");
  return Buffer.from(row.raw);
}

export function assertLabels(db: GmailTwinDatabase, mailboxId: number, labelIds: string[]): void {
  for (const labelId of labelIds) {
    if (!db.prepare("SELECT 1 FROM labels WHERE mailbox_id = ? AND id = ?").get(mailboxId, labelId)) {
      invalidArgument(`Invalid label: ${labelId}`);
    }
  }
}

function resolveThread(
  db: GmailTwinDatabase,
  mailboxId: number,
  requested: string | undefined,
  subject: string,
  references: string[]
): string {
  // Gmail REST honors an explicit owned threadId on send/insert/import/draft
  // even without In-Reply-To / References subject matching ("put in thread X").
  if (requested) {
    const owned = db.prepare("SELECT 1 FROM threads WHERE mailbox_id = ? AND id = ?").get(mailboxId, requested);
    if (owned) return requested;
  }
  const uniqueRefs = [...new Set(references.filter(Boolean))];
  const candidates = uniqueRefs.length
    ? (db
        .prepare(
          `SELECT thread_id, normalized_subject, rfc_message_id
           FROM messages
           WHERE mailbox_id = ? AND rfc_message_id IN (${uniqueRefs.map(() => "?").join(", ")})
           ORDER BY internal_date DESC`
        )
        .all(mailboxId, ...uniqueRefs) as Array<{
        thread_id: string;
        normalized_subject: string;
        rfc_message_id: string;
      }>)
    : [];
  const referenced = candidates.find((candidate) => candidate.normalized_subject === subject);
  if (referenced) return referenced.thread_id;
  return nextId(db, mailboxId, "thread_counter", "thread");
}
