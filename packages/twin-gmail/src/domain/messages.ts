// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound } from "../errors.js";
import { canonicalRaw, decodeGmailRaw, parseMime, stripBcc } from "../mime.js";
import { matchesSearch } from "../search-match.js";
import { SEARCH_MAILBOX_MESSAGE_BUDGET, validateSearchQuery } from "../search-parse.js";
import {
  addHistory,
  assertLabels,
  insertStoredMessage,
  rawMessage,
  semanticMessage,
} from "../storage.js";
import type { DeliveryMode, SemanticMessage } from "../types.js";
import { applyInboundFilters } from "./filters.js";
import { batchSearchDocuments, batchSemanticMessages, searchNow } from "./hydrate.js";
import type { GmailDomain } from "./gmail-domain.js";
import { compileSearchToSql } from "./search-sql.js";

export function getRaw(domain: GmailDomain, email: string, messageId: string): Buffer {
  return rawMessage(domain.db, domain.mailboxId(email), messageId);
}

export function getMessage(domain: GmailDomain, email: string, messageId: string): SemanticMessage {
  return semanticMessage(domain.db, domain.mailboxId(email), messageId);
}

export function getThread(
  domain: GmailDomain,
  email: string,
  threadId: string
): { id: string; labelIds: string[]; messages: SemanticMessage[] } {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare(
      "SELECT id FROM messages WHERE mailbox_id = ? AND thread_id = ? ORDER BY internal_date, id"
    )
    .all(mailboxId, threadId) as Array<{ id: string }>;
  if (!rows.length) notFound("Thread");
  const messages = batchSemanticMessages(
    domain.db,
    mailboxId,
    rows.map((row) => row.id)
  );
  return {
    id: threadId,
    labelIds: [...new Set(messages.flatMap((message) => message.labelIds))].sort(),
    messages,
  };
}

export function insertMessage(
  domain: GmailDomain,
  email: string,
  raw: Uint8Array | string,
  options: { threadId?: string; labels?: string[]; incoming?: boolean } = {}
): SemanticMessage {
  const mailboxId = domain.mailboxId(email);
  const bytes = acceptedRaw(raw);
  return domain.db.transaction(() => {
    const message = insertStoredMessage(domain.db, mailboxId, bytes, {
      threadId: options.threadId,
      labels: options.labels ?? (options.incoming ? ["INBOX"] : []),
      deliveredTo: options.incoming ? email : undefined,
    });
    if (options.incoming) applyInboundFilters(domain.db, mailboxId, message.id);
    return semanticMessage(domain.db, mailboxId, message.id);
  }).immediate();
}

export function sendMessage(
  domain: GmailDomain,
  email: string,
  raw: Uint8Array | string,
  options: { threadId?: string } = {}
): { sender: SemanticMessage; deliveries: Array<{ mailboxEmail: string; message: SemanticMessage }> } {
  const senderMailboxId = domain.mailboxId(email);
  const bytes = acceptedRaw(raw);
  const parsed = parseMime(bytes);
  assertAcceptedFrom(domain, senderMailboxId, parsed.from);
  return domain.db.transaction(() => {
    const recipientEmails = [...new Set([...parsed.to, ...parsed.cc, ...parsed.bcc].map((item) => item.toLowerCase()))];
    const selfDelivery = deliveryMode(domain) === "seeded-mailboxes" && recipientEmails.includes(email.toLowerCase());
    const sender = insertStoredMessage(domain.db, senderMailboxId, bytes, {
      threadId: options.threadId,
      labels: selfDelivery ? ["INBOX", "SENT"] : ["SENT"],
    });
    if (selfDelivery) applyInboundFilters(domain.db, senderMailboxId, sender.id);
    const deliveries: Array<{ mailboxEmail: string; message: SemanticMessage }> = [];
    if (deliveryMode(domain) === "seeded-mailboxes") {
      const visibleRaw = stripBcc(bytes);
      for (const recipient of recipientEmails) {
        if (recipient === email.toLowerCase()) continue;
        const mailbox = domain.db
          .prepare("SELECT id, email FROM mailboxes WHERE email = ? COLLATE NOCASE")
          .get(recipient) as { id: number; email: string } | undefined;
        if (!mailbox) continue;
        const copy = insertStoredMessage(domain.db, mailbox.id, visibleRaw, {
          labels: ["INBOX"],
          deliveredTo: mailbox.email,
        });
        applyInboundFilters(domain.db, mailbox.id, copy.id);
        deliveries.push({ mailboxEmail: mailbox.email, message: semanticMessage(domain.db, mailbox.id, copy.id) });
      }
    }
    return { sender: semanticMessage(domain.db, senderMailboxId, sender.id), deliveries };
  }).immediate();
}

