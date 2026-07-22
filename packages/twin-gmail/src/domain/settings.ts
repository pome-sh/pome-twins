// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound } from "../errors.js";
import type { HistoryEvent } from "../types.js";
import type { GmailDomain } from "./gmail-domain.js";

export function profile(
  domain: GmailDomain,
  email: string
): {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
} {
  const mailboxId = domain.mailboxId(email);
  const totals = domain.db
    .prepare(
      `SELECT COUNT(*) AS messagesTotal, COUNT(DISTINCT thread_id) AS threadsTotal
       FROM messages WHERE mailbox_id = ?`
    )
    .get(mailboxId) as { messagesTotal: number; threadsTotal: number };
  return { emailAddress: email, ...totals, historyId: currentHistoryId(domain, mailboxId) };
}

export function currentHistoryIdFor(domain: GmailDomain, email: string): string {
  return currentHistoryId(domain, domain.mailboxId(email));
}

export function latestMessageHistory(domain: GmailDomain, email: string, messageId: string): string {
  const mailboxId = domain.mailboxId(email);
  const row = domain.db
    .prepare("SELECT MAX(id) AS id FROM history WHERE mailbox_id = ? AND message_id = ?")
    .get(mailboxId, messageId) as { id: number | null };
  return String(row.id ?? Number(currentHistoryId(domain, mailboxId)));
}

export function latestThreadHistory(domain: GmailDomain, email: string, threadId: string): string {
  const mailboxId = domain.mailboxId(email);
  const row = domain.db
    .prepare("SELECT MAX(id) AS id FROM history WHERE mailbox_id = ? AND thread_id = ?")
    .get(mailboxId, threadId) as { id: number | null };
  return String(row.id ?? Number(currentHistoryId(domain, mailboxId)));
}

export function listHistory(
  domain: GmailDomain,
  email: string,
  startHistoryId: string,
  options: { types?: string[] } = {}
): { history: HistoryEvent[]; historyId: string } {
  const mailboxId = domain.mailboxId(email);
  const start = Number(startHistoryId);
  if (!Number.isSafeInteger(start) || start < 0) invalidArgument("Invalid startHistoryId");
  const current = Number(currentHistoryId(domain, mailboxId));
  if (start > current) notFound("History");
  const rows = domain.db
    .prepare(
      `SELECT h.*, m.email AS mailbox_email
       FROM history h JOIN mailboxes m ON m.id = h.mailbox_id
       WHERE h.mailbox_id = ? AND h.id > ? ORDER BY h.id`
    )
    .all(mailboxId, start) as Array<{
    id: number;
    mailbox_email: string;
    message_id: string | null;
    thread_id: string | null;
    event_type: string;
    label_ids_json: string;
    created_at: string;
  }>;
  return {
    history: rows
      .filter((row) => !options.types?.length || options.types.includes(row.event_type))
      .map((row) => ({
        id: String(row.id),
        mailboxEmail: row.mailbox_email,
        messageId: row.message_id,
        threadId: row.thread_id,
        type: row.event_type,
        labelIds: JSON.parse(row.label_ids_json) as string[],
        timestamp: row.created_at,
      })),
    historyId: String(current),
  };
}

export function forwardingAddresses(
  domain: GmailDomain,
  email: string
): Array<{ forwardingEmail: string; verificationStatus: string }> {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare(
      "SELECT email, verification_status FROM forwarding_addresses WHERE mailbox_id = ? ORDER BY email COLLATE NOCASE"
    )
    .all(mailboxId) as Array<{ email: string; verification_status: string }>;
  return rows.map((row) => ({ forwardingEmail: row.email, verificationStatus: row.verification_status }));
}

export function forwardingAddress(
  domain: GmailDomain,
  email: string,
  forwardingEmail: string
): { forwardingEmail: string; verificationStatus: string } {
  const found = forwardingAddresses(domain, email).find(
    (item) => item.forwardingEmail.toLowerCase() === forwardingEmail.toLowerCase()
  );
  if (!found) notFound("Forwarding address");
  return found;
}

export function sendAs(domain: GmailDomain, email: string): Array<Record<string, unknown>> {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare(
      `SELECT email, display_name, reply_to_address, is_primary, is_default, verification_status
       FROM send_as WHERE mailbox_id = ? ORDER BY is_primary DESC, email COLLATE NOCASE`
    )
    .all(mailboxId) as Array<{
    email: string;
    display_name: string;
    reply_to_address: string | null;
    is_primary: number;
    is_default: number;
    verification_status: string;
  }>;
  return rows.map((row) => ({
    sendAsEmail: row.email,
    displayName: row.display_name,
    ...(row.reply_to_address ? { replyToAddress: row.reply_to_address } : {}),
    isPrimary: Boolean(row.is_primary),
    isDefault: Boolean(row.is_default),
    verificationStatus: row.verification_status,
    treatAsAlias: !row.is_primary,
    signature: "",
  }));
}

export function sendAsAddress(
  domain: GmailDomain,
  email: string,
  sendAsEmail: string
): Record<string, unknown> {
  const found = sendAs(domain, email).find(
    (item) => String(item.sendAsEmail).toLowerCase() === sendAsEmail.toLowerCase()
  );
  if (!found) notFound("Send-as alias");
  return found;
}

function currentHistoryId(domain: GmailDomain, mailboxId: number): string {
  const row = domain.db
    .prepare("SELECT history_counter FROM mailbox_counters WHERE mailbox_id = ?")
    .get(mailboxId) as { history_counter: number };
  return String(row.history_counter);
}
