// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound, unsupported } from "./errors.js";
import { parseSearchQuery } from "./search.js";
import { addHistory, assertLabels, nextId, semanticMessage } from "./storage.js";
import type { GmailDomain } from "./domain.js";
import type { GmailTwinDatabase, SeedFilter, SemanticMessage } from "./types.js";

export type DraftResource = { id: string; message: SemanticMessage; updatedAt: string };
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
export type FilterResource = Required<Pick<SeedFilter, "criteria" | "action">> & { id: string };

export class GmailRestStore {
  constructor(
    private readonly db: GmailTwinDatabase,
    private readonly domain: GmailDomain
  ) {}

  profile(email: string): {
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
    historyId: string;
  } {
    const mailboxId = this.domain.mailboxId(email);
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS messagesTotal, COUNT(DISTINCT thread_id) AS threadsTotal
         FROM messages WHERE mailbox_id = ?`
      )
      .get(mailboxId) as { messagesTotal: number; threadsTotal: number };
    return { emailAddress: email, ...totals, historyId: this.currentHistoryId(mailboxId) };
  }

  currentHistoryIdFor(email: string): string {
    return this.currentHistoryId(this.domain.mailboxId(email));
  }

  latestMessageHistory(email: string, messageId: string): string {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare("SELECT MAX(id) AS id FROM history WHERE mailbox_id = ? AND message_id = ?")
      .get(mailboxId, messageId) as { id: number | null };
    return String(row.id ?? Number(this.currentHistoryId(mailboxId)));
  }

  latestThreadHistory(email: string, threadId: string): string {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare("SELECT MAX(id) AS id FROM history WHERE mailbox_id = ? AND thread_id = ?")
      .get(mailboxId, threadId) as { id: number | null };
    return String(row.id ?? Number(this.currentHistoryId(mailboxId)));
  }

  headers(email: string, messageId: string): Array<{ name: string; value: string }> {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare("SELECT headers_json FROM messages WHERE mailbox_id = ? AND id = ?")
      .get(mailboxId, messageId) as { headers_json: string } | undefined;
    if (!row) notFound("Message");
    return JSON.parse(row.headers_json) as Array<{ name: string; value: string }>;
  }

  attachment(email: string, messageId: string, attachmentId: string): { size: number; data: string } {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare("SELECT size, data FROM attachments WHERE mailbox_id = ? AND message_id = ? AND id = ?")
      .get(mailboxId, messageId, attachmentId) as { size: number; data: Uint8Array } | undefined;
    if (!row) notFound("Attachment");
    return { size: row.size, data: Buffer.from(row.data).toString("base64url") };
  }

  applyInternalDateSource(
    email: string,
    messageId: string,
    source: "receivedTime" | "dateHeader"
  ): SemanticMessage {
    const mailboxId = this.domain.mailboxId(email);
    if (source === "receivedTime") {
      const history = this.db
        .prepare(
          `SELECT created_at FROM history
           WHERE mailbox_id = ? AND message_id = ? AND event_type = 'messageAdded'
           ORDER BY id DESC LIMIT 1`
        )
        .get(mailboxId, messageId) as { created_at: string } | undefined;
      if (history) {
        this.db
          .prepare("UPDATE messages SET internal_date = ? WHERE mailbox_id = ? AND id = ?")
          .run(Date.parse(history.created_at), mailboxId, messageId);
      }
    }
    return semanticMessage(this.db, mailboxId, messageId);
  }

  drafts(email: string, query = "", includeTrash = false): DraftResource[] {
    const mailboxId = this.domain.mailboxId(email);
    const matching = query
      ? new Set(this.domain.searchMessages(email, query, { includeTrash }).map((message) => message.id))
      : null;
    const rows = this.db
      .prepare("SELECT id, message_id, updated_at FROM drafts WHERE mailbox_id = ? ORDER BY updated_at DESC, id DESC")
      .all(mailboxId) as Array<{ id: string; message_id: string; updated_at: string }>;
    return rows
      .filter((row) => !matching || matching.has(row.message_id))
      .map((row) => ({ id: row.id, message: semanticMessage(this.db, mailboxId, row.message_id), updatedAt: row.updated_at }));
  }

  draft(email: string, draftId: string): DraftResource {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare("SELECT id, message_id, updated_at FROM drafts WHERE mailbox_id = ? AND id = ?")
      .get(mailboxId, draftId) as { id: string; message_id: string; updated_at: string } | undefined;
    if (!row) notFound("Draft");
    return { id: row.id, message: semanticMessage(this.db, mailboxId, row.message_id), updatedAt: row.updated_at };
  }

  deleteMessage(email: string, messageId: string): void {
    const mailboxId = this.domain.mailboxId(email);
    this.db.transaction(() => {
      const message = semanticMessage(this.db, mailboxId, messageId);
      this.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, messageId);
      addHistory(this.db, mailboxId, messageId, message.threadId, "messageDeleted");
      this.removeEmptyThread(mailboxId, message.threadId);
    }).immediate();
  }

  batchDeleteMessages(email: string, messageIds: string[]): void {
    const mailboxId = this.domain.mailboxId(email);
    this.db.transaction(() => {
      for (const messageId of messageIds) {
        const exists = this.db
          .prepare("SELECT thread_id FROM messages WHERE mailbox_id = ? AND id = ?")
          .get(mailboxId, messageId) as { thread_id: string } | undefined;
        if (!exists) continue;
        this.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, messageId);
        addHistory(this.db, mailboxId, messageId, exists.thread_id, "messageDeleted");
        this.removeEmptyThread(mailboxId, exists.thread_id);
      }
    }).immediate();
  }

  deleteThread(email: string, threadId: string): void {
    const mailboxId = this.domain.mailboxId(email);
    this.db.transaction(() => {
      const thread = this.domain.getThread(email, threadId);
      this.db.prepare("DELETE FROM threads WHERE mailbox_id = ? AND id = ?").run(mailboxId, threadId);
      for (const message of thread.messages) addHistory(this.db, mailboxId, message.id, threadId, "messageDeleted");
    }).immediate();
  }

  labels(email: string): LabelResource[] {
    const mailboxId = this.domain.mailboxId(email);
    const rows = this.db
      .prepare("SELECT id FROM labels WHERE mailbox_id = ? ORDER BY CASE type WHEN 'system' THEN 0 ELSE 1 END, name COLLATE NOCASE, id")
      .all(mailboxId) as Array<{ id: string }>;
    return rows.map((row) => this.label(email, row.id));
  }

  label(email: string, labelId: string): LabelResource {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare(
        `SELECT id, name, type, text_color, background_color
         FROM labels WHERE mailbox_id = ? AND id = ?`
      )
      .get(mailboxId, labelId) as
      | { id: string; name: string; type: "system" | "user"; text_color: string | null; background_color: string | null }
      | undefined;
    if (!row) notFound("Label");
    const counts = this.db
      .prepare(
        `SELECT COUNT(DISTINCT ml.message_id) AS messagesTotal,
          COUNT(DISTINCT CASE WHEN unread.message_id IS NOT NULL THEN ml.message_id END) AS messagesUnread,
          COUNT(DISTINCT m.thread_id) AS threadsTotal,
          COUNT(DISTINCT CASE WHEN unread.message_id IS NOT NULL THEN m.thread_id END) AS threadsUnread
         FROM message_labels ml
         JOIN messages m ON m.mailbox_id = ml.mailbox_id AND m.id = ml.message_id
         LEFT JOIN message_labels unread ON unread.mailbox_id = ml.mailbox_id
           AND unread.message_id = ml.message_id AND unread.label_id = 'UNREAD'
         WHERE ml.mailbox_id = ? AND ml.label_id = ?`
      )
      .get(mailboxId, labelId) as {
      messagesTotal: number;
      messagesUnread: number;
      threadsTotal: number;
      threadsUnread: number;
    };
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      textColor: row.text_color,
      backgroundColor: row.background_color,
      ...counts,
    };
  }

  updateLabel(
    email: string,
    labelId: string,
    input: { name?: string; color?: { textColor?: string; backgroundColor?: string } },
    replace: boolean
  ): LabelResource {
    const mailboxId = this.domain.mailboxId(email);
    const current = this.label(email, labelId);
    if (current.type !== "user") invalidArgument("System labels cannot be modified");
    const name = replace ? input.name : input.name ?? current.name;
    if (!name?.trim()) invalidArgument("Label name is required");
    const textColor = input.color?.textColor ?? (replace ? null : current.textColor);
    const backgroundColor = input.color?.backgroundColor ?? (replace ? null : current.backgroundColor);
    try {
      this.db
        .prepare("UPDATE labels SET name = ?, text_color = ?, background_color = ? WHERE mailbox_id = ? AND id = ?")
        .run(name.trim(), textColor, backgroundColor, mailboxId, labelId);
    } catch {
      invalidArgument(`Label already exists: ${name}`);
    }
    return this.label(email, labelId);
  }

  deleteLabel(email: string, labelId: string): void {
    const mailboxId = this.domain.mailboxId(email);
    const label = this.label(email, labelId);
    if (label.type !== "user") invalidArgument("System labels cannot be deleted");
    this.db.prepare("DELETE FROM labels WHERE mailbox_id = ? AND id = ?").run(mailboxId, labelId);
  }

  filters(email: string): FilterResource[] {
    const mailboxId = this.domain.mailboxId(email);
    const rows = this.db
      .prepare("SELECT id, criteria_json, action_json FROM filters WHERE mailbox_id = ? ORDER BY id")
      .all(mailboxId) as Array<{ id: string; criteria_json: string; action_json: string }>;
    return rows.map(toFilter);
  }

  filter(email: string, filterId: string): FilterResource {
    const mailboxId = this.domain.mailboxId(email);
    const row = this.db
      .prepare("SELECT id, criteria_json, action_json FROM filters WHERE mailbox_id = ? AND id = ?")
      .get(mailboxId, filterId) as { id: string; criteria_json: string; action_json: string } | undefined;
    if (!row) notFound("Filter");
    return toFilter(row);
  }

  createFilter(email: string, criteria: SeedFilter["criteria"] = {}, action: SeedFilter["action"] = {}): FilterResource {
    if (action.forward) unsupported("Filter action.forward is not supported by the Gmail twin");
    const mailboxId = this.domain.mailboxId(email);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM filters WHERE mailbox_id = ?").get(mailboxId) as {
      count: number;
    };
    if (count.count >= 1000) invalidArgument("Filter limit exceeded");
    assertLabels(this.db, mailboxId, [...(action.addLabelIds ?? []), ...(action.removeLabelIds ?? [])]);
    if (criteria.query) parseSearchQuery(criteria.query);
    if (criteria.negatedQuery) parseSearchQuery(criteria.negatedQuery);
    const id = nextId(this.db, mailboxId, "filter_counter", "filter");
    this.db
      .prepare("INSERT INTO filters(mailbox_id, id, criteria_json, action_json) VALUES (?, ?, ?, ?)")
      .run(mailboxId, id, JSON.stringify(criteria), JSON.stringify(action));
    return { id, criteria, action };
  }

  deleteFilter(email: string, filterId: string): void {
    const mailboxId = this.domain.mailboxId(email);
    const result = this.db.prepare("DELETE FROM filters WHERE mailbox_id = ? AND id = ?").run(mailboxId, filterId);
    if (result.changes === 0) notFound("Filter");
  }

  forwardingAddresses(email: string): Array<{ forwardingEmail: string; verificationStatus: string }> {
    const mailboxId = this.domain.mailboxId(email);
    const rows = this.db
      .prepare("SELECT email, verification_status FROM forwarding_addresses WHERE mailbox_id = ? ORDER BY email COLLATE NOCASE")
      .all(mailboxId) as Array<{ email: string; verification_status: string }>;
    return rows.map((row) => ({ forwardingEmail: row.email, verificationStatus: row.verification_status }));
  }

  forwardingAddress(email: string, forwardingEmail: string): { forwardingEmail: string; verificationStatus: string } {
    const found = this.forwardingAddresses(email).find(
      (item) => item.forwardingEmail.toLowerCase() === forwardingEmail.toLowerCase()
    );
    if (!found) notFound("Forwarding address");
    return found;
  }

  sendAs(email: string): Array<Record<string, unknown>> {
    const mailboxId = this.domain.mailboxId(email);
    const rows = this.db
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

  sendAsAddress(email: string, sendAsEmail: string): Record<string, unknown> {
    const found = this.sendAs(email).find(
      (item) => String(item.sendAsEmail).toLowerCase() === sendAsEmail.toLowerCase()
    );
    if (!found) notFound("Send-as alias");
    return found;
  }

  private currentHistoryId(mailboxId: number): string {
    const row = this.db
      .prepare("SELECT history_counter FROM mailbox_counters WHERE mailbox_id = ?")
      .get(mailboxId) as { history_counter: number };
    return String(row.history_counter);
  }

  private removeEmptyThread(mailboxId: number, threadId: string): void {
    if (!this.db.prepare("SELECT 1 FROM messages WHERE mailbox_id = ? AND thread_id = ? LIMIT 1").get(mailboxId, threadId)) {
      this.db.prepare("DELETE FROM threads WHERE mailbox_id = ? AND id = ?").run(mailboxId, threadId);
    }
  }
}

function toFilter(row: { id: string; criteria_json: string; action_json: string }): FilterResource {
  return {
    id: row.id,
    criteria: JSON.parse(row.criteria_json) as NonNullable<SeedFilter["criteria"]>,
    action: JSON.parse(row.action_json) as NonNullable<SeedFilter["action"]>,
  };
}
