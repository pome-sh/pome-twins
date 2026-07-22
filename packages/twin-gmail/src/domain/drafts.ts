// SPDX-License-Identifier: Apache-2.0
import { notFound } from "../errors.js";
import { composeMime } from "../mime.js";
import { addHistory, insertStoredMessage, nextId, nextTimestamp, rawMessage, semanticMessage } from "../storage.js";
import type { DraftRow, SeedAttachment, SemanticMessage } from "../types.js";
import type { GmailDomain } from "./gmail-domain.js";
import { acceptedRaw, removeEmptyThread, searchMessages, sendMessage } from "./messages.js";

export type DraftResource = { id: string; message: SemanticMessage; updatedAt: string };

export function createDraft(
  domain: GmailDomain,
  email: string,
  raw: Uint8Array | string,
  options: { threadId?: string } = {}
): { id: string; message: SemanticMessage } {
  const mailboxId = domain.mailboxId(email);
  const bytes = acceptedRaw(raw);
  return domain.db.transaction(() => {
    const message = insertStoredMessage(domain.db, mailboxId, bytes, {
      threadId: options.threadId,
      draft: true,
    });
    const draftId = nextId(domain.db, mailboxId, "draft_counter", "draft");
    const now = nextTimestamp(domain.db, mailboxId);
    domain.db
      .prepare("INSERT INTO drafts(mailbox_id, id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(mailboxId, draftId, message.id, now, now);
    addHistory(domain.db, mailboxId, message.id, message.threadId, "draftCreated", ["DRAFT"]);
    return { id: draftId, message };
  }).immediate();
}

export function createComposedDraft(
  domain: GmailDomain,
  email: string,
  input: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    replyToMessageId?: string;
    attachments?: SeedAttachment[];
  }
): { id: string; message: SemanticMessage } {
  const mailboxId = domain.mailboxId(email);
  return domain.db.transaction(() => {
    const reply = input.replyToMessageId
      ? semanticMessage(domain.db, mailboxId, input.replyToMessageId)
      : undefined;
    const raw = composeMime({
      from: email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject ?? (reply ? `Re: ${reply.subject}` : ""),
      text: reply ? [input.text ?? "", reply.text].filter(Boolean).join("\r\n\r\n") : input.text,
      html: reply ? [input.html ?? "", reply.html].filter(Boolean).join("<br><br>") : input.html,
      date: nextTimestamp(domain.db, mailboxId),
      messageId: `${nextId(domain.db, mailboxId, "message_counter", "rfc")}@pome-twin.test`,
      inReplyTo: reply?.rfcMessageId,
      references: reply ? [reply.rfcMessageId] : undefined,
      attachments: input.attachments,
    });
    return createDraft(domain, email, raw, { threadId: reply?.threadId });
  }).immediate();
}

export function listDrafts(
  domain: GmailDomain,
  email: string,
  query = ""
): Array<{ id: string; message: SemanticMessage }> {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare(
      `SELECT d.id, d.message_id
       FROM drafts d JOIN messages m ON m.mailbox_id = d.mailbox_id AND m.id = d.message_id
       WHERE d.mailbox_id = ? ORDER BY d.updated_at DESC, d.id DESC`
    )
    .all(mailboxId) as Array<{ id: string; message_id: string }>;
  const matchingIds = query
    ? new Set(
        searchMessages(domain, email, `in:draft ${query}`, { includeTrash: true }).map((message) => message.id)
      )
    : undefined;
  return rows
    .filter((row) => matchingIds?.has(row.message_id) ?? true)
    .map((row) => ({ id: row.id, message: semanticMessage(domain.db, mailboxId, row.message_id) }));
}