export function modifyMessageLabels(
  domain: GmailDomain,
  email: string,
  messageId: string,
  add: string[] = [],
  remove: string[] = []
): SemanticMessage {
  const mailboxId = domain.mailboxId(email);
  return domain.db.transaction(() => {
    const before = semanticMessage(domain.db, mailboxId, messageId);
    if (before.labelIds.includes("DRAFT") && (add.some((id) => id !== "DRAFT") || remove.includes("DRAFT"))) {
      invalidArgument("Draft messages may only carry the DRAFT label");
    }
    if (!before.labelIds.includes("DRAFT") && add.includes("DRAFT")) {
      invalidArgument("The DRAFT label is managed by draft operations");
    }
    assertLabels(domain.db, mailboxId, [...add, ...remove]);
    // TRASH and SPAM are mutually exclusive (Gmail system labels).
    const addSet = new Set(add);
    const removeSet = new Set(remove);
    if (addSet.has("TRASH")) removeSet.add("SPAM");
    if (addSet.has("SPAM")) removeSet.add("TRASH");
    const actualRemove = [...removeSet].filter((label) => before.labelIds.includes(label));
    const actualAdd = [...addSet].filter((label) => !before.labelIds.includes(label));
    for (const label of actualRemove) {
      domain.db
        .prepare("DELETE FROM message_labels WHERE mailbox_id = ? AND message_id = ? AND label_id = ?")
        .run(mailboxId, messageId, label);
    }
    for (const label of actualAdd) {
      domain.db
        .prepare("INSERT OR IGNORE INTO message_labels(mailbox_id, message_id, label_id) VALUES (?, ?, ?)")
        .run(mailboxId, messageId, label);
    }
    if (actualAdd.length) addHistory(domain.db, mailboxId, messageId, before.threadId, "labelAdded", actualAdd);
    if (actualRemove.length) {
      addHistory(domain.db, mailboxId, messageId, before.threadId, "labelRemoved", actualRemove);
    }
    return semanticMessage(domain.db, mailboxId, messageId);
  }).immediate();
}

export function modifyThreadLabels(
  domain: GmailDomain,
  email: string,
  threadId: string,
  add: string[] = [],
  remove: string[] = []
): { id: string; labelIds: string[]; messages: SemanticMessage[] } {
  return domain.db.transaction(() => {
    const thread = getThread(domain, email, threadId);
    for (const message of thread.messages) modifyMessageLabels(domain, email, message.id, add, remove);
    return getThread(domain, email, threadId);
  }).immediate();
}

export function deleteMessage(domain: GmailDomain, email: string, messageId: string): void {
  const mailboxId = domain.mailboxId(email);
  domain.db.transaction(() => {
    const message = semanticMessage(domain.db, mailboxId, messageId);
    domain.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, messageId);
    addHistory(domain.db, mailboxId, messageId, message.threadId, "messageDeleted");
    removeEmptyThread(domain, mailboxId, message.threadId);
  }).immediate();
}

export function batchDeleteMessages(domain: GmailDomain, email: string, messageIds: string[]): void {
  const mailboxId = domain.mailboxId(email);
  domain.db.transaction(() => {
    for (const messageId of messageIds) {
      const exists = domain.db
        .prepare("SELECT thread_id FROM messages WHERE mailbox_id = ? AND id = ?")
        .get(mailboxId, messageId) as { thread_id: string } | undefined;
      if (!exists) continue;
      domain.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, messageId);
      addHistory(domain.db, mailboxId, messageId, exists.thread_id, "messageDeleted");
      removeEmptyThread(domain, mailboxId, exists.thread_id);
    }
  }).immediate();
}

export function deleteThread(domain: GmailDomain, email: string, threadId: string): void {
  const mailboxId = domain.mailboxId(email);
  domain.db.transaction(() => {
    const thread = getThread(domain, email, threadId);
    domain.db.prepare("DELETE FROM threads WHERE mailbox_id = ? AND id = ?").run(mailboxId, threadId);
    for (const message of thread.messages) {
      addHistory(domain.db, mailboxId, message.id, threadId, "messageDeleted");
    }
  }).immediate();
}

export function headers(
  domain: GmailDomain,
  email: string,
  messageId: string
): Array<{ name: string; value: string }> {
  const mailboxId = domain.mailboxId(email);
  const row = domain.db
    .prepare("SELECT headers_json FROM messages WHERE mailbox_id = ? AND id = ?")
    .get(mailboxId, messageId) as { headers_json: string } | undefined;
  if (!row) notFound("Message");
  return JSON.parse(row.headers_json) as Array<{ name: string; value: string }>;
}

export function attachment(
  domain: GmailDomain,
  email: string,
  messageId: string,
  attachmentId: string
): { size: number; data: string } {
  const mailboxId = domain.mailboxId(email);
  const row = domain.db
    .prepare("SELECT size, data FROM attachments WHERE mailbox_id = ? AND message_id = ? AND id = ?")
    .get(mailboxId, messageId, attachmentId) as { size: number; data: Uint8Array } | undefined;
  if (!row) notFound("Attachment");
  return { size: row.size, data: Buffer.from(row.data).toString("base64url") };
}

