// SPDX-License-Identifier: Apache-2.0
import { composeMime, decodeGmailRaw } from "./mime.js";
import { createMailbox, insertStoredMessage, nextId, nextTimestamp } from "./storage.js";
import type { ParsedGmailStateSeed } from "./seed.js";
import type { GmailTwinDatabase, SeedDraft, SeedMailbox, SeedMessage } from "./types.js";

export function seedMailbox(
  db: GmailTwinDatabase,
  mailbox: ParsedGmailStateSeed["primaryMailbox"]
): void {
  const clock = (db.prepare("SELECT value FROM gmail_config WHERE key = 'clock'").get() as { value: string }).value;
  const mailboxId = createMailbox(db, mailbox.email, mailbox.displayName, clock);
  const labelByName = new Map<string, string>();
  for (const label of mailbox.labels) {
    if (label.id) nextId(db, mailboxId, "label_counter", "Label");
    const labelId = label.id ?? nextId(db, mailboxId, "label_counter", "Label");
    db.prepare(
      "INSERT INTO labels(mailbox_id, id, name, type, text_color, background_color) VALUES (?, ?, ?, 'user', ?, ?)"
    ).run(mailboxId, labelId, label.name, label.color?.textColor ?? null, label.color?.backgroundColor ?? null);
    labelByName.set(label.name.toLowerCase(), labelId);
  }
  for (const message of mailbox.messages) {
    if (message.id) nextId(db, mailboxId, "message_counter", "msg");
    if (message.threadId) nextId(db, mailboxId, "thread_counter", "thread");
    const raw = seedRaw(db, mailbox, message, mailboxId);
    const labels = message.labels.map((label) => labelByName.get(label.toLowerCase()) ?? label);
    insertStoredMessage(db, mailboxId, raw, {
      id: message.id,
      threadId: message.threadId,
      labels,
      recordHistory: false,
      forceThreadId: message.threadId !== undefined,
    });
  }
  for (const draft of mailbox.drafts) {
    if (draft.id) nextId(db, mailboxId, "draft_counter", "draft");
    if (draft.threadId) nextId(db, mailboxId, "thread_counter", "thread");
    const raw = seedRaw(db, mailbox, draft, mailboxId);
    const message = insertStoredMessage(db, mailboxId, raw, {
      id: draft.id ? `${draft.id}_message` : undefined,
      threadId: draft.threadId,
      draft: true,
      recordHistory: false,
      forceThreadId: draft.threadId !== undefined,
    });
    const draftId = draft.id ?? nextId(db, mailboxId, "draft_counter", "draft");
    const date = new Date(message.internalDate).toISOString();
    db.prepare("INSERT INTO drafts(mailbox_id, id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(mailboxId, draftId, message.id, date, date);
  }
  seedSettings(db, mailboxId, mailbox);
}

function seedSettings(
  db: GmailTwinDatabase,
  mailboxId: number,
  mailbox: ParsedGmailStateSeed["primaryMailbox"]
): void {
  for (const sendAs of mailbox.sendAs) {
    db.prepare(
      `INSERT OR REPLACE INTO send_as(
        mailbox_id, email, display_name, reply_to_address, is_primary, is_default, verification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mailboxId,
      sendAs.sendAsEmail,
      sendAs.displayName,
      sendAs.replyToAddress ?? null,
      Number(sendAs.isPrimary),
      Number(sendAs.isDefault),
      sendAs.verificationStatus
    );
  }
  for (const forwarding of mailbox.forwardingAddresses) {
    db.prepare("INSERT INTO forwarding_addresses(mailbox_id, email, verification_status) VALUES (?, ?, ?)")
      .run(mailboxId, forwarding.forwardingEmail, forwarding.verificationStatus);
  }
  for (const filter of mailbox.filters) {
    if (filter.id) nextId(db, mailboxId, "filter_counter", "filter");
    const id = filter.id ?? nextId(db, mailboxId, "filter_counter", "filter");
    db.prepare("INSERT INTO filters(mailbox_id, id, criteria_json, action_json) VALUES (?, ?, ?, ?)")
      .run(mailboxId, id, JSON.stringify(filter.criteria), JSON.stringify(filter.action));
  }
}

function seedRaw(
  db: GmailTwinDatabase,
  mailbox: SeedMailbox,
  message: SeedMessage | SeedDraft,
  mailboxId: number
): Buffer {
  if (message.raw !== undefined) {
    return message.raw.includes("\n") ? Buffer.from(message.raw, "utf8") : decodeGmailRaw(message.raw);
  }
  const date = message.date ?? nextTimestamp(db, mailboxId);
  const id = message.messageId ?? `${nextId(db, mailboxId, "message_counter", "rfc")}@pome-twin.test`;
  return composeMime({
    from: message.from ?? mailbox.email,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    date,
    messageId: id,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments,
  });
}