export function drafts(
  domain: GmailDomain,
  email: string,
  query = "",
  includeTrash = false
): DraftResource[] {
  const mailboxId = domain.mailboxId(email);
  const matching = query
    ? new Set(searchMessages(domain, email, query, { includeTrash }).map((message) => message.id))
    : null;
  const rows = domain.db
    .prepare("SELECT id, message_id, updated_at FROM drafts WHERE mailbox_id = ? ORDER BY updated_at DESC, id DESC")
    .all(mailboxId) as Array<{ id: string; message_id: string; updated_at: string }>;
  return rows
    .filter((row) => !matching || matching.has(row.message_id))
    .map((row) => ({
      id: row.id,
      message: semanticMessage(domain.db, mailboxId, row.message_id),
      updatedAt: row.updated_at,
    }));
}

export function draft(domain: GmailDomain, email: string, draftId: string): DraftResource {
  const mailboxId = domain.mailboxId(email);
  const row = domain.db
    .prepare("SELECT id, message_id, updated_at FROM drafts WHERE mailbox_id = ? AND id = ?")
    .get(mailboxId, draftId) as { id: string; message_id: string; updated_at: string } | undefined;
  if (!row) notFound("Draft");
  return { id: row.id, message: semanticMessage(domain.db, mailboxId, row.message_id), updatedAt: row.updated_at };
}

export function updateDraft(
  domain: GmailDomain,
  email: string,
  draftId: string,
  raw: Uint8Array | string,
  options: { threadId?: string } = {}
): { id: string; message: SemanticMessage } {
  const mailboxId = domain.mailboxId(email);
  const bytes = acceptedRaw(raw);
  return domain.db.transaction(() => {
    const draftRow = requireDraft(domain, mailboxId, draftId);
    const old = semanticMessage(domain.db, mailboxId, draftRow.message_id);
    const replacement = insertStoredMessage(domain.db, mailboxId, bytes, {
      threadId: options.threadId,
      draft: true,
    });
    const now = nextTimestamp(domain.db, mailboxId);
    domain.db
      .prepare("UPDATE drafts SET message_id = ?, updated_at = ? WHERE mailbox_id = ? AND id = ?")
      .run(replacement.id, now, mailboxId, draftId);
    domain.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, draftRow.message_id);
    removeEmptyThread(domain, mailboxId, old.threadId);
    addHistory(domain.db, mailboxId, draftRow.message_id, old.threadId, "draftReplaced");
    return { id: draftId, message: replacement };
  }).immediate();
}

export function sendDraft(
  domain: GmailDomain,
  email: string,
  draftId: string
): ReturnType<typeof sendMessage> {
  const mailboxId = domain.mailboxId(email);
  return domain.db.transaction(() => {
    const draftRow = requireDraft(domain, mailboxId, draftId);
    const raw = rawMessage(domain.db, mailboxId, draftRow.message_id);
    const old = semanticMessage(domain.db, mailboxId, draftRow.message_id);
    domain.db.prepare("DELETE FROM drafts WHERE mailbox_id = ? AND id = ?").run(mailboxId, draftId);
    domain.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, draftRow.message_id);
    // Keep the draft's thread row even when it becomes empty — send reuses
    // old.threadId (Gmail draft send identity). removeEmptyThread here would
    // drop solo-draft threads and force a new thread id on send.
    addHistory(domain.db, mailboxId, draftRow.message_id, old.threadId, "draftSent");
    return sendMessage(domain, email, raw, { threadId: old.threadId });
  }).immediate();
}

export function deleteDraft(domain: GmailDomain, email: string, draftId: string): void {
  const mailboxId = domain.mailboxId(email);
  domain.db.transaction(() => {
    const draftRow = requireDraft(domain, mailboxId, draftId);
    const message = semanticMessage(domain.db, mailboxId, draftRow.message_id);
    domain.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, draftRow.message_id);
    removeEmptyThread(domain, mailboxId, message.threadId);
    addHistory(domain.db, mailboxId, draftRow.message_id, message.threadId, "draftDeleted");
  }).immediate();
}

function requireDraft(domain: GmailDomain, mailboxId: number, draftId: string): DraftRow {
  const row = domain.db
    .prepare("SELECT * FROM drafts WHERE mailbox_id = ? AND id = ?")
    .get(mailboxId, draftId) as DraftRow | undefined;
  if (!row) notFound("Draft");
  return row;
}