export function applyInternalDateSource(
  domain: GmailDomain,
  email: string,
  messageId: string,
  source: "receivedTime" | "dateHeader"
): SemanticMessage {
  const mailboxId = domain.mailboxId(email);
  if (source === "receivedTime") {
    const history = domain.db
      .prepare(
        `SELECT created_at FROM history
         WHERE mailbox_id = ? AND message_id = ? AND event_type = 'messageAdded'
         ORDER BY id DESC LIMIT 1`
      )
      .get(mailboxId, messageId) as { created_at: string } | undefined;
    if (history) {
      domain.db
        .prepare("UPDATE messages SET internal_date = ? WHERE mailbox_id = ? AND id = ?")
        .run(Date.parse(history.created_at), mailboxId, messageId);
    }
  }
  return semanticMessage(domain.db, mailboxId, messageId);
}

export function searchMessages(
  domain: GmailDomain,
  email: string,
  query = "",
  options: { includeTrash?: boolean } = {}
): SemanticMessage[] {
  const mailboxId = domain.mailboxId(email);
  const ast = validateSearchQuery(query);
  const explicitAnywhere = /\bin:(anywhere|trash|spam|draft)\b/i.test(query);
  const plan = compileSearchToSql(ast, {
    includeTrash: options.includeTrash,
    explicitAnywhere,
  });

  let candidateIds: string[];
  let sqlExact = false;
  if (plan) {
    const where = plan.clauses.length ? `AND ${plan.clauses.join(" AND ")}` : "";
    candidateIds = (
      domain.db
        .prepare(
          `SELECT id FROM messages
           WHERE mailbox_id = ? ${where}
           ORDER BY internal_date DESC, id DESC`
        )
        .all(mailboxId, ...plan.params) as Array<{ id: string }>
    ).map((row) => row.id);
    sqlExact = plan.exact;
  } else {
    const messageCount = (
      domain.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?").get(mailboxId) as {
        count: number;
      }
    ).count;
    if (messageCount > SEARCH_MAILBOX_MESSAGE_BUDGET) {
      invalidArgument(
        `Mailbox exceeds in-memory search budget (${SEARCH_MAILBOX_MESSAGE_BUDGET} messages); reduce mailbox size or wait for SQL-backed search`
      );
    }
    candidateIds = (
      domain.db
        .prepare("SELECT id FROM messages WHERE mailbox_id = ? ORDER BY internal_date DESC, id DESC")
        .all(mailboxId) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  // Enforce the mailbox search budget for both the JS-filter path and the SQL
  // prefilter path — SQL exact matches can still return huge result sets.
  if (candidateIds.length > SEARCH_MAILBOX_MESSAGE_BUDGET) {
    invalidArgument(
      `Mailbox exceeds in-memory search budget (${SEARCH_MAILBOX_MESSAGE_BUDGET} messages); reduce mailbox size or wait for SQL-backed search`
    );
  }

  const messages = batchSemanticMessages(domain.db, mailboxId, candidateIds);
  if (sqlExact) return messages;

  const now = searchNow(domain.db);
  const documents = batchSearchDocuments(domain.db, mailboxId, messages);
  return messages.filter((message, index) => {
    if (!explicitAnywhere && !options.includeTrash && message.labelIds.some((id) => ["TRASH", "SPAM", "DRAFT"].includes(id))) {
      return false;
    }
    return matchesSearch(ast, documents[index]!, now);
  });
}

export function searchThreads(
  domain: GmailDomain,
  email: string,
  query = "",
  options: { includeTrash?: boolean } = {}
): ReturnType<typeof getThread>[] {
  const matches = searchMessages(domain, email, query, options);
  return [...new Set(matches.map((message) => message.threadId))].map((threadId) =>
    getThread(domain, email, threadId)
  );
}

export function removeEmptyThread(domain: GmailDomain, mailboxId: number, threadId: string): void {
  const member = domain.db
    .prepare("SELECT 1 FROM messages WHERE mailbox_id = ? AND thread_id = ? LIMIT 1")
    .get(mailboxId, threadId);
  if (!member) {
    domain.db.prepare("DELETE FROM threads WHERE mailbox_id = ? AND id = ?").run(mailboxId, threadId);
  }
}

export function acceptedRaw(raw: Uint8Array | string): Buffer {
  return typeof raw === "string"
    ? raw.includes("\n")
      ? canonicalRaw(raw)
      : decodeGmailRaw(raw)
    : canonicalRaw(raw);
}

function deliveryMode(domain: GmailDomain): DeliveryMode {
  const row = domain.db
    .prepare("SELECT value FROM gmail_config WHERE key = 'delivery_mode'")
    .get() as { value: DeliveryMode };
  return row.value;
}

function assertAcceptedFrom(domain: GmailDomain, mailboxId: number, from: string): void {
  if (!from) invalidArgument("From header is required");
  const accepted = domain.db
    .prepare(
      `SELECT 1 FROM send_as
       WHERE mailbox_id = ? AND email = ? COLLATE NOCASE AND verification_status = 'accepted'`
    )
    .get(mailboxId, from);
  if (!accepted) invalidArgument("From address is not an accepted send-as identity");
}
